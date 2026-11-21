-- 記住同意頁的勾選：每個 client 一列，按下同意時覆寫。重新授權時，上次列過的範圍照上次勾選，沒列過的照服務的預設。
-- 撤銷授權不刪這張表，也不設保留期限；擁有者在設定頁清除。記最近一次同意的來源 IP 與 User-Agent，不記 token、授權碼
CREATE TABLE consent_choices (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL DEFAULT '',
  -- 同意頁列出的所有範圍，以空白分隔
  offered TEXT NOT NULL,
  -- 勾選的範圍，以空白分隔
  granted TEXT NOT NULL,
  -- 來源 IP（CF-Connecting-IP）
  ip TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
