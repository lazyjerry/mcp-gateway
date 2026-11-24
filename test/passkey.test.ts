// Passkey 登入：設定頁新增（要再輸入密碼）、登入頁以 Passkey 換 Session、設定頁刪除。
// 用 test/helpers/passkey.ts 的軟體驗證器產生 WebAuthn 回應，伺服器端照真的驗證
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { csrfOf, form, gw, GATEWAY_PASS, login } from './helpers/oauth';
import { Authenticator } from './helpers/passkey';

vi.spyOn(env.EMAIL, 'send').mockResolvedValue({ messageId: 'test-id' } as never);

let ipCounter = 0;
/** 每次換一個來源 IP，登入失敗的節流不互相影響 */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function json(path: string, body: unknown, headers: Record<string, string> = {}, ip = nextIp()): Promise<Response> {
  return gw(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers }, body: JSON.stringify(body) });
}

async function ownerSession(): Promise<{ cookie: string; csrf: string }> {
  const cookie = await login();
  if (!cookie) throw new Error('登入失敗');
  const html = await (await gw('/settings', { headers: { Cookie: cookie } })).text();
  return { cookie, csrf: csrfOf(html) };
}

/** 在設定頁新增一把 Passkey，回傳驗證器 */
async function addPasskey(name = '測試 Passkey'): Promise<Authenticator> {
  const { cookie, csrf } = await ownerSession();
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
  const optionsRes = await json('/settings/passkeys/options', { password: GATEWAY_PASS }, headers);
  expect(optionsRes.status).toBe(200);
  const authenticator = new Authenticator();
  const res = await json('/settings/passkeys', { name, response: await authenticator.create(await optionsRes.json()) }, headers);
  expect(res.status).toBe(201);
  return authenticator;
}

async function passkeyLogin(authenticator: Authenticator, next = '/settings', ip = nextIp()): Promise<Response> {
  const options = await (await json('/login/passkey/options', {}, {}, ip)).json();
  return json('/login/passkey', { next, response: await authenticator.get(options as never) }, {}, ip);
}

describe('還沒有 Passkey', () => {
  // 這個測試要在新增任何 Passkey 之前跑：同一個測試檔共用 D1
  it('登入選項回 400 並說明要先新增', async () => {
    const res = await json('/login/passkey/options', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('還沒有新增任何 Passkey');
  });

  it('登入頁有 Passkey 登入的按鈕與腳本', async () => {
    const html = await (await gw('/login')).text();
    expect(html).toContain('id="passkey-login"');
    expect(html).toContain('<script src="/passkey.js" defer></script>');
  });
});

describe('新增 Passkey', () => {
  it('沒登入不能取註冊選項', async () => {
    const res = await json('/settings/passkeys/options', { password: GATEWAY_PASS });
    expect(res.status).toBe(401);
  });

  it('沒帶 CSRF token 不能取註冊選項', async () => {
    const { cookie } = await ownerSession();
    const res = await json('/settings/passkeys/options', { password: GATEWAY_PASS }, { Cookie: cookie });
    expect(res.status).toBe(403);
  });

  it('密碼錯誤不能取註冊選項', async () => {
    const { cookie, csrf } = await ownerSession();
    const res = await json('/settings/passkeys/options', { password: 'wrong' }, { Cookie: cookie, 'X-CSRF-Token': csrf });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain('密碼不正確');
  });

  it('註冊回應的 origin 不符就不收', async () => {
    const { cookie, csrf } = await ownerSession();
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
    const options = await (await json('/settings/passkeys/options', { password: GATEWAY_PASS }, headers)).json();
    const response = await new Authenticator().create(options as never, 'https://evil.example');
    const res = await json('/settings/passkeys', { name: '假的', response }, headers);
    expect(res.status).toBe(400);
  });

  it('新增後設定頁列出名稱，紀錄頁有一筆新增 Passkey', async () => {
    await addPasskey('我的筆電');
    const { cookie } = await ownerSession();
    const settings = await (await gw('/settings', { headers: { Cookie: cookie } })).text();
    expect(settings).toContain('我的筆電');
    const logs = await (await gw('/settings/logs', { headers: { Cookie: cookie } })).text();
    expect(logs).toContain('新增 Passkey');
  });
});

describe('以 Passkey 登入', () => {
  it('驗證通過就發 Session，導向 next', async () => {
    const authenticator = await addPasskey();
    const res = await passkeyLogin(authenticator, '/settings/logs');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { redirect: string }).redirect).toBe('/settings/logs');
    const cookie = res.headers.get('Set-Cookie')!.split(';')[0];
    const settings = await gw('/settings', { headers: { Cookie: cookie } });
    expect(settings.status).toBe(200);
  });

  it('next 是外部網址時導回設定頁', async () => {
    const authenticator = await addPasskey();
    const res = await passkeyLogin(authenticator, '//evil.example/x');
    expect(((await res.json()) as { redirect: string }).redirect).toBe('/settings');
  });

  it('同一個 challenge 不能用兩次', async () => {
    const authenticator = await addPasskey();
    const ip = nextIp();
    const options = await (await json('/login/passkey/options', {}, {}, ip)).json();
    expect((await json('/login/passkey', { response: await authenticator.get(options as never) }, {}, ip)).status).toBe(200);
    // 對同一個 challenge 重新簽一次：counter 已經遞增，只能靠 challenge 只兌換一次擋下
    const replay = await json('/login/passkey', { response: await authenticator.get(options as never) }, {}, ip);
    expect(replay.status).toBe(401);
    expect(replay.headers.get('Set-Cookie')).toBeNull();
  });

  it('沒註冊過的驗證器不能登入', async () => {
    await addPasskey();
    const res = await passkeyLogin(new Authenticator());
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('其他網站的 origin 不能登入', async () => {
    const authenticator = await addPasskey();
    const ip = nextIp();
    const options = await (await json('/login/passkey/options', {}, {}, ip)).json();
    const response = await authenticator.get(options as never, 'https://evil.example');
    const res = await json('/login/passkey', { response }, {}, ip);
    expect(res.status).toBe(401);
  });

  it('失敗次數跟密碼登入共用節流', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) {
      await gw('/login', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: form({ password: 'wrong', next: '/settings' }) });
    }
    const authenticator = await addPasskey();
    const res = await passkeyLogin(authenticator, '/settings', ip);
    expect(res.status).toBe(429);
  });

  it('要用 JSON 送出，表單送不進來', async () => {
    const res = await gw('/login/passkey', { method: 'POST', headers: { 'CF-Connecting-IP': nextIp() }, body: form({ response: '{}' }) });
    expect(res.status).toBe(415);
  });
});

describe('刪除 Passkey', () => {
  it('刪除後就不能再用它登入，紀錄頁有一筆刪除 Passkey', async () => {
    const authenticator = await addPasskey('要刪的');
    const { cookie, csrf } = await ownerSession();
    const res = await gw('/settings/passkeys/delete', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf, id: authenticator.credentialId }) });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/settings');
    expect((await passkeyLogin(authenticator)).status).toBe(401);
    const logs = await (await gw('/settings/logs', { headers: { Cookie: cookie } })).text();
    expect(logs).toContain('刪除 Passkey');
  });

  it('沒帶 CSRF token 不能刪', async () => {
    const authenticator = await addPasskey();
    const { cookie } = await ownerSession();
    const res = await gw('/settings/passkeys/delete', { method: 'POST', headers: { Cookie: cookie }, body: form({ id: authenticator.credentialId }) });
    expect(res.status).toBe(403);
    expect((await passkeyLogin(authenticator)).status).toBe(200);
  });
});
