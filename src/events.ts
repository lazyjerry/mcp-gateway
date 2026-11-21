// 帳號與授權事件：擁有者在閘道上的操作（登入、登出、同意、拒絕、撤銷）各記一筆，存在閘道自己的 D1。
// 記來源 IP 與 User-Agent，不記密碼、token、授權碼
import { RETENTION_DAYS } from './audit';
import { sourceOf } from './throttle';

export type AuthEventType = 'login' | 'login_failed' | 'login_blocked' | 'logout' | 'grant_approved' | 'grant_denied' | 'grant_revoked';

/** 授權事件才有的欄位 */
export interface AuthEventClient {
  clientId: string;
  clientName: string;
  scopes?: string[];
}

export interface AuthEvent {
  id: number;
  created_at: string;
  event: AuthEventType;
  ip: string;
  user_agent: string;
  client_id: string;
  client_name: string;
  scopes: string;
}

const MAX_USER_AGENT = 200;

/** 寫入一筆，順便刪掉超過保留天數的紀錄。寫入失敗只留 log，不讓登入或授權跟著失敗 */
export async function recordEvent(db: D1Database, request: Request, event: AuthEventType, client?: AuthEventClient): Promise<void> {
  const now = Date.now();
  const since = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
  try {
    await db.batch([
      db.prepare('INSERT INTO auth_events (created_at, event, ip, user_agent, client_id, client_name, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(
          new Date(now).toISOString(),
          event,
          sourceOf(request),
          (request.headers.get('User-Agent') ?? '').slice(0, MAX_USER_AGENT),
          client?.clientId ?? '',
          client?.clientName ?? '',
          client?.scopes?.join(' ') ?? '',
        ),
      db.prepare('DELETE FROM auth_events WHERE created_at < ?').bind(since),
    ]);
  } catch (err) {
    console.error(JSON.stringify({ message: 'event log failed', event, error: String(err) }));
  }
}

export async function listRecentEvents(db: D1Database, limit = 200): Promise<AuthEvent[]> {
  const { results } = await db
    .prepare('SELECT id, created_at, event, ip, user_agent, client_id, client_name, scopes FROM auth_events ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<AuthEvent>();
  return results;
}
