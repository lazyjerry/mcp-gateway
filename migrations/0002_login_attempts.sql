-- 登入失敗節流：每個來源在一個時間窗內試了幾次密碼。登入成功就刪掉，過期的在下一次寫入時清掉
CREATE TABLE login_attempts (
  -- 來源 IP（CF-Connecting-IP）
  source TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  -- 這個時間窗第一次嘗試的時間（毫秒）
  window_start INTEGER NOT NULL
);
