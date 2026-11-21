# MCP 閘道

獨立網域的 Cloudflare Worker：對 AI client 提供 MCP（`/mcp`），負責 OAuth 授權與使用者本人的登入，再呼叫各個自建服務。閘道不保存任何服務的資料，這個 repo 也不含任何實際服務的資訊：服務清單來自 secret `SERVICES`，每個服務的 tool 與授權範圍來自它的 `describe()`，執行時呼叫它的 `call()`。

## 設計依據

服務端的契約與串接步驟在 `README.dev.md`，架構與使用在 `README.md`。實作偏離這兩份時回頭更新。

實際串接了哪些服務、它們的 repo 與設計文件位置只記在本機（`CLAUDE.local.md`、`docs/working-notes-skill/`），不進版控。

## 結構

各檔案的職責見 `README.md`〈專案結構〉。

讀 `SERVICES`、呼叫服務、檢查回傳形狀與名稱前綴都在 `src/services/index.ts`。範圍判斷一律經 `src/permissions.ts`，`tools/list` 與 `tools/call` 不各寫一套。

## 規則

- **職責**：閘道只做 MCP、OAuth、登入。其他功能放到各自的服務。
- **不暴露服務**：進版控的檔案（程式、測試、設定、文件、commit 訊息）不出現實際服務的名稱、Worker 名稱、binding、tool、範圍與路徑；範例一律用 `notes`。服務綁定只寫在 `wrangler.jsonc`，本機要一起跑的服務只寫在 `.dev.services`，兩個檔與 `CLAUDE.local.md` 都不進版控，repo 裡的設定範例是 `wrangler.example.jsonc`。
- **不寫服務專屬的程式**：閘道對所有服務一視同仁。某個服務才需要的行為（回應的提醒文字、錯誤訊息的轉換、參數規則）放在該服務的 `describe()` 與 `call()`，不加進閘道。
- **連線方式**：同一個 Cloudflare 帳號的服務用服務綁定 + `WorkerEntrypoint` RPC。其他服務規劃用 HTTPS + HMAC，每個服務一把金鑰，目前沒有實作。
- **命名**：服務名稱是 binding 名稱的小寫。tool 是 `<服務>_<動作>`，授權範圍是 `<服務>:read`／`<服務>:write`，會花 AI 額度或連外的操作另開 `<服務>:<動作>`（例如 `<服務>:fetch`），金鑰是 `SVC_<服務>_KEY`。閘道丟掉不是該服務名稱開頭的 tool 與範圍，這個檢查不能放寬。
- **權限檢查兩次**：`tools/list` 依 token 的範圍過濾，`tools/call` 執行前再檢查一次。`readOnlyHint`、`destructiveHint`、`openWorldHint` 由服務標；沒標 `readOnlyHint` 的 tool 套用頻率限制。
- **RPC 契約**：`describe()` 與 `call()` 的形狀以 `src/services/index.ts` 的 schema 為準，說明在 `README.dev.md`〈服務端的契約〉。改形狀照「閘道先新舊都接受 → 服務改用新的 → 閘道移除舊的」的順序，每一步各自部署。
- **不信任服務的回傳**：`describe()` 與 `call()` 的結果都先過 schema，形狀不對就不採用。
- **錯誤**：可預期的結果（找不到、重複）由服務以 `ok: false` 加說明文字表達；回給 client 的錯誤只有說明文字，不含堆疊與內部路徑。
- **機密**：密碼、金鑰與 `SERVICES` 用 `wrangler secret put` 保存，本機放 `.dev.vars`。設定檔、程式碼、文件、log 一律只寫變數名稱。
- **稽核紀錄**：記 OAuth client、tool、結果狀態、處理時間，請求內容不入紀錄。
- **帳號與授權事件**：登入、登出、同意、拒絕、撤銷各記一筆（`src/events.ts`），記來源 IP 與 User-Agent，不記密碼、token、授權碼。
- **通知信**：寄件與收件地址只放 `MAIL_FROM`、`MAIL_TO`，不寫進設定檔與程式碼。哪些事件即時寄、哪些進每日統計信，由 `src/mailer.ts` 的 `INSTANT_EVENTS` 與 `DIGEST_EVENTS` 決定；會被外人大量觸發的事件不即時寄。
- **驗證**：`npm test` 與 `npm run typecheck` 都要通過；改功能先寫會紅的測試，測試從公開的 HTTP 介面（OAuth 流程、`/mcp`、設定頁）進入。服務接 `test/fixtures/services.js` 的範例服務，它是真的 auxiliary worker、經服務綁定走 RPC；不把 `src/services/index.ts` 換成假的。改動授權流程或 tool 的處理後，再用 MCP Inspector 接實際的服務走一次授權，確認沒授權的範圍在 `tools/list` 看不到、直接 `tools/call` 也會被拒絕。

## 指令

開發、型別檢查、測試的指令以 `package.json` 的 `scripts` 為準；部署步驟見 `README.md`〈部署〉。`npm test` 與 `npm run typecheck` 讀 `wrangler.example.jsonc`，不需要本機設定；`npm run dev` 與部署才需要 `wrangler.jsonc`。
