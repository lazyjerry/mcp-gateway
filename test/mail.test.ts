// 通知信：登入成功、同意授權、撤銷授權每次寄；登入被擋每個來源每個時間窗寄一次；登入失敗、登出、拒絕授權不即時寄。
// 寄信的 binding 換成 spy，其餘照常從登入、同意頁、設定頁進入
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorize, authorizePath, consent, csrfOf, form, gw, GATEWAY_PASS, login, pkce, registerClient } from './helpers/oauth';

interface Sent {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  html: string;
}

const send = vi.spyOn(env.EMAIL, 'send').mockResolvedValue({ messageId: 'test-id' } as never);

beforeEach(() => {
  send.mockClear();
});

function sent(): Sent[] {
  return send.mock.calls.map(([message]) => message as unknown as Sent);
}

/** 信在背景寄出，等到符合條件的那封出現 */
async function mailWith(marker: string): Promise<Sent> {
  return vi.waitFor(() => {
    const mail = sent().find((m) => m.text.includes(marker));
    if (!mail) throw new Error(`還沒有含「${marker}」的信`);
    return mail;
  });
}

/** 給背景工作一點時間，確認沒有信寄出 */
async function expectNoMailWith(marker: string) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sent().some((m) => m.text.includes(marker))).toBe(false);
}

function loginFrom(ip: string, password: string, userAgent = 'mail-test-agent') {
  return gw('/login', { method: 'POST', headers: { 'CF-Connecting-IP': ip, 'User-Agent': userAgent }, body: form({ password, next: '/settings' }) });
}

describe('即時通知信', () => {
  it('登入成功寄一封，寄件與收件照設定，內容有來源 IP 與 User-Agent', async () => {
    await loginFrom('198.51.100.10', GATEWAY_PASS, 'ua-mail-login');
    const mail = await mailWith('198.51.100.10');
    expect(mail.from.email).toBe('gateway@mail.test');
    expect(mail.to).toBe('owner@mail.test');
    expect(mail.subject).toContain('登入成功');
    expect(mail.text).toContain('ua-mail-login');
    expect(mail.html).toContain('198.51.100.10');
  });

  it('User-Agent 在 HTML 信裡是文字，不是標記', async () => {
    await loginFrom('198.51.100.11', GATEWAY_PASS, '<img src=x onerror=1>');
    const mail = await mailWith('198.51.100.11');
    expect(mail.html).not.toContain('<img src=x');
  });

  it('登入失敗不即時寄信', async () => {
    await loginFrom('198.51.100.12', 'wrong');
    await expectNoMailWith('198.51.100.12');
  });

  it('登入被擋：同一個來源在時間窗內只寄一封', async () => {
    for (let i = 0; i < 5; i++) await loginFrom('198.51.100.13', 'wrong');
    await loginFrom('198.51.100.13', 'wrong');
    await loginFrom('198.51.100.13', 'wrong');
    const mail = await mailWith('198.51.100.13');
    expect(mail.subject).toContain('登入被擋');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent().filter((m) => m.text.includes('198.51.100.13'))).toHaveLength(1);
  });

  it('同意授權寄一封，內容有 client 與範圍', async () => {
    const grant = await authorize(['notes:read'], '信件同意 client');
    const mail = await vi.waitFor(() => {
      const found = sent().find((m) => m.subject.includes('同意授權') && m.text.includes(grant.clientId));
      if (!found) throw new Error('還沒有同意授權的信');
      return found;
    });
    expect(mail.text).toContain('信件同意 client');
    expect(mail.text).toContain('notes:read');
  });

  it('撤銷授權寄一封；拒絕授權與登出不即時寄', async () => {
    const grant = await authorize(['notes:read'], '信件撤銷 client');
    const settings = await (await gw('/settings', { headers: { Cookie: grant.cookie } })).text();
    const item = settings.split('<section').find((i) => i.includes(grant.clientId))!;
    const id = item.match(/name="grant" value="([^"]+)"/)![1];
    await gw('/settings/revoke', { method: 'POST', headers: { Cookie: grant.cookie }, body: form({ csrf: csrfOf(settings), grant: id }) });
    await vi.waitFor(() => {
      expect(sent().some((m) => m.subject.includes('撤銷授權') && m.text.includes(grant.clientId))).toBe(true);
    });

    const cookie = (await login())!;
    send.mockClear();
    const clientId = await registerClient('信件拒絕 client');
    const path = authorizePath(clientId, (await pkce()).challenge);
    const page = await (await gw(path, { headers: { Cookie: cookie } })).text();
    await consent(path, cookie, { csrf: csrfOf(page), action: 'deny' });
    await gw('/logout', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf: csrfOf(page) }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent()).toHaveLength(0);
  });

  it('寄信失敗不影響登入', async () => {
    send.mockRejectedValueOnce(new Error('destination address not verified'));
    expect((await loginFrom('198.51.100.14', GATEWAY_PASS)).status).toBe(302);
  });
});
