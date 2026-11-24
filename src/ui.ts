// 登入、同意、設定、紀錄與提示訊息的頁面。外觀來自 Jerry UI 元件庫（public/jerry-ui.css，整檔不改），
// 這裡的標記照元件規格寫：P1 工具頁骨架、L2 頁首、H1 大標、C1／C2 卡片、F1／F2／F4 表單、F10 狀態、C5 提示框。
// 專案專屬的版面只有稽核紀錄表，樣式在 public/app.css
import { html } from 'hono/html';
import type { AuditLog } from './audit';
import type { ConsentChoice } from './consents';
import type { AuthEvent, AuthEventType } from './events';
import type { PasskeySummary } from './passkeys';
import type { ServiceDefinition } from './services';

type Content = ReturnType<typeof html> | string | Content[];

const ACCENTS = ['accent-coral', 'accent-violet', 'accent-blue', 'accent-green'] as const;
type Accent = (typeof ACCENTS)[number];

interface PageOptions {
  /** <title> 裡「MCP 閘道｜」後面的用途 */
  title: string;
  /** 設定頁的導覽；登入與同意頁不顯示 */
  nav?: 'grants' | 'logs';
  /** 大標：實心行講對象，描邊行講動作。有導覽列的頁面只用實心行，手機首屏才放得下 */
  solid: string;
  outline?: string;
  /** 導言在手機上要維持一行，20 字內 */
  lede: string;
  cards: Content;
  /** 卡片之後的提示框 */
  note?: Content;
}

function page(o: PageOptions) {
  const nav = o.nav
    ? html`<nav class="site-nav" aria-label="頁面">
        <a href="/settings" ${o.nav === 'grants' ? html`aria-current="page"` : ''}>授權</a>
        <a href="/settings/logs" ${o.nav === 'logs' ? html`aria-current="page"` : ''}>紀錄</a>
      </nav>`
    : '';
  return html`<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f5f3ed">
<title>MCP 閘道｜${o.title}</title>
<link rel="manifest" href="/app.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="stylesheet" href="/jerry-ui.css">
<link rel="stylesheet" href="/app.css">
<script src="/jerry-ui.js" defer></script>
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">跳到主要內容</a>
<div class="wrap is-wide">
  <header class="top">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">M</span>MCP GATEWAY</a>
    <div class="top-end">${nav}<p class="pill">OAUTH 2.1 · OWNER ONLY</p></div>
  </header>

  <header class="masthead">
    <p class="eyebrow">MCP GATEWAY</p>
    <div class="masthead-grid">
      <h1><span>${o.solid}</span>${o.outline ? html`<em>${o.outline}</em>` : ''}</h1>
      <p class="lede">${o.lede}</p>
    </div>
  </header>

  <main id="main">
    <div class="card-grid">${o.cards}</div>
    ${o.note ?? ''}
  </main>

  <footer class="site-foot is-mono">MCP 閘道 · OAuth 授權與登入 · 不保存服務資料</footer>
</div>
<img class="jerry-mark" src="/jerry.png" width="1" height="1" alt="" aria-hidden="true">
</body>
</html>`;
}

interface CardOptions {
  index: number;
  id: string;
  title: string;
  desc?: string;
  accent: Accent;
  wide?: boolean;
  content: Content;
}

function card(o: CardOptions) {
  return html`<section class="card is-roomy ${o.accent}${o.wide ? ' is-wide' : ''}" aria-labelledby="${o.id}">
    <div class="card-heading">
      <span class="index-badge" aria-hidden="true">${String(o.index).padStart(2, '0')}</span>
      <div><h2 id="${o.id}">${o.title}</h2>${o.desc ? html`<p>${o.desc}</p>` : ''}</div>
    </div>
    ${o.content}
  </section>`;
}

function note(title: string, text: string, warn = false) {
  return html`<aside class="note${warn ? ' is-warn' : ''}">
      <span class="note-icon" aria-hidden="true">${warn ? '!' : '⌁'}</span>
      <div><strong>${title}</strong><p>${text}</p></div>
    </aside>`;
}

