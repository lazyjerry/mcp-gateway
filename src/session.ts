// 閘道自己的登入 Session：只用在授權頁與設定頁，/mcp 只認 OAuth access token
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

const COOKIE = '__Host-gateway_session';
const PREFIX = 'gateway-session:';
const TTL_SECONDS = 12 * 60 * 60;

export interface Session {
  id: string;
  /** 綁在 Session 上的 CSRF token，同意頁與設定頁的表單都要帶 */
  csrf: string;
}

const encoder = new TextEncoder();

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 先各自雜湊成等長再比較，長度不同也不會提早結束 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

export async function createSession<E extends { Bindings: Env }>(c: Context<E>): Promise<void> {
  const session: Session = { id: randomToken(), csrf: randomToken() };
  await c.env.OAUTH_KV.put(PREFIX + session.id, JSON.stringify(session), { expirationTtl: TTL_SECONDS });
  setCookie(c, COOKIE, session.id, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: TTL_SECONDS });
}

export async function readSession<E extends { Bindings: Env }>(c: Context<E>): Promise<Session | null> {
  const id = getCookie(c, COOKIE);
  if (!id) return null;
  return c.env.OAUTH_KV.get<Session>(PREFIX + id, 'json');
}

export async function destroySession<E extends { Bindings: Env }>(c: Context<E>): Promise<void> {
  const id = getCookie(c, COOKIE);
  if (id) await c.env.OAUTH_KV.delete(PREFIX + id);
  deleteCookie(c, COOKIE, { path: '/', secure: true });
}
