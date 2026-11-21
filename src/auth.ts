// 登入、同意、設定頁的路由（OAuthProvider 的 defaultHandler）；頁面的標記在 ui.ts
import type { AuthRequest, GrantSummary, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { Hono, type Context } from 'hono';
import { listRecent } from './audit';
import { listRecentEvents, recordEvent, type AuthEventClient, type AuthEventType } from './events';
import { INSTANT_EVENTS, sendEventMail } from './mailer';
import { loadServices, scopesOf } from './services';
import { createSession, destroySession, readSession, safeEqual, type Session } from './session';
import { clearAttempts, countAttempt, MAX_ATTEMPTS, sourceOf, WINDOW_SECONDS } from './throttle';
import { consentPage, loginPage, logsPage, messagePage, settingsPage } from './ui';

type AppEnv = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } };

export const authApp = new Hono<AppEnv>();

/** 授權資料都屬於閘道的擁有者一人 */
export const OWNER = 'owner';

/** 只接受站內路徑，避免登入後被導到外部網站。瀏覽器會把 /\host 當成 //host、略過 tab 與換行，所以交給 URL 解析後確認還在站內 */
function safeNext(value: unknown): string {
  const base = 'https://gateway.invalid';
  if (typeof value !== 'string' || !value.startsWith('/')) return '/settings';
  try {
    const target = new URL(value, base);
    return target.origin === base ? target.pathname + target.search : '/settings';
  } catch {
    return '/settings';
  }
}

/** 記一筆帳號或授權事件；要通知的事件在背景寄信，不擋頁面回應 */
async function track(c: Context<AppEnv>, event: AuthEventType, client?: AuthEventClient, notify = INSTANT_EVENTS.has(event)): Promise<void> {
  const request = c.req.raw;
  await recordEvent(c.env.DB, request, event, client);
  if (!notify) return;
  c.executionCtx.waitUntil(
    sendEventMail(c.env, { event, at: new Date(), ip: sourceOf(request), userAgent: request.headers.get('User-Agent') ?? '', client }),
  );
}

// 沒設定 GATEWAY_PASS 時整個授權流程拒絕，不預設開放
authApp.use('*', async (c, next) => {
  if (!c.env.GATEWAY_PASS) {
    return c.html(messagePage({ heading: '尚未設定密碼', text: '閘道還沒有登入密碼。請擁有者以 wrangler secret put GATEWAY_PASS 設定後再試。' }), 503);
  }
  return next();
});

authApp.use('*', async (c, next) => {
  await next();
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  // 樣式、腳本、圖片只收同源的檔案（public/ 的元件庫），不允許內嵌。不設 form-action：同意後要導回 client 的 redirect_uri，瀏覽器會把那次導向也算進去
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  c.header('X-Content-Type-Options', 'nosniff');
  // 頁面帶 CSRF token 與授權清單，不留在快取
  c.header('Cache-Control', 'no-store');
});

authApp.get('/', (c) => c.redirect('/settings', 302));

authApp.get('/login', (c) => c.html(loginPage(safeNext(c.req.query('next')))));

authApp.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const next = safeNext(body.next);
  const password = typeof body.password === 'string' ? body.password : '';
  // 先佔一次名額再驗密碼：超過上限時連正確密碼也不驗
  const source = sourceOf(c.req.raw);
  const attempt = await countAttempt(c.env.DB, source);
  if (attempt > MAX_ATTEMPTS) {
    // 只在剛超過上限的那一次通知，同一個時間窗不重複寄
    await track(c, 'login_blocked', undefined, attempt === MAX_ATTEMPTS + 1);
    c.header('Retry-After', String(WINDOW_SECONDS));
    return c.html(loginPage(next, `密碼錯誤次數過多，請 ${WINDOW_SECONDS / 60} 分鐘後再試`), 429);
  }
  // 沒設定密碼時一律不通過：上面的 middleware 已經擋掉，這裡不依賴它
  const expected = c.env.GATEWAY_PASS;
  if (!expected || !(await safeEqual(password, expected))) {
    await track(c, 'login_failed');
    return c.html(loginPage(next, '密碼不正確'), 401);
  }
  await clearAttempts(c.env.DB, source);
  await createSession(c);
  await track(c, 'login');
  return c.redirect(next, 302);
});

/** client 不存在、redirect_uri 不符這類無效的授權請求回 null，由呼叫端回 400；細節只寫 log，不回給對方 */
async function parseAuth(c: Context<AppEnv>): Promise<AuthRequest | null> {
  try {
    return await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    console.warn(JSON.stringify({ message: 'invalid authorize request', error: String(err) }));
    return null;
  }
}

const INVALID_AUTH_REQUEST = messagePage({ heading: '授權請求無效', text: '這個授權請求不正確或已經失效。請回到 client 重新開始授權。' });

