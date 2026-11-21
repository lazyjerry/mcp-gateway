// 串接的服務：閘道不寫死任何服務。secret SERVICES 列出服務綁定的 binding 名稱，
// 每個服務以 describe() 自述它的 tool 與授權範圍，執行時呼叫它的 call()。服務端的契約見 README.dev.md
import { z } from 'zod';

/** 服務端 WorkerEntrypoint 要提供的兩個方法 */
export interface ServiceRpc {
  describe(): Promise<unknown>;
  call(tool: string, args: unknown, caller: Caller): Promise<unknown>;
}

/** 呼叫者：OAuth client，傳給服務寫進它自己的紀錄 */
export interface Caller {
  client: string;
}

/** 可預期的結果（找不到、重複）用 ok: false 加說明文字表達，回給 client 成為 tool 錯誤結果 */
export type ToolOutcome = { ok: true; data: unknown } | { ok: false; message: string };

const scopeSchema = z.object({
  scope: z.string().regex(/^[a-z0-9_]+:[a-z0-9_-]+$/).max(64),
  label: z.string().min(1).max(60),
  description: z.string().max(300),
  defaultChecked: z.boolean(),
});

const toolSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/).max(64),
  title: z.string().min(1).max(100),
  description: z.string().max(2000),
  inputSchema: z.looseObject({ type: z.literal('object') }),
  annotations: z.object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }),
  scopes: z.array(z.string()),
});

const manifestSchema = z.object({ label: z.string().min(1).max(60), scopes: z.array(scopeSchema), tools: z.array(toolSchema) });

const outcomeSchema = z.union([z.object({ ok: z.literal(true), data: z.unknown() }), z.object({ ok: z.literal(false), message: z.string() })]);

export type ScopeDefinition = z.infer<typeof scopeSchema>;

export interface ToolDefinition extends z.infer<typeof toolSchema> {
  /** 這個 tool 所屬服務的 binding 名稱 */
  binding: string;
}

export interface ServiceDefinition {
  name: string;
  label: string;
  scopes: ScopeDefinition[];
  tools: ToolDefinition[];
}

/** SERVICES 裡合法的 binding 名稱：大寫開頭的大寫英數與底線。服務名稱是它的小寫 */
function bindingNames(env: Env): string[] {
  const names = (env.SERVICES ?? '').split(',').map((name) => name.trim());
  return [...new Set(names)].filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
}

function stub(env: Env, binding: string): ServiceRpc | undefined {
  return (env as unknown as Record<string, ServiceRpc | undefined>)[binding];
}

function warn(message: string, detail: Record<string, unknown>) {
  console.error(JSON.stringify({ message, ...detail }));
}

/**
 * 問一個服務有哪些 tool 與範圍。服務只能宣告自己名稱開頭的範圍（<服務>:）與 tool（<服務>_），
 * tool 用到的範圍也要是它自己宣告過的、至少一個；不符合的丟掉並留 log，免得一個服務冒用別的服務的權限
 */
async function describeService(env: Env, binding: string): Promise<ServiceDefinition | null> {
  const name = binding.toLowerCase();
  const service = stub(env, binding);
  if (!service) {
    warn('service binding missing', { binding });
    return null;
  }
  const manifest = manifestSchema.safeParse(await service.describe());
  if (!manifest.success) {
    warn('service manifest invalid', { binding });
    return null;
  }
  const scopes = manifest.data.scopes.filter((s) => s.scope.startsWith(`${name}:`));
  const declared = new Set(scopes.map((s) => s.scope));
  const tools = manifest.data.tools
    .filter((t) => t.name.startsWith(`${name}_`) && t.scopes.length > 0 && t.scopes.every((scope) => declared.has(scope)))
    .map((t) => ({ ...t, binding }));
  const dropped = manifest.data.scopes.length - scopes.length + manifest.data.tools.length - tools.length;
  if (dropped) warn('service manifest entries dropped', { binding, dropped });
  return { name, label: manifest.data.label, scopes, tools };
}

// describe() 的結果在同一個 isolate 留 CACHE_MS：每個請求都要用到範圍清單，不必每次都問。
// 只在全部服務都答得出來時才留，服務暫時壞掉的結果不會被記住
const CACHE_MS = 60_000;
let cached: { key: string; at: number; services: ServiceDefinition[] } | null = null;

export async function loadServices(env: Env): Promise<ServiceDefinition[]> {
  const bindings = bindingNames(env);
  const key = bindings.join(',');
  const now = Date.now();
  if (cached && cached.key === key && now >= cached.at && now - cached.at < CACHE_MS) return cached.services;
  const results = await Promise.all(
    bindings.map((binding) =>
      describeService(env, binding).catch((err) => {
        warn('service describe failed', { binding, error: String(err) });
        return null;
      }),
    ),
  );
  const services = results.filter((s) => s !== null);
  cached = services.length === bindings.length ? { key, at: now, services } : null;
  return services;
}

export function scopesOf(services: readonly ServiceDefinition[]): Set<string> {
  return new Set(services.flatMap((s) => s.scopes.map((d) => d.scope)));
}

export function toolsOf(services: readonly ServiceDefinition[]): ToolDefinition[] {
  return services.flatMap((s) => s.tools);
}

/** 執行 tool：轉給所屬服務的 call()。回傳的形狀不對視為服務出錯 */
export async function callService(env: Env, tool: ToolDefinition, args: unknown, caller: Caller): Promise<ToolOutcome> {
  const service = stub(env, tool.binding);
  if (!service) throw new Error(`service binding missing: ${tool.binding}`);
  return outcomeSchema.parse(await service.call(tool.name, args, caller));
}