export function loginPage(next: string, error?: string) {
  return page({
    title: '登入',
    solid: 'MCP 閘道',
    outline: '擁有者登入',
    lede: '登入後才能授權或管理 AI client。',
    cards: [
      card({
        index: 1,
        id: 'login-title',
        title: '登入',
        desc: '輸入閘道的登入密碼',
        accent: 'accent-coral',
        content: html`<form class="panel" id="login-form" method="post" action="/login">
      <input type="hidden" name="next" value="${next}">
      <div class="field${error ? ' is-invalid' : ''}">
        <label for="password">密碼</label>
        <input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
      </div>
      <button class="btn is-block" type="submit">登入閘道<span class="btn-arrow" aria-hidden="true">→</span></button>
      ${error ? html`<p class="status is-error" id="login-status" role="alert">${error}</p>` : html`<p class="status" id="login-status" role="status"></p>`}
    </form>
    <div class="panel" id="passkey-panel" data-next="${next}" hidden>
      <button class="btn secondary is-block" type="button" id="passkey-login">改用 Passkey 登入</button>
      <p class="status" id="passkey-status" role="status"></p>
    </div>
    <script src="/passkey.js" defer></script>`,
      }),
      card({
        index: 2,
        id: 'flow-title',
        title: '登入之後',
        desc: '授權一個 AI client 的三個步驟',
        accent: 'accent-violet',
        content: html`<ol class="steps">
      <li>確認 client 的名稱與同意後會導回的網址。</li>
      <li>勾選這個 client 能用的權限，預設只有查詢。</li>
      <li>按同意後瀏覽器導回 client，授權完成。</li>
    </ol>`,
      }),
    ],
    note: note('AI client 拿不到這組密碼', '密碼只用在這個網站的登入。client 拿到的是你同意後閘道發的 token，可以隨時在設定頁撤銷。'),
  });
}

interface ConsentOptions {
  /** 表單送回的路徑（含原本的授權參數） */
  action: string;
  csrf: string;
  clientName: string;
  redirectUri: string;
  services: readonly ServiceDefinition[];
  /** 預先勾選的範圍 */
  checked: ReadonlySet<string>;
}

export function consentPage(o: ConsentOptions) {
  return page({
    title: '授權 client',
    solid: '授權 client',
    outline: '選擇權限',
    lede: '確認對象，只勾選它需要的權限。',
    cards: [
      card({
        index: 1,
        id: 'client-title',
        title: '確認對象',
        desc: '以導回網址為準，不認得就拒絕',
        accent: 'accent-blue',
        content: html`<dl class="def-list">
      <dt>名稱<small>client 自己填的，任何人都能註冊</small></dt><dd>${o.clientName}</dd>
      <dt>導回網址<small>同意後授權碼會送到這裡</small></dt><dd><code class="keys">${o.redirectUri}</code></dd>
    </dl>`,
      }),
      card({
        index: 2,
        id: 'scope-title',
        title: '選擇權限',
        desc: '之後可以在設定頁撤銷',
        accent: 'accent-coral',
        content: html`<form class="panel" id="consent-form" method="post" action="${o.action}">
      <input type="hidden" name="csrf" value="${o.csrf}">
      ${o.services.map(
        (service) => html`<h3>${service.label}</h3>
      <div class="switches">${service.scopes.map(
        (s) =>
          html`<label class="switch"><span><strong>${s.label}</strong><small>${s.scope}｜${s.description}</small></span><input type="checkbox" id="scope-${s.scope.replace(/[^a-z0-9]+/gi, '-')}" name="scope" value="${s.scope}"${o.checked.has(s.scope) ? html` checked` : ''}><i aria-hidden="true"></i></label>`,
      )}</div>`,
      )}
      <div class="actions"><button class="btn" type="submit" name="action" value="approve">同意授權</button><button class="btn secondary" type="submit" name="action" value="deny">拒絕</button></div>
    </form>`,
      }),
    ],
    note: note('名稱可以冒用，網址不行', '同意後授權碼只會送到上面的導回網址。本機工具通常是 localhost 開頭；網址不認得就按拒絕。', true),
  });
}

export interface GrantView {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  /** ISO 時間 */
  createdAt: string;
  /** 授權之後才新增、同意頁還沒列過的範圍；不是空的就要重新授權 */
  newScopes: string[];
}

/** 授權卡片上的重新授權提示：從 client 重新授權即可，同意後會取代舊授權 */
function reauthNotice(newScopes: string[]) {
  if (!newScopes.length) return '';
  return html`<p class="status is-error">需要重新授權：授權之後新增了下列權限。從 client 重新授權即可，同意後會取代這個授權，不必先撤銷。</p>
    <ul class="badges" aria-label="還沒授權過的新權限">
      ${newScopes.map((s) => html`<li class="badge is-fail">${s}</li>`)}
    </ul>`;
}

/** 記住的勾選：撤銷授權後仍然保留，清除後下次授權回到服務的預設 */
function rememberedCard(csrf: string, choices: ConsentChoice[], index: number) {
  return card({
    index,
    id: 'remembered-title',
    title: '記住的勾選',
    desc: '重新授權時預先勾好，撤銷授權不會清掉',
    accent: 'accent-violet',
    content: choices.map(
      (choice, i) => html`<h3>${choice.clientName || choice.clientId}</h3>
    <ul class="badges" aria-label="上次勾選的權限">
      ${choice.granted.length ? choice.granted.map((s) => html`<li class="badge is-pass">${s}</li>`) : html`<li class="badge">沒有勾選任何權限</li>`}
    </ul>
    <dl class="def-list">
      <dt>client</dt><dd><code class="keys">${choice.clientId}</code></dd>
      <dt>最近同意</dt><dd>${choice.updatedAt}</dd>
      <dt>來源 IP</dt><dd>${choice.ip}</dd>
      <dt>User-Agent</dt><dd>${choice.userAgent}</dd>
    </dl>
    <form class="panel" id="forget-${i + 1}-form" method="post" action="/settings/forget">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="client" value="${choice.clientId}">
      <button class="btn secondary is-block" type="submit">清除記住的勾選</button>
    </form>`,
    ),
  });
}

