// 登入後的頁面（授權、紀錄、設定）共用導覽列：三個頁面的連結，加上登出按鈕
import { describe, expect, it } from 'vitest';
import { csrfOf, form, gw, login } from './helpers/oauth';

const PAGES = ['/settings', '/settings/logs', '/settings/account'];

async function owner(): Promise<string> {
  const cookie = await login();
  if (!cookie) throw new Error('登入失敗');
  return cookie;
}

describe('導覽列', () => {
  it('每一頁都有授權、紀錄、設定三個連結與登出按鈕', async () => {
    const cookie = await owner();
    for (const path of PAGES) {
      const res = await gw(path, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const html = await res.text();
      const nav = html.slice(html.indexOf('<nav class="site-nav"'), html.indexOf('</nav>'));
      expect(nav).toContain('href="/settings"');
      expect(nav).toContain('href="/settings/logs"');
      expect(nav).toContain('href="/settings/account"');
      expect(nav).toContain('action="/logout"');
      expect(nav).toContain(`href="${path}" aria-current="page"`);
    }
  });

  it('紀錄頁的登出按鈕可以登出', async () => {
    const cookie = await owner();
    const html = await (await gw('/settings/logs', { headers: { Cookie: cookie } })).text();
    const res = await gw('/logout', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf: csrfOf(html) }) });
    expect(res.status).toBe(302);
    expect((await gw('/settings/logs', { headers: { Cookie: cookie } })).headers.get('Location')).toBe('/login?next=/settings/logs');
  });

  it('設定頁沒登入時導向登入頁', async () => {
    const res = await gw('/settings/account');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login?next=/settings/account');
  });

  it('設定頁有 Passkey，授權頁不再放 Passkey', async () => {
    const cookie = await owner();
    const account = await (await gw('/settings/account', { headers: { Cookie: cookie } })).text();
    expect(account).toContain('id="passkey-add-form"');
    const grants = await (await gw('/settings', { headers: { Cookie: cookie } })).text();
    expect(grants).not.toContain('id="passkey-add-form"');
  });
});
