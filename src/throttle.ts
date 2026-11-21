// 登入失敗節流：每個來源在一個時間窗內最多驗 MAX_ATTEMPTS 次密碼。
// 計數放 D1（強一致），先佔一次名額再驗密碼，同時送出的請求也算得到
export const MAX_ATTEMPTS = 5;
export const WINDOW_SECONDS = 15 * 60;

/** Cloudflare 設定的來源 IP，client 無法偽造；本機沒有這個標頭時共用一個來源 */
export function sourceOf(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'local';
}

/** 記一次嘗試，回傳這是時間窗內的第幾次；超過 MAX_ATTEMPTS 就不該再驗密碼。順便清掉其他來源過期的計數 */
export async function countAttempt(db: D1Database, source: string): Promise<number> {
  const now = Date.now();
  const expired = now - WINDOW_SECONDS * 1000;
  const [attempt] = await db.batch<{ count: number }>([
    db.prepare(
      `INSERT INTO login_attempts (source, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(source) DO UPDATE SET
         count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
       RETURNING count`,
    ).bind(source, now, expired),
    db.prepare('DELETE FROM login_attempts WHERE window_start <= ?').bind(expired),
  ]);
  return attempt.results[0].count;
}

export async function clearAttempts(db: D1Database, source: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE source = ?').bind(source).run();
}

// tool 呼叫的頻率限制：同一個 OAuth client 兩次寫入類 tool 的執行之間至少隔 intervalMs（毫秒），0 是不限制；讀取類不限。
// 包成物件是為了讓測試能改；改完重新部署才生效
export const TOOL_LIMIT = { intervalMs: 3000 };

/**
 * 佔用一次執行名額，回傳是否放行。
 * 條件式寫入：同時進來的呼叫只有一個改得到，不會都放行
 */
export async function takeToolSlot(db: D1Database, clientId: string): Promise<boolean> {
  const interval = TOOL_LIMIT.intervalMs;
  if (interval <= 0) return true;
  const now = Date.now();
  // last_at > 現在：時鐘曾經往回調，照樣放行，免得卡到那個時間點
  const { meta } = await db
    .prepare(
      `INSERT INTO tool_slots (client_id, last_at) VALUES (?1, ?2)
       ON CONFLICT (client_id) DO UPDATE SET last_at = excluded.last_at
       WHERE tool_slots.last_at <= ?3 OR tool_slots.last_at > ?2`,
    )
    .bind(clientId, now, now - interval)
    .run();
  return meta.changes === 1;
}
