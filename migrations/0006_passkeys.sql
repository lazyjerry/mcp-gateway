-- Passkey（WebAuthn）登入：擁有者在設定頁新增的憑證。Passkey 綁 hostname，workers.dev 與自訂網域要各自新增
CREATE TABLE passkeys (
  -- credential ID（base64url）
  id TEXT PRIMARY KEY,
  -- COSE 公鑰（base64url）
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  -- JSON 陣列
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  -- 1：會同步到其他裝置（例如 iCloud 鑰匙圈）
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- WebAuthn challenge：只能兌換一次，5 分鐘內有效
CREATE TABLE passkey_challenges (
  challenge TEXT PRIMARY KEY,
  -- register／login
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 擁有者的 WebAuthn user ID：第一次新增 Passkey 時產生的隨機值，之後固定
CREATE TABLE passkey_user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL
);
