// 機密：不在 wrangler.jsonc 宣告，wrangler types 不會產生。本機放 .dev.vars，部署用 wrangler secret put
interface GatewaySecrets {
  /** 閘道登入密碼；未設定時授權流程回 503 */
  GATEWAY_PASS?: string;
  /** 通知信的寄件地址；與 MAIL_TO 任一個沒設定就不寄信 */
  MAIL_FROM?: string;
  /** 通知信的收件地址，多個以逗號分隔 */
  MAIL_TO?: string;
  /** 串接的服務：服務綁定的 binding 名稱，多個以逗號分隔；沒設定就沒有任何 tool */
  SERVICES?: string;
}

interface Env extends GatewaySecrets {}

declare namespace Cloudflare {
  interface Env extends GatewaySecrets {}
}
