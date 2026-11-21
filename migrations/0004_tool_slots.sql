-- tool 呼叫的頻率限制：每個 OAuth client 上一次放行的時間（毫秒）。間隔寫在 src/throttle.ts
CREATE TABLE tool_slots (
  client_id TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);
