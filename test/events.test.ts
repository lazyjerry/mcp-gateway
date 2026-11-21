// 帳號與授權事件：登入、登出、同意、拒絕、撤銷各記一筆，一律從紀錄頁觀察，不在測試裡直接查 D1
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authorize, authorizePath, consent, csrfOf, form, gw, GATEWAY_PASS, login, pkce, registerClient } from './helpers/oauth';

const DAY = 86_400_000;

let cookie: string;

beforeAll(async () => {
  cookie = (await login())!;
});

afterEach(() => {
  vi.useRealTimers();
});

async function page(path: string): Promise<string> {
  const res = await gw(path, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return res.text();
}

/** 紀錄頁裡含某段文字的列（每列是一個 <tr>） */
async function eventRows(marker: string): Promise<string[]> {
  return (await page('/settings/logs')).split('<tr').filter((row) => row.includes(marker));
}

/** 從指定的來源 IP 與瀏覽器送出登入表單 */
function loginFrom(ip: string, password: string, userAgent = 'events-test-agent') {
  return gw('/login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip, 'User-Agent': userAgent },
    body: form({ password, next: '/settings' }),
  });
}

describe('登入與登出的紀錄', () => {
  it('登入成功記一筆，帶來源 IP 與 User-Agent', async () => {
    expect((await loginFrom('203.0.113.10', GATEWAY_PASS, 'ua-login-ok')).status).toBe(302);
    const rows = await eventRows('203.0.113.10');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('登入成功');
    expect(rows[0]).toContain('ua-login-ok');
  });

  it('密碼錯誤記登入失敗，送出的密碼不入紀錄', async () => {
    expect((await loginFrom('203.0.113.11', 'WRONG-PASS-VALUE')).status).toBe(401);
    const rows = await eventRows('203.0.113.11');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('登入失敗');
    expect(await page('/settings/logs')).not.toContain('WRONG-PASS-VALUE');
  });

  it('超過次數被擋下的嘗試記成登入被擋', async () => {
    for (let i = 0; i < 5; i++) await loginFrom('203.0.113.12', 'wrong');
    expect((await loginFrom('203.0.113.12', GATEWAY_PASS)).status).toBe(429);
    const rows = await eventRows('203.0.113.12');
    expect(rows.filter((row) => row.includes('登入失敗'))).toHaveLength(5);
    expect(rows.filter((row) => row.includes('登入被擋'))).toHaveLength(1);
  });

  it('User-Agent 以文字顯示，不會變成頁面的標記', async () => {
    await loginFrom('203.0.113.13', 'wrong', '<script>alert(1)</script>');
    const [row] = await eventRows('203.0.113.13');
    expect(row).not.toContain('<script>alert(1)');
    expect(row).toContain('&lt;script&gt;');
  });

  it('登出記一筆', async () => {
    const res = await loginFrom('203.0.113.14', GATEWAY_PASS);
    const session = res.headers.get('Set-Cookie')!.split(';')[0];
    const csrf = csrfOf(await (await gw('/settings', { headers: { Cookie: session } })).text());
    const out = await gw('/logout', { method: 'POST', headers: { Cookie: session, 'CF-Connecting-IP': '203.0.113.14' }, body: form({ csrf }) });
    expect(out.status).toBe(302);
    expect((await eventRows('203.0.113.14')).some((row) => row.includes('登出'))).toBe(true);
  });

  it('超過 30 天的紀錄在下一次寫入後消失', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 31 * DAY);
    await loginFrom('203.0.113.15', 'wrong');
    vi.useRealTimers();
    expect(await eventRows('203.0.113.15')).toHaveLength(1);

    await loginFrom('203.0.113.16', 'wrong');
    expect(await eventRows('203.0.113.16')).toHaveLength(1);
    expect(await eventRows('203.0.113.15')).toHaveLength(0);
  });
});

describe('授權的紀錄', () => {
  it('同意授權記下 client 與勾選的範圍', async () => {
    const grant = await authorize(['notes:read', 'notes:write'], '事件同意 client');
    const rows = (await eventRows(grant.clientId)).filter((row) => row.includes('同意授權'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('事件同意 client');
    expect(rows[0]).toContain('notes:read');
    expect(rows[0]).toContain('notes:write');
    expect(rows[0]).not.toContain('notes:fetch');
  });

  it('拒絕授權記一筆', async () => {
    const clientId = await registerClient('事件拒絕 client');
    const path = authorizePath(clientId, (await pkce()).challenge);
    const html = await page(path);
    const res = await consent(path, cookie, { csrf: csrfOf(html), action: 'deny' });
    expect(res.status).toBe(302);
    const rows = await eventRows(clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('拒絕授權');
    expect(rows[0]).toContain('事件拒絕 client');
  });

  it('撤銷授權記一筆，撤銷後仍看得到 client 名稱', async () => {
    const grant = await authorize(['notes:read'], '事件撤銷 client');
    const settings = await page('/settings');
    const item = settings.split('<section').find((i) => i.includes(grant.clientId))!;
    const id = item.match(/name="grant" value="([^"]+)"/)![1];
    const res = await gw('/settings/revoke', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf: csrfOf(settings), grant: id }) });
    expect(res.status).toBe(302);
    const rows = (await eventRows(grant.clientId)).filter((row) => row.includes('撤銷授權'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('事件撤銷 client');
  });

  it('CSRF token 不對的撤銷沒有執行，也不記成撤銷', async () => {
    const grant = await authorize(['notes:read'], '事件未撤銷 client');
    const settings = await page('/settings');
    const item = settings.split('<section').find((i) => i.includes(grant.clientId))!;
    const id = item.match(/name="grant" value="([^"]+)"/)![1];
    await gw('/settings/revoke', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf: 'wrong', grant: id }) });
    expect((await eventRows(grant.clientId)).some((row) => row.includes('撤銷授權'))).toBe(false);
  });
});
