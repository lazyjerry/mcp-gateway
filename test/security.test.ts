// 登入與授權頁的安全測試：導向、登入節流、安全標頭、同意頁、錯誤回應、登出
import { describe, expect, it, vi } from 'vitest';
import { authorize, authorizePath, csrfOf, form, gw, GATEWAY_PASS, pkce, REDIRECT_URI, registerClient } from './helpers/oauth';

function loginFrom(ip: string, pw: string, next = '/settings') {
  return gw('/login', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: form({ password: pw, next }) });
}

describe('登入後的導向只能在站內', () => {
  it.each(['/\\evil.test', '//evil.test', 'https://evil.test/', '/\t/evil.test', 'settings'])('next=%j 改導回 /settings', async (next) => {
    const res = await loginFrom('198.51.100.1', GATEWAY_PASS, next);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/settings');
  });

  it('站內路徑照原樣導回，含查詢字串', async () => {
    const res = await loginFrom('198.51.100.1', GATEWAY_PASS, '/settings/logs?a=1&b=%E4%B8%AD');
    expect(res.headers.get('Location')).toBe('/settings/logs?a=1&b=%E4%B8%AD');
  });

  it('登入頁的 next 欄位也不帶站外網址', async () => {
    const html = await (await gw('/login?next=' + encodeURIComponent('/\\evil.test'))).text();
    expect(html).not.toContain('evil.test');
  });
});

describe('登入失敗節流', () => {
  it('同一來源連續 5 次密碼錯誤後鎖住，正確密碼也回 429；其他來源不受影響', async () => {
    for (let i = 0; i < 5; i++) expect((await loginFrom('203.0.113.9', 'wrong')).status).toBe(401);
    const locked = await loginFrom('203.0.113.9', GATEWAY_PASS);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('Set-Cookie')).toBeNull();
    expect((await loginFrom('203.0.113.10', GATEWAY_PASS)).status).toBe(302);
  });

  it('鎖住的來源過了 15 分鐘可以再登入', async () => {
    for (let i = 0; i < 5; i++) await loginFrom('203.0.113.30', 'wrong');
    expect((await loginFrom('203.0.113.30', GATEWAY_PASS)).status).toBe(429);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const res = await loginFrom('203.0.113.30', GATEWAY_PASS);
    vi.useRealTimers();
    expect(res.status).toBe(302);
  });

  it('登入成功會清掉失敗次數', async () => {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) expect((await loginFrom('203.0.113.20', 'wrong')).status).toBe(401);
      expect((await loginFrom('203.0.113.20', GATEWAY_PASS)).status).toBe(302);
    }
  });
});

describe('安全標頭', () => {
  it.each(['/login', '/settings'])('%s 帶 CSP、nosniff、no-store', async (path) => {
    const res = await gw(path);
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('授權請求', () => {
  it('同意頁顯示同意後會導回的網址', async () => {
    const grant = await authorize(['notes:read']);
    const { challenge } = await pkce();
    const html = await (await gw(authorizePath(grant.clientId, challenge), { headers: { Cookie: grant.cookie } })).text();
    expect(html).toContain(`<code class="keys">${REDIRECT_URI}</code>`);
  });

  it('client 不存在或 redirect_uri 不符時回 400，不是 500', async () => {
    const { challenge } = await pkce();
    const bogus = await gw(authorizePath('no-such-client', challenge));
    expect(bogus.status).toBe(400);
    const clientId = await registerClient();
    const path = authorizePath(clientId, challenge).replace(encodeURIComponent(REDIRECT_URI), encodeURIComponent('http://evil.test/cb'));
    const mismatch = await gw(path);
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).not.toContain('evil.test');
  });
});

describe('登出', () => {
  it('沒帶正確的 CSRF token 時拒絕，Session 仍有效', async () => {
    const { cookie } = await authorize(['notes:read']);
    const res = await gw('/logout', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf: 'wrong' }) });
    expect(res.status).toBe(403);
    expect((await gw('/settings', { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('登出後原本的 Cookie 失效', async () => {
    const { cookie } = await authorize(['notes:read']);
    const page = await (await gw('/settings', { headers: { Cookie: cookie } })).text();
    const res = await gw('/logout', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf: csrfOf(page) }) });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    expect((await gw('/settings', { headers: { Cookie: cookie } })).status).toBe(302);
  });
});