/** Passkey：列出已新增的、刪除，以及新增一把（瀏覽器端在 public/passkey.js） */
function passkeysCard(csrf: string, passkeys: PasskeySummary[], index: number) {
  return card({
    index,
    id: 'passkeys-title',
    title: 'Passkey',
    desc: '用 Face ID、Touch ID 或裝置 PIN 登入，只能用在這個網址',
    accent: 'accent-coral',
    content: html`${passkeys.map(
      (p, i) => html`<h3>${p.name}</h3>
    <dl class="def-list">
      <dt>新增時間</dt><dd>${p.createdAt}</dd>
      <dt>最近使用</dt><dd>${p.lastUsedAt ?? '還沒用過'}</dd>
      <dt>同步</dt><dd>${p.synced ? '會同步到其他裝置' : '只在這台裝置'}</dd>
    </dl>
    <form class="panel" id="passkey-delete-${i + 1}-form" method="post" action="/settings/passkeys/delete">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="id" value="${p.id}">
      <button class="btn secondary is-block" type="submit">刪除這個 Passkey</button>
    </form>`,
    )}
    <form class="panel" id="passkey-add-form" hidden>
      <input type="hidden" name="csrf" value="${csrf}">
      <div class="field">
        <label for="passkey-name">名稱</label>
        <input id="passkey-name" name="name" maxlength="60" placeholder="例如：我的筆電">
      </div>
      <div class="field">
        <label for="passkey-password">目前的密碼</label>
        <input id="passkey-password" type="password" name="password" autocomplete="current-password" required>
      </div>
      <button class="btn is-block" type="submit">新增 Passkey</button>
      <p class="status" id="passkey-add-status" role="status"></p>
    </form>
    <script src="/passkey.js" defer></script>`,
  });
}

export function settingsPage(csrf: string, grants: GrantView[], choices: ConsentChoice[], passkeys: PasskeySummary[]) {
  const grantCards = grants.map((g, i) =>
    card({
      index: i + 1,
      id: `grant-${i + 1}-title`,
      title: g.clientName,
      desc: g.clientId,
      accent: ACCENTS[i % ACCENTS.length],
      content: html`<ul class="badges" aria-label="已授權的權限">
      ${g.scopes.length ? g.scopes.map((s) => html`<li class="badge is-pass">${s}</li>`) : html`<li class="badge">沒有任何權限</li>`}
    </ul>
    ${reauthNotice(g.newScopes)}
    <p class="meta">授權時間：${g.createdAt}</p>
    <form class="panel" id="revoke-${i + 1}-form" method="post" action="/settings/revoke">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="grant" value="${g.id}">
      <button class="btn secondary is-block" type="submit">撤銷這個授權</button>
    </form>`,
    }),
  );
  const empty = card({
    index: 1,
    id: 'grant-empty-title',
    title: '還沒有授權',
    desc: 'client 第一次連線時會要求授權',
    accent: 'accent-blue',
    content: html`<p class="meta">目前沒有已授權的 client。把閘道的 /mcp 網址加進 AI client，它會開瀏覽器帶你走授權流程。</p>`,
  });
  const remembered = choices.length ? rememberedCard(csrf, choices, Math.max(grants.length, 1) + 1) : '';
  const passkeyCard = passkeysCard(csrf, passkeys, Math.max(grants.length, 1) + (choices.length ? 2 : 1));
  const logout = card({
    index: Math.max(grants.length, 1) + (choices.length ? 3 : 2),
    id: 'logout-title',
    title: '登出',
    desc: '結束這個瀏覽器的登入狀態',
    accent: 'accent-green',
    content: html`<form class="panel" id="logout-form" method="post" action="/logout">
      <input type="hidden" name="csrf" value="${csrf}">
      <button class="btn secondary is-block" type="submit">登出閘道</button>
    </form>`,
  });
  return page({
    title: '已授權的 client',
    nav: 'grants',
    solid: '授權管理',
    lede: '撤銷後，client 的 token 立刻失效。',
    cards: [grants.length ? grantCards : empty, remembered, passkeyCard, logout],
    note: note('換密碼不會撤銷授權', '更換閘道密碼後，已發出的 token 仍然有效。懷疑密碼外流時，要在這裡把 client 逐一撤銷。', true),
  });
}

