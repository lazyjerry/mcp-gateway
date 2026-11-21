// 每日統計信：過去 24 小時有登入失敗、登出、拒絕授權才寄，由排程觸發
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfOf, form, gw, GATEWAY_PASS } from './helpers/oauth';

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const DAY = 86_400_000;
const send = vi.spyOn(env.EMAIL, 'send').mockResolvedValue({ messageId: 'test-id' } as never);

beforeEach(() => {
  vi.useRealTimers();
  send.mockClear();
});

function digests(): Sent[] {
  return send.mock.calls.map(([message]) => message as unknown as Sent).filter((m) => m.subject.includes('每日'));
}

/** 觸發排程。exports.default 的型別只列出 fetch，執行時有 scheduled */
function runSchedule() {
  const worker = exports.default as unknown as { scheduled(options: { scheduledTime: Date; cron: string }): Promise<unknown> };
  return worker.scheduled({ scheduledTime: new Date(), cron: '0 0 * * *' });
}

function loginFrom(ip: string, password: string) {
  return gw('/login', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: form({ password, next: '/settings' }) });
}

describe('每日統計信', () => {
  it('只有登入成功這類已即時通知的事件時不寄', async () => {
    await loginFrom('192.0.2.10', GATEWAY_PASS);
    await runSchedule();
    expect(digests()).toHaveLength(0);
  });

  it('超過 24 小時的事件不算', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 2 * DAY);
    await loginFrom('192.0.2.11', 'wrong');
    vi.useRealTimers();
    await runSchedule();
    expect(digests()).toHaveLength(0);
  });

  it('有登入失敗與登出時寄一封，列出各事件次數與登入失敗的來源', async () => {
    await loginFrom('192.0.2.20', 'wrong');
    await loginFrom('192.0.2.20', 'wrong');
    await loginFrom('192.0.2.21', 'wrong');
    const res = await loginFrom('192.0.2.22', GATEWAY_PASS);
    const cookie = res.headers.get('Set-Cookie')!.split(';')[0];
    const csrf = csrfOf(await (await gw('/settings', { headers: { Cookie: cookie } })).text());
    await gw('/logout', { method: 'POST', headers: { Cookie: cookie }, body: form({ csrf }) });
    send.mockClear();

    await runSchedule();
    const [mail] = digests();
    expect(digests()).toHaveLength(1);
    expect(mail.to).toBe('owner@mail.test');
    expect(mail.text).toContain('登入失敗：3');
    expect(mail.text).toContain('登出：1');
    expect(mail.text).toContain('拒絕授權：0');
    expect(mail.text).toContain('192.0.2.20：2');
    expect(mail.text).toContain('192.0.2.21：1');
    expect(mail.html).toContain('192.0.2.20');
  });
});
