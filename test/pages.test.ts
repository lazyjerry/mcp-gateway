// 頁面外框：登入、同意、設定、紀錄與提示訊息都套用同一套元件庫
import { describe, expect, it } from 'vitest';
import { authorize, form, gw } from './helpers/oauth';

function expectShell(html: string) {
  expect(html).toContain('<html lang="zh-Hant-TW">');
  expect(html).toContain('<link rel="stylesheet" href="/jerry-ui.css">');
  expect(html).toContain('<script src="/jerry-ui.js" defer></script>');
  expect(html).toContain('<img class="jerry-mark" src="/jerry.png" width="1" height="1" alt="" aria-hidden="true">');
  expect(html).not.toContain('<style');
  expect(html.match(/<h1/g)).toHaveLength(1);
}

describe('頁面外框', () => {
  it('登入頁', async () => {
    expectShell(await (await gw('/login')).text());
  });

  it('設定頁與紀錄頁，設定頁有登出表單', async () => {
    const { cookie } = await authorize(['notes:read']);
    const settings = await (await gw('/settings', { headers: { Cookie: cookie } })).text();
    expectShell(settings);
    expect(settings).toContain('action="/logout"');
    expectShell(await (await gw('/settings/logs', { headers: { Cookie: cookie } })).text());
  });

  it('CSP 只允許同源的樣式、腳本與圖片，不允許內嵌', async () => {
    const csp = (await gw('/login')).headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
  });
});

describe('提示訊息也是完整的頁面', () => {
  it('無效的授權請求（400）', async () => {
    const res = await gw('/authorize?response_type=code&client_id=no-such-client&redirect_uri=http://localhost/callback');
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expectShell(await res.text());
  });

  it('表單的 CSRF token 不對（403）', async () => {
    const { cookie } = await authorize(['notes:read']);
    const res = await gw('/settings/revoke', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf: 'wrong', grant: 'x' }) });
    expect(res.status).toBe(403);
    expectShell(await res.text());
  });

  it('沒登入就送表單（401），頁面有前往登入的連結', async () => {
    const res = await gw('/logout', { method: 'POST', body: form({ csrf: 'x' }) });
    expect(res.status).toBe(401);
    const html = await res.text();
    expectShell(html);
    expect(html).toContain('href="/login"');
  });
});
