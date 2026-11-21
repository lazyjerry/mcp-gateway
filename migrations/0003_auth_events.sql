-- 帳號與授權事件：登入、登出、同意、拒絕、撤銷各一筆。記來源 IP 與 User-Agent，不記密碼、token、授權碼；保留 30 天，寫入時清掉過期的
CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  -- login／login_failed／login_blocked／logout／grant_approved／grant_denied／grant_revoked
  event TEXT NOT NULL,
  -- 來源 IP（CF-Connecting-IP）
  ip TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  -- 以下三欄只有授權事件有值
  client_id TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  -- 以空白分隔；只有 grant_approved 有值
  scopes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_auth_events_created ON auth_events (created_at);
