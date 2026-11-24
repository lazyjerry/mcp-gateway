// 記住同意頁的勾選，存在閘道自己的 D1。撤銷授權不影響這裡，擁有者在設定頁清除。
// 讀寫失敗只留 log：同意頁退回服務的預設，授權照常完成
import type { ScopeDefinition } from './services';
import { sourceOf } from './throttle';

export interface ConsentChoice {
  clientId: string;
  clientName: string;
  offered: string[];
  granted: string[];
  ip: string;
  userAgent: string;
  /** ISO 時間 */
  updatedAt: string;
}

interface Row {
  client_id: string;
  client_name: string;
  offered: string;
  granted: string;
  ip: string;
  user_agent: string;
  updated_at: string;
}

const MAX_USER_AGENT = 200;
const COLUMNS = 'client_id, client_name, offered, granted, ip, user_agent, updated_at';

function split(value: string): string[] {
  return value.split(' ').filter(Boolean);
}

function fromRow(row: Row): ConsentChoice {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    offered: split(row.offered),
    granted: split(row.granted),
    ip: row.ip,
    userAgent: row.user_agent,
    updatedAt: row.updated_at,
  };
}

/** 按下同意時記下這次列出與勾選的範圍；同一個 client 覆寫上一次 */
export async function rememberChoice(
  db: D1Database,
  request: Request,
  client: { clientId: string; clientName: string },
  offered: Iterable<string>,
  granted: string[],
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO consent_choices (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, offered = excluded.offered, granted = excluded.granted,
           ip = excluded.ip, user_agent = excluded.user_agent, updated_at = excluded.updated_at`,
      )
      .bind(
        client.clientId,
        client.clientName,
        [...offered].join(' '),
        granted.join(' '),
        sourceOf(request),
        (request.headers.get('User-Agent') ?? '').slice(0, MAX_USER_AGENT),
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    console.error(JSON.stringify({ message: 'consent choice write failed', error: String(err) }));
  }
}

export async function findChoice(db: D1Database, clientId: string): Promise<ConsentChoice | null> {
  try {
    const row = await db.prepare(`SELECT ${COLUMNS} FROM consent_choices WHERE client_id = ?`).bind(clientId).first<Row>();
    return row ? fromRow(row) : null;
  } catch (err) {
    console.error(JSON.stringify({ message: 'consent choice read failed', error: String(err) }));
    return null;
  }
}

export async function listChoices(db: D1Database): Promise<ConsentChoice[]> {
  try {
    const { results } = await db.prepare(`SELECT ${COLUMNS} FROM consent_choices ORDER BY updated_at DESC`).all<Row>();
    return results.map(fromRow);
  } catch (err) {
    console.error(JSON.stringify({ message: 'consent choice read failed', error: String(err) }));
    return [];
  }
}

export async function forgetChoice(db: D1Database, clientId: string): Promise<void> {
  await db.prepare('DELETE FROM consent_choices WHERE client_id = ?').bind(clientId).run();
}

/** 同意頁要預先勾選的範圍：上次列過的照上次勾選，沒列過的（或沒有紀錄）照服務的預設 */
export function presetScopes(scopes: readonly ScopeDefinition[], choice: ConsentChoice | null): Set<string> {
  const offered = new Set(choice?.offered);
  const granted = new Set(choice?.granted);
  return new Set(scopes.filter((s) => (offered.has(s.scope) ? granted.has(s.scope) : s.defaultChecked)).map((s) => s.scope));
}

/** 授權之後才新增、同意頁還沒列過的範圍；有這些範圍就要重新授權。沒有紀錄時拿授權的範圍來比 */
export function unseenScopes(all: Iterable<string>, choice: ConsentChoice | null, granted: readonly string[]): string[] {
  const seen = new Set(choice ? choice.offered : granted);
  return [...all].filter((s) => !seen.has(s));
}
