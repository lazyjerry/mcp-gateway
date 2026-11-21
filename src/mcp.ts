// MCP server（OAuthProvider 的 apiHandler）：只有帶有效 access token 的 /mcp 請求會到這裡。
// 無狀態：每個請求依 token 的範圍組一個新的 McpServer，不需要 Durable Objects
import type { OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { recordCall, type AuditStatus } from './audit';
import { canUse, missingScopes } from './permissions';
import { callService, loadServices, toolsOf, type ToolDefinition } from './services';
import { TOOL_LIMIT, takeToolSlot } from './throttle';

/** OAuthProvider 在 completeAuthorization 時存進 token 的 props */
export interface GrantProps {
  scopes: string[];
}

interface CallInfo {
  env: Env;
  clientId: string;
  scopes: string[];
  /** 這個請求當下各服務宣告的 tool */
  tools: ToolDefinition[];
  waitUntil(promise: Promise<unknown>): void;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError } : { content: [{ type: 'text', text }] };
}

function forbidden(missing: string[]): ToolResult {
  return textResult(`這個 client 沒有 ${missing.join('、')} 的授權範圍，無法執行。`, true);
}

/** 還在頻率限制的間隔內：沒有執行，請 client 排隊 */
function throttled(): ToolResult {
  const seconds = Math.ceil(TOOL_LIMIT.intervalMs / 1000);
  return textResult(`同一個 client ${seconds} 秒內只能執行一次寫入動作，這次沒有執行。請排隊：等 ${seconds} 秒後再送，一次只送一個 tool 呼叫。`, true);
}

/** 稽核紀錄在背景寫入，不擋 tool 回應；寫入失敗只留 log */
function audit(call: CallInfo, tool: string, status: AuditStatus, startedAt: number) {
  call.waitUntil(
    recordCall(call.env.DB, { clientId: call.clientId, tool, status, startedAt }).catch((err) =>
      console.error(JSON.stringify({ message: 'audit failed', tool, error: String(err) })),
    ),
  );
}

async function execute(tool: ToolDefinition, args: unknown, call: CallInfo): Promise<ToolResult> {
  const startedAt = Date.now();
  const result = await runTool(tool, args, call);
  audit(call, tool.name, result.status, startedAt);
  return result.result;
}

async function runTool(tool: ToolDefinition, args: unknown, call: CallInfo): Promise<{ status: AuditStatus; result: ToolResult }> {
  const missing = missingScopes(tool, call.scopes);
  if (missing.length) return { status: 'forbidden', result: forbidden(missing) };
  try {
    // 只限制會改資料的 tool（沒標 readOnlyHint）；範圍檢查通過才佔名額，被範圍擋下的呼叫不算
    if (!tool.annotations.readOnlyHint && !(await takeToolSlot(call.env.DB, call.clientId))) return { status: 'throttled', result: throttled() };
    const outcome = await callService(call.env, tool, args, { client: call.clientId });
    return outcome.ok
      ? { status: 'ok', result: textResult(JSON.stringify(outcome.data)) }
      : { status: 'error', result: textResult(outcome.message, true) };
  } catch (err) {
    // 回給 client 的錯誤只有說明文字，不含堆疊與內部路徑
    console.error(JSON.stringify({ message: 'tool failed', tool: tool.name, error: String(err) }));
    return { status: 'error', result: textResult('服務暫時無法處理這個請求，請稍後再試。', true) };
  }
}

export function buildServer(call: CallInfo): McpServer {
  const server = new McpServer({ name: 'mcp-gateway', version: '0.1.0' });
  for (const tool of call.tools) {
    if (!canUse(tool, call.scopes)) continue;
    server.registerTool(
      tool.name,
      // 參數先在這裡依服務宣告的 JSON Schema 驗一次，不合法的不會佔頻率限制的名額；服務自己還會再驗
      { title: tool.title, description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema), annotations: tool.annotations },
      (args: unknown) => execute(tool, args, call),
    );
  }
  return server;
}

interface RpcMessage {
  id?: unknown;
  method?: string;
  params?: { name?: unknown };
}

/** 這則訊息如果是呼叫已知、但這個 token 沒有範圍的 tool，回傳那個 tool */
function deniedTool(message: RpcMessage | null, call: CallInfo): ToolDefinition | null {
  if (message?.method !== 'tools/call' || typeof message.params?.name !== 'string') return null;
  const name = message.params.name;
  const tool = call.tools.find((t) => t.name === name);
  return tool && !canUse(tool, call.scopes) ? tool : null;
}

/** tools/call 執行前的第二次檢查：沒列出的 tool 不會註冊，直接呼叫也在這裡以 tool 錯誤結果回絕並留下紀錄 */
async function rejectUnlisted(request: Request, call: CallInfo): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  let body: RpcMessage | RpcMessage[] | null;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  // 批次請求：被擋的每一則都記 forbidden，回應交給 MCP server（沒註冊的 tool 會得到協定錯誤，同樣不執行）
  if (Array.isArray(body)) {
    for (const message of body) {
      const tool = deniedTool(message, call);
      if (tool) audit(call, tool.name, 'forbidden', Date.now());
    }
    return null;
  }
  const tool = deniedTool(body, call);
  if (!tool) return null;
  audit(call, tool.name, 'forbidden', Date.now());
  return Response.json({ jsonrpc: '2.0', id: body?.id ?? null, result: forbidden(missingScopes(tool, call.scopes)) });
}

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // OAuthProvider 驗過 token 後才呼叫這裡：props 是同意時存的範圍，auth 是 token 本身的資訊
    const { auth, props } = ctx as OAuthResourceContext<GrantProps>;
    const tools = toolsOf(await loadServices(env));
    const call: CallInfo = { env, clientId: auth?.clientId ?? '', scopes: props?.scopes ?? [], tools, waitUntil: (p) => ctx.waitUntil(p) };
    const rejected = await rejectUnlisted(request, call);
    if (rejected) return rejected;
    return createMcpHandler(() => buildServer(call), { route: '/mcp' })(request, env, ctx);
  },
};
