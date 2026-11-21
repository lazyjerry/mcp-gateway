// 稽核紀錄與授權管理：紀錄一律從設定頁觀察，不在測試裡直接查 D1
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authorize, csrfOf, form, gw, type Grant } from './helpers/oauth';
import { callTool, listTools } from './helpers/mcp';
import { TOOL_LIMIT } from '../src/throttle';

const READ = ['notes:read'];
const READ_WRITE = ['notes:read', 'notes:write'];
const DAY = 86_400_000;

let reader: Grant;
let writer: Grant;

beforeAll(async () => {
  reader = await authorize(READ, '只讀 client');
  writer = await authorize(READ_WRITE, '讀寫 client');
});

afterEach(() => {
  vi.useRealTimers();
});

async function page(path: string, cookie: string): Promise<string> {
  const res = await gw(path, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return res.text();
}

/** 紀錄頁裡屬於某個 client 的列（每列是一個 <tr>） */
async function logRows(clientId: string): Promise<string[]> {
  const html = await page('/settings/logs', writer.cookie);
  return html.split('<tr').filter((row) => row.includes(clientId));
}

/** 寫入在背景進行，等它出現在紀錄頁 */
async function expectLogged(clientId: string, tool: string, status: string) {
  await vi.waitFor(async () => {
    const rows = await logRows(clientId);
    expect(rows.some((row) => row.includes(tool) && row.includes(`>${status}<`))).toBe(true);
  });
}

describe('設定頁', () => {
  it('切片 1：未登入 GET /settings 導向登入頁', async () => {
    const res = await gw('/settings');
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location')!, 'http://localhost').pathname).toBe('/login');
  });

  it('切片 2：登入後列出已授權的 client 名稱與範圍', async () => {
    const html = await page('/settings', writer.cookie);
    const readerItem = html.split('<section').find((item) => item.includes(reader.clientId))!;
    expect(readerItem).toContain('只讀 client');
    expect(readerItem).toContain('notes:read');
    expect(readerItem).not.toContain('notes:write');
    const writerItem = html.split('<section').find((item) => item.includes(writer.clientId))!;
    expect(writerItem).toContain('讀寫 client');
    expect(writerItem).toContain('notes:write');
  });
});

describe('稽核紀錄', () => {
  it('切片 3：tools/call 成功後，紀錄頁出現該 client、該 tool、ok', async () => {
    const { result } = await callTool(reader.token, 'notes_list');
    expect(result?.isError).toBeFalsy();
    await expectLogged(reader.clientId, 'notes_list', 'ok');
  });

  it('切片 4：被範圍擋下的呼叫也有紀錄，狀態 forbidden', async () => {
    // 沒列出的 tool（在入口被擋）
    expect((await callTool(reader.token, 'notes_add', { title: '只讀' })).result?.isError).toBe(true);
    await expectLogged(reader.clientId, 'notes_add', 'forbidden');
  });

  it('切片 5：紀錄不含參數內容', async () => {
    const { result } = await callTool(writer.token, 'notes_add', { title: '有內容', body: 'SECRET-NOTE' });
    expect(result?.isError).toBeFalsy();
    await expectLogged(writer.clientId, 'notes_add', 'ok');
    expect(await page('/settings/logs', writer.cookie)).not.toContain('SECRET-NOTE');
  });

  it('切片 6：超過 30 天的紀錄在下一次寫入後消失', async () => {
    const old = await authorize(READ, '舊紀錄 client');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 31 * DAY);
    await callTool(old.token, 'notes_list');
    vi.useRealTimers();
    await expectLogged(old.clientId, 'notes_list', 'ok');

    await callTool(old.token, 'notes_get', { id: 999999 });
    await expectLogged(old.clientId, 'notes_get', 'error');
    await vi.waitFor(async () => {
      expect((await logRows(old.clientId)).some((row) => row.includes('notes_list'))).toBe(false);
    });
  });

  it('批次 JSON-RPC 裡被範圍擋下的 tools/call 不執行，也留下 forbidden 紀錄', async () => {
    const batch = await authorize(READ, '批次 client');
    const res = await gw('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${batch.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_add', arguments: { title: '批次' } } }]),
    });
    expect(await res.text()).not.toContain('"note"');
    await expectLogged(batch.clientId, 'notes_add', 'forbidden');
  });
});

describe('頻率限制的稽核紀錄', () => {
  it('被頻率限制擋下的呼叫記成 throttled', async () => {
    const fast = await authorize(READ_WRITE, '太快 client');
    TOOL_LIMIT.intervalMs = 3000;
    try {
      await callTool(fast.token, 'notes_add', { title: '第一筆' });
      expect((await callTool(fast.token, 'notes_add', { title: '第二筆' })).result?.isError).toBe(true);
    } finally {
      TOOL_LIMIT.intervalMs = 0;
    }
    await expectLogged(fast.clientId, 'notes_add', 'throttled');
  });
});

describe('撤銷授權', () => {
  async function revokeForm(clientId: string): Promise<{ csrf: string; grant: string }> {
    const html = await page('/settings', writer.cookie);
    const item = html.split('<section').find((i) => i.includes(clientId));
    const grant = item?.match(/name="grant" value="([^"]+)"/)?.[1];
    if (!grant) throw new Error('找不到撤銷表單');
    return { csrf: csrfOf(html), grant };
  }

  function revoke(fields: Record<string, string>) {
    return gw('/settings/revoke', { method: 'POST', headers: { Cookie: writer.cookie }, body: form(fields) });
  }

  function mcpStatus(token: string) {
    return gw('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }).then((res) => res.status);
  }

  it('切片 8：撤銷表單沒帶正確的 CSRF token 時拒絕', async () => {
    const target = await authorize(READ, '不該被撤銷');
    const { grant } = await revokeForm(target.clientId);
    expect((await revoke({ csrf: 'wrong', grant })).status).toBe(403);
    expect((await revoke({ grant })).status).toBe(403);
    expect(await mcpStatus(target.token)).toBe(200);
  });

  it('切片 7：撤銷某個 client 後它的 token 回 401，另一個 client 照常可用', async () => {
    const victim = await authorize(READ, '要撤銷的 client');
    const fields = await revokeForm(victim.clientId);
    const res = await revoke(fields);
    expect(res.status).toBe(302);
    expect(await mcpStatus(victim.token)).toBe(401);
    expect((await listTools(reader.token)).length).toBeGreaterThan(0);
    const html = await page('/settings', writer.cookie);
    expect(html).not.toContain(victim.clientId);
  });
});
