// 通知信：帳號與授權事件寄給擁有者。走 Email Routing 的 send_email binding：只能寄給帳號裡已驗證的收件地址，寄件地址需在啟用 Email Routing 的網域下。
// MAIL_FROM、MAIL_TO 任一個沒設定就不寄。版面比照自家其他服務的通知信
import type { AuthEventClient, AuthEventType } from './events';
import { EVENT_LABELS } from './ui';

/** 發生當下就寄的事件；登入被擋由呼叫端決定（每個來源每個時間窗一封） */
export const INSTANT_EVENTS: ReadonlySet<AuthEventType> = new Set(['login', 'grant_approved', 'grant_revoked']);

/** 不即時寄、每天彙整一封的事件 */
export const DIGEST_EVENTS = ['login_failed', 'logout', 'grant_denied'] as const satisfies readonly AuthEventType[];

const DIGEST_HOURS = 24;
const DIGEST_SOURCES = 10;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

interface MailContent {
  subject: string;
  /** 右上角的狀態字 */
  status: string;
  /** 狀態燈與卡片頂邊的顏色 */
  warn: boolean;
  intro: string;
  heading: string;
  /** 標籤與值，一列一筆 */
  rows: [label: string, value: string][];
  /** 卡片最後的說明 */
  hint: string;
}

