// 帶 access token 送 MCP JSON-RPC 到 /mcp；回應可能是 JSON 或 SSE，兩種都解析成 JSON-RPC 訊息
import { gw } from './oauth';

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

let nextId = 1;

export async function mcp(token: string, method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
  const res = await gw('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`/mcp 回 ${res.status}：${text}`);
  const json = (res.headers.get('Content-Type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).pop()!
    : text;
  return JSON.parse(json) as RpcResponse;
}

export async function listTools(token: string): Promise<any[]> {
  return (await mcp(token, 'tools/list')).result.tools;
}

/** 呼叫 tool；回傳 MCP 的 tool 結果（isError、content），以及 content 第一段文字解析出的 JSON（解析不了就是 null） */
export async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await mcp(token, 'tools/call', { name, arguments: args });
  const result = response.result as { isError?: boolean; content?: { type: string; text: string }[] } | undefined;
  const text = result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 錯誤訊息是純文字
  }
  return { response, result, text, data };
}
