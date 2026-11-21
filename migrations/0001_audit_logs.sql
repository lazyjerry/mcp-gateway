-- MCP tool 呼叫的稽核紀錄。只記 client、tool、結果狀態、處理時間，不記參數與回傳內容；保留 30 天，寫入時清掉過期的
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  client_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  -- ok／forbidden／error
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_audit_logs_created ON audit_logs (created_at);