function compose(c: MailContent) {
  const text = [c.intro, '', c.heading, ...c.rows.map(([label, value]) => `${label}：${value}`), '', c.hint].join('\n');

  // 信件不吃 class 與 CSS 變數，樣式一律 inline、用 table 排版；配色與字體跟自家其他服務的通知信一致
  const e = escapeHtml;
  const font = `Arial,'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif`;
  const mono = `font-family:Menlo,Consolas,monospace`;
  const accent = c.warn ? '#ae7418' : '#ed735f';
  const row = ([label, value]: [string, string]) =>
    `<tr><td style="padding:10px 14px 10px 0;border-bottom:1px solid #d4d2cc;color:#707486;${mono};font-size:11px;font-weight:800;letter-spacing:.08em;white-space:nowrap;vertical-align:top">${e(label)}</td><td style="padding:10px 0;border-bottom:1px solid #d4d2cc;color:#171e34;font-size:14px;line-height:1.6;overflow-wrap:anywhere;word-break:break-word">${e(value) || '—'}</td></tr>`;

  const html = `<!doctype html>
<html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f3ed;color:#171e34;font-family:${font}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(c.intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f3ed"><tr><td align="center" style="padding:28px 16px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td style="padding:0 0 14px;border-bottom:1px solid #d4d2cc">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="color:#171e34;font-size:14px;font-weight:800;letter-spacing:.1em"><span style="display:inline-block;width:30px;height:30px;margin-right:10px;color:#ffffff;background:#171e34;${mono};font-size:15px;line-height:30px;text-align:center;vertical-align:middle">M</span>MCP 閘道</td>
    <td align="right" style="color:#707486;${mono};font-size:10px;font-weight:700;letter-spacing:.12em"><span style="display:inline-block;width:8px;height:8px;margin-right:6px;background:${c.warn ? '#ae7418' : '#398a70'};border-radius:50%"></span>${e(c.status)}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:24px 0 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fffefa;border:1px solid #d4d2cc;border-top:7px solid ${accent};box-shadow:7px 7px 0 rgba(23,30,52,.12)"><tr><td style="padding:28px">
    <p style="margin:0 0 22px;color:#707486;font-size:14px;line-height:1.6">${e(c.intro)}</p>
    <p style="margin:0 0 10px;color:${accent};${mono};font-size:11px;font-weight:800;letter-spacing:.22em">EVENT · 事件</p>
    <h1 style="margin:0 0 20px;color:#171e34;font-size:28px;font-weight:900;line-height:1.3;letter-spacing:-.02em;overflow-wrap:anywhere">${e(c.heading)}</h1>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-top:1px solid #d4d2cc">${c.rows.map(row).join('')}</table>
    <p style="margin:0;padding:10px 12px;color:#555a6d;background:#faf6ea;border-left:3px solid #ae7418;font-size:13px;line-height:1.6">${e(c.hint)}</p>
  </td></tr></table>
</td></tr>
<tr><td style="padding:36px 0 0"><div style="padding:18px 0 0;border-top:2px solid #171e34;color:#707486;${mono};font-size:10px;line-height:1.7;letter-spacing:.08em">MCP 閘道 · CLOUDFLARE WORKERS · OAUTH 2.1<br>你的信箱是 MCP 閘道的通知信收件地址，所以收到這封信。</div></td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject: c.subject.slice(0, 200), text, html };
}

/** 逐一寄給每個收件地址，某個地址失敗不影響其他人；失敗只留 log，不往外丟 */
async function deliver(env: Env, content: MailContent): Promise<void> {
  const from = env.MAIL_FROM?.trim();
  const recipients = (env.MAIL_TO ?? '').split(',').map((to) => to.trim()).filter(Boolean);
  if (!from || !recipients.length) return;
  const message = compose(content);
  await Promise.all(
    recipients.map(async (to) => {
      try {
        await env.EMAIL.send({ from: { email: from, name: 'MCP 閘道' }, to, ...message });
      } catch (err) {
        // 收件地址不入 log
        console.error(JSON.stringify({ message: 'mail failed', subject: content.subject, code: (err as { code?: string }).code, error: String(err) }));
      }
    }),
  );
}

export interface EventMail {
  event: AuthEventType;
  at: Date;
  ip: string;
  userAgent: string;
  client?: AuthEventClient;
}

export function sendEventMail(env: Env, mail: EventMail): Promise<void> {
  const label = EVENT_LABELS[mail.event].text;
  const warn = mail.event === 'login_blocked';
  const rows: [string, string][] = [['時間', mail.at.toISOString()]];
  if (mail.client) {
    rows.push(['client', mail.client.clientName || mail.client.clientId], ['client id', mail.client.clientId]);
    if (mail.client.scopes) rows.push(['範圍', mail.client.scopes.join(' ')]);
  }
  rows.push(['來源 IP', mail.ip], ['User-Agent', mail.userAgent]);
  return deliver(env, {
    subject: `MCP 閘道：${label}`,
    status: warn ? 'ALERT' : 'ACCOUNT EVENT',
    warn,
    intro: warn ? 'MCP 閘道擋下了密碼錯誤次數過多的登入。' : 'MCP 閘道有一筆帳號或授權的操作。',
    heading: label,
    rows,
    hint: warn
      ? '同一個來源在時間窗內只通知這一次。不是你本人的話，可以考慮更換閘道密碼。'
      : '不是你本人的操作時，請到設定頁撤銷不認得的 client，並更換閘道密碼。',
  });
}

/** 過去 24 小時的登入失敗、登出、拒絕授權彙整成一封；沒有資料就不寄 */
export async function sendDigestMail(env: Env, now: Date): Promise<void> {
  if (!env.MAIL_FROM || !env.MAIL_TO) return;
  const since = new Date(now.getTime() - DIGEST_HOURS * 3_600_000).toISOString();
  const marks = DIGEST_EVENTS.map(() => '?').join(', ');
  const [counts, sources] = await env.DB.batch<{ name: string; count: number }>([
    env.DB.prepare(`SELECT event AS name, COUNT(*) AS count FROM auth_events WHERE created_at >= ? AND event IN (${marks}) GROUP BY event`).bind(since, ...DIGEST_EVENTS),
    env.DB.prepare(
      `SELECT ip AS name, COUNT(*) AS count FROM auth_events WHERE created_at >= ? AND event = 'login_failed' GROUP BY ip ORDER BY count DESC, ip LIMIT ?`,
    ).bind(since, DIGEST_SOURCES),
  ]);
  const byEvent = new Map(counts.results.map((r) => [r.name, r.count]));
  if (!byEvent.size) return;
  const rows: [string, string][] = DIGEST_EVENTS.map((event) => [EVENT_LABELS[event].text, String(byEvent.get(event) ?? 0)]);
  for (const source of sources.results) rows.push([`登入失敗來源 ${source.name}`, String(source.count)]);
  await deliver(env, {
    subject: 'MCP 閘道：每日統計',
    status: 'DAILY DIGEST',
    warn: false,
    intro: `MCP 閘道過去 ${DIGEST_HOURS} 小時沒有即時通知的帳號操作。`,
    heading: '每日統計',
    rows,
    hint: '這封信只在有資料的日子寄出。逐筆紀錄在設定頁的「紀錄」，保留 30 天。',
  });
}
