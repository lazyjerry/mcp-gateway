// 記住同意頁的勾選：重新授權時，上次列過的範圍照上次勾選，上次沒列過的範圍照服務的預設。從同意頁與設定頁觀察
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizePath, csrfOf, form, gw, login, pkce, registerClient } from './helpers/oauth';

let cookie: string;

beforeAll(async () => {
  cookie = (await login())!;
});

async function page(path: string): Promise<string> {
  const res = await gw(path, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return res.text();
}

/** 同意頁每個範圍是否預先勾選 */
async function boxes(clientId: string): Promise<Record<string, boolean>> {
  const html = await page(authorizePath(clientId, (await pkce()).challenge));
  return Object.fromEntries([...html.matchAll(/name="scope" value="([^"]+)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]));
}

/** 在同意頁按下同意或拒絕；headers 會一起送出 */
async function answer(clientId: string, action: 'approve' | 'deny', scopes: string[], headers: Record<string, string> = {}): Promise<void> {
  const path = authorizePath(clientId, (await pkce()).challenge);
  const csrf = csrfOf(await page(path));
  const res = await gw(path, { method: 'POST', headers: { Cookie: cookie, ...headers }, body: form({ csrf, action, scope: scopes }) });
  expect(res.status).toBe(302);
}

/** 設定頁「記住的勾選」裡屬於某個 client 的區塊 */
async function remembered(clientId: string): Promise<string | undefined> {
  const html = await page('/settings');
  return html.split('<form').find((item) => item.includes('/settings/forget') && item.includes(`value="${clientId}"`));
}

async function revokeAll(clientId: string): Promise<void> {
  const html = await page('/settings');
  for (const item of html.split('<section').filter((i) => i.includes(clientId))) {
    const grant = item.match(/name="grant" value="([^"]+)"/)?.[1];
    if (grant) await gw('/settings/revoke', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf: csrfOf(html), grant }) });
  }
}

function forget(fields: Record<string, string>) {
  return gw('/settings/forget', { method: 'POST', headers: { Cookie: cookie }, body: form(fields) });
}

const DEFAULTS = { 'notes:read': true, 'notes:write': false, 'rogue:read': false };

describe('記住同意頁的勾選', () => {
  it('撤銷後重新授權，同意頁照上次的勾選，不照預設', async () => {
    const clientId = await registerClient('記住勾選 client');
    expect(await boxes(clientId)).toEqual(DEFAULTS);
    await answer(clientId, 'approve', ['notes:write']);
    await revokeAll(clientId);
    expect(await boxes(clientId)).toEqual({ 'notes:read': false, 'notes:write': true, 'rogue:read': false });
  });

  it('上次同意頁沒列出的範圍照服務的預設', async () => {
    const clientId = await registerClient('新服務 client');
    const all = env.SERVICES;
    env.SERVICES = 'ROGUE';
    try {
      await answer(clientId, 'approve', ['rogue:read']);
    } finally {
      env.SERVICES = all;
    }
    expect(await boxes(clientId)).toEqual({ 'notes:read': true, 'notes:write': false, 'rogue:read': true });
  });

  it('拒絕不改記住的勾選', async () => {
    const clientId = await registerClient('拒絕 client');
    await answer(clientId, 'approve', ['notes:write']);
    await answer(clientId, 'deny', ['notes:read']);
    expect(await boxes(clientId)).toEqual({ 'notes:read': false, 'notes:write': true, 'rogue:read': false });
  });

  it('設定頁列出記住的勾選與最近一次同意的來源 IP、User-Agent', async () => {
    const clientId = await registerClient('來源 client');
    await answer(clientId, 'approve', ['notes:read'], { 'CF-Connecting-IP': '203.0.113.77', 'User-Agent': 'ConsentProbe/1.0' });
    const item = await remembered(clientId);
    expect(item).toBeDefined();
    const html = await page('/settings');
    const section = html.split('<section').find((s) => s.includes('remembered-title'))!;
    expect(section).toContain('來源 client');
    expect(section).toContain('203.0.113.77');
    expect(section).toContain('ConsentProbe/1.0');
  });

  it('清除記住的勾選後，同意頁回到預設，設定頁不再列出', async () => {
    const clientId = await registerClient('清除 client');
    await answer(clientId, 'approve', ['notes:write']);
    const csrf = csrfOf(await page('/settings'));
    expect((await forget({ csrf, client: clientId })).status).toBe(302);
    expect(await remembered(clientId)).toBeUndefined();
    expect(await boxes(clientId)).toEqual(DEFAULTS);
  });

  it('清除表單沒帶正確的 CSRF token 時拒絕', async () => {
    const clientId = await registerClient('不該被清除 client');
    await answer(clientId, 'approve', ['notes:write']);
    expect((await forget({ csrf: 'wrong', client: clientId })).status).toBe(403);
    expect(await remembered(clientId)).toBeDefined();
  });
});