/** 會改變狀態的表單都要已登入，並帶著綁在 Session 上的 CSRF token；不符合時回傳要直接送出的回應 */
async function checkedForm(c: Context<AppEnv>): Promise<Response | { session: Session; body: Record<string, unknown> }> {
  const session = await readSession(c);
  if (!session) {
    return c.html(messagePage({ heading: '尚未登入', text: '登入狀態已經過期或還沒登入，這次的操作沒有送出。', link: { href: '/login', text: '前往登入' } }), 401);
  }
  const body = await c.req.parseBody({ all: true });
  if (typeof body.csrf !== 'string' || !(await safeEqual(body.csrf, session.csrf))) {
    return c.html(messagePage({ heading: '表單已過期', text: '這張表單已經失效，操作沒有送出。請回到上一頁重新整理後再試。', link: { href: '/settings', text: '回到設定頁' } }), 403);
  }
  return { session, body };
}

authApp.get('/authorize', async (c) => {
  const authRequest = await parseAuth(c);
  if (!authRequest) return c.html(INVALID_AUTH_REQUEST, 400);
  const session = await readSession(c);
  const path = new URL(c.req.url).pathname + new URL(c.req.url).search;
  if (!session) return c.html(loginPage(path));
  const client = await c.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  return c.html(
    consentPage({
      action: path,
      csrf: session.csrf,
      clientName: client?.clientName || authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      services: await loadServices(c.env),
    }),
  );
});

authApp.post('/authorize', async (c) => {
  const checked = await checkedForm(c);
  if (checked instanceof Response) return checked;
  const { body } = checked;

  const authRequest = await parseAuth(c);
  if (!authRequest) return c.html(INVALID_AUTH_REQUEST, 400);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  const eventClient = { clientId: authRequest.clientId, clientName: client?.clientName ?? '' };
  if (body.action !== 'approve') {
    await track(c, 'grant_denied', eventClient);
    const target = new URL(authRequest.redirectUri);
    target.searchParams.set('error', 'access_denied');
    if (authRequest.state) target.searchParams.set('state', authRequest.state);
    return c.redirect(target.toString(), 302);
  }

  const allScopes = scopesOf(await loadServices(c.env));
  const scopes = [body.scope ?? []].flat().filter((s): s is string => typeof s === 'string' && allScopes.has(s));
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: OWNER,
    metadata: { clientName: client?.clientName ?? '' },
    scope: scopes,
    props: { scopes },
  });
  await track(c, 'grant_approved', { ...eventClient, scopes });
  return c.redirect(redirectTo, 302);
});

// 設定頁：列出並撤銷已授權的 client、查看稽核紀錄。都要先登入

async function allGrants(helpers: OAuthHelpers): Promise<GrantSummary[]> {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(OWNER, { cursor });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return grants;
}

function clientName(grant: GrantSummary): string {
  return typeof grant.metadata?.clientName === 'string' && grant.metadata.clientName ? grant.metadata.clientName : grant.clientId;
}

authApp.post('/logout', async (c) => {
  const checked = await checkedForm(c);
  if (checked instanceof Response) return checked;
  await destroySession(c);
  await track(c, 'logout');
  return c.redirect('/login', 302);
});

authApp.get('/settings', async (c) => {
  const session = await readSession(c);
  if (!session) return c.redirect('/login?next=/settings', 302);
  const grants = await allGrants(c.env.OAUTH_PROVIDER);
  return c.html(
    settingsPage(
      session.csrf,
      grants.map((g) => ({ id: g.id, clientId: g.clientId, clientName: clientName(g), scopes: g.scope, createdAt: new Date(g.createdAt * 1000).toISOString() })),
    ),
  );
});

authApp.post('/settings/revoke', async (c) => {
  const checked = await checkedForm(c);
  if (checked instanceof Response) return checked;
  const { body } = checked;
  if (typeof body.grant !== 'string' || !body.grant) {
    return c.html(messagePage({ heading: '缺少授權', text: '沒有指定要撤銷哪一個授權。', link: { href: '/settings', text: '回到設定頁' } }), 400);
  }
  // 撤銷後查不到 client 了，先留下它的名稱
  const grant = (await allGrants(c.env.OAUTH_PROVIDER)).find((g) => g.id === body.grant);
  await c.env.OAUTH_PROVIDER.revokeGrant(body.grant, OWNER);
  if (grant) await track(c, 'grant_revoked', { clientId: grant.clientId, clientName: clientName(grant) });
  return c.redirect('/settings', 302);
});

authApp.get('/settings/logs', async (c) => {
  const session = await readSession(c);
  if (!session) return c.redirect('/login?next=/settings/logs', 302);
  const [logs, grants, events] = await Promise.all([listRecent(c.env.DB), allGrants(c.env.OAUTH_PROVIDER), listRecentEvents(c.env.DB)]);
  const names = new Map(grants.map((g) => [g.clientId, clientName(g)]));
  return c.html(logsPage(logs.map((log) => ({ ...log, clientName: names.get(log.client_id) ?? '（已撤銷）' })), events));
});
