// 稽核紀錄：每次 tool 呼叫一筆，存在閘道自己的 D1。不記參數與回傳內容
export const RETENTION_DAYS = 30;

export type AuditStatus = 'ok' | 'forbidden' | 'throttled' | 'error';

export interface AuditEntry {
  clientId: string;
  tool: string;
  status: AuditStatus;
  /** 呼叫開始的時間（毫秒），也用來算處理時間 */
  startedAt: number;
}

export interface AuditLog {
  id: number;
  created_at: string;
  client_id: string;
  tool: string;
  status: AuditStatus;
  duration_ms: number;
}

/** 寫入一筆，順便刪掉超過保留天數的紀錄 */
export async function recordCall(db: D1Database, entry: AuditEntry): Promise<void> {
  const now = Date.now();
  const since = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
  await db.batch([
    db.prepare('INSERT INTO audit_logs (created_at, client_id, tool, status, duration_ms) VALUES (?, ?, ?, ?, ?)')
      .bind(new Date(entry.startedAt).toISOString(), entry.clientId, entry.tool, entry.status, Math.max(0, now - entry.startedAt)),
    db.prepare('DELETE FROM audit_logs WHERE created_at < ?').bind(since),
  ]);
}

export async function listRecent(db: D1Database, limit = 200): Promise<AuditLog[]> {
  const { results } = await db
    .prepare('SELECT id, created_at, client_id, tool, status, duration_ms FROM audit_logs ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<AuditLog>();
  return results;
}