export interface LogView extends AuditLog {
  clientName: string;
}

/** 事件在紀錄頁顯示的名稱，與沿用稽核紀錄表的顏色 */
export const EVENT_LABELS: Record<AuthEventType, { text: string; tone: 'ok' | 'forbidden' | 'error' | 'plain' }> = {
  login: { text: '登入成功', tone: 'ok' },
  login_failed: { text: '登入失敗', tone: 'error' },
  login_blocked: { text: '登入被擋', tone: 'forbidden' },
  logout: { text: '登出', tone: 'plain' },
  grant_approved: { text: '同意授權', tone: 'ok' },
  grant_denied: { text: '拒絕授權', tone: 'plain' },
  grant_revoked: { text: '撤銷授權', tone: 'forbidden' },
  passkey_added: { text: '新增 Passkey', tone: 'forbidden' },
  passkey_removed: { text: '刪除 Passkey', tone: 'plain' },
};

function eventsCard(events: AuthEvent[]) {
  return card({
    index: 2,
    id: 'events-title',
    title: '帳號與授權',
    desc: `最近 ${events.length} 筆，新的在前`,
    accent: 'accent-blue',
    wide: true,
    content: events.length
      ? html`<div class="app-log-scroll">
      <table class="app-log">
        <thead><tr><th scope="col">時間</th><th scope="col">事件</th><th scope="col">client</th><th scope="col">範圍</th><th scope="col">來源</th></tr></thead>
        <tbody>
        ${events.map((e) => {
          const label = EVENT_LABELS[e.event] ?? { text: e.event, tone: 'plain' };
          return html`<tr><td class="app-log-num">${e.created_at}</td><td class="app-log-${label.tone}">${label.text}</td><td>${e.client_name || e.client_id}${e.client_id ? html`<br><small class="app-log-id">${e.client_id}</small>` : ''}</td><td class="app-log-num">${e.scopes}</td><td class="app-log-num">${e.ip}<br><small class="app-log-id app-log-agent">${e.user_agent}</small></td></tr>`;
        })}
        </tbody>
      </table>
    </div>`
      : html`<p class="meta">還沒有任何帳號與授權紀錄。</p>`,
  });
}

export function logsPage(logs: LogView[], events: AuthEvent[]) {
  return page({
    title: '稽核紀錄',
    nav: 'logs',
    solid: '稽核紀錄',
    lede: 'tool 呼叫與帳號操作，保留 30 天。',
    cards: [card({
      index: 1,
      id: 'logs-title',
      title: '最近的呼叫',
      desc: `最近 ${logs.length} 筆，新的在前`,
      accent: 'accent-violet',
      wide: true,
      content: logs.length
        ? html`<div class="app-log-scroll">
      <table class="app-log">
        <thead><tr><th scope="col">時間</th><th scope="col">client</th><th scope="col">tool</th><th scope="col">結果</th><th scope="col">毫秒</th></tr></thead>
        <tbody>
        ${logs.map(
          (log) =>
            html`<tr><td class="app-log-num">${log.created_at}</td><td>${log.clientName}<br><small class="app-log-id">${log.client_id}</small></td><td class="app-log-num">${log.tool}</td><td class="app-log-${log.status}">${log.status}</td><td class="app-log-num">${log.duration_ms}</td></tr>`,
        )}
        </tbody>
      </table>
    </div>`
        : html`<p class="meta">還沒有任何呼叫紀錄。</p>`,
    }), eventsCard(events)],
    note: note('不記內容，也不記密碼', 'tool 呼叫只有 client、tool、結果與處理時間，不記參數與回傳內容。forbidden 是 client 呼叫了沒被授權的 tool，沒有執行；throttled 是同一個 client 三秒內的第二次新增，沒有執行；error 是找不到、重複或服務發生錯誤。帳號與授權另記來源 IP 與瀏覽器，不記密碼與 token。'),
  });
}

interface MessageOptions {
  /** 大標第二行與卡片標題，8 字內 */
  heading: string;
  text: string;
  /** 下一步的連結 */
  link?: { href: string; text: string };
}

/** 流程走不下去時的提示：密碼沒設定、授權請求無效、沒登入、表單過期 */
export function messagePage(o: MessageOptions) {
  return page({
    title: o.heading,
    solid: '無法繼續',
    outline: o.heading,
    lede: '這一步沒有完成，也沒有發出任何授權。',
    cards: card({
      index: 1,
      id: 'message-title',
      title: o.heading,
      accent: 'accent-coral',
      wide: true,
      content: html`<p>${o.text}</p>
    ${o.link ? html`<div class="actions"><a class="btn" href="${o.link.href}">${o.link.text}</a></div>` : ''}`,
    }),
  });
}
