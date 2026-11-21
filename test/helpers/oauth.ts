// 扮演 MCP client 與瀏覽器走完整個 OAuth 流程：動態註冊 → 登入 → 同意 → 換 token。只走公開的 HTTP 介面，不直接寫 KV
import { exports } from 'cloudflare:workers';

export const ORIGIN = 'http://localhost';
export const REDIRECT_URI = 'http://localhost/callback';
export const GATEWAY_PASS = 'test-gateway-pass';

/** 直接呼叫 default export 不會自動帶 Host（真實請求一定有），MCP handler 會因此拒絕，所以補上 */
export function gw(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Host', new URL(ORIGIN).host);
  return exports.default.fetch(ORIGIN + path, { redirect: 'manual', ...init, headers });
}

export function form(fields: Record<string, string | string[]>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) body.append(key, v);
  return body;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export async function registerClient(name = '測試 client'): Promise<string> {
  const res = await gw('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
  });
  if (res.status !== 201) throw new Error(`註冊失敗：${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export function authorizePath(clientId: string, challenge: string, state = 'state-1'): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `/authorize?${query}`;
}

/** 以密碼登入閘道，回傳 Cookie 標頭值；失敗回 null */
export async function login(password = GATEWAY_PASS, next = '/settings'): Promise<string | null> {
  const res = await gw('/login', { method: 'POST', body: form({ password, next }) });
  const cookie = res.headers.get('Set-Cookie');
  return res.status === 302 && cookie ? cookie.split(';')[0] : null;
}

export function csrfOf(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (!match) throw new Error('頁面沒有 CSRF token');
  return match[1];
}

/** 同意頁送出；scopes 是勾選的範圍 */
export async function consent(path: string, cookie: string, fields: Record<string, string | string[]>): Promise<Response> {
  return gw(path, { method: 'POST', headers: { Cookie: cookie }, body: form(fields) });
}

export async function exchangeCode(clientId: string, code: string, verifier: string): Promise<Response> {
  return gw('/token', {
    method: 'POST',
    body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
  });
}

export interface Grant {
  clientId: string;
  token: string;
  cookie: string;
}

/** 一行拿到指定範圍的 access token */
export async function authorize(scopes: string[], clientName?: string): Promise<Grant> {
  const clientId = await registerClient(clientName);
  const { verifier, challenge } = await pkce();
  const path = authorizePath(clientId, challenge);
  const cookie = await login(GATEWAY_PASS, path);
  if (!cookie) throw new Error('登入失敗');
  const page = await (await gw(path, { headers: { Cookie: cookie } })).text();
  const res = await consent(path, cookie, { csrf: csrfOf(page), action: 'approve', scope: scopes });
  const location = res.headers.get('Location');
  const code = location ? new URL(location).searchParams.get('code') : null;
  if (!code) throw new Error(`同意後沒有拿到 code：${res.status}`);
  const token = await exchangeCode(clientId, code, verifier);
  const { access_token } = (await token.json()) as { access_token: string };
  return { clientId, token: access_token, cookie };
}
