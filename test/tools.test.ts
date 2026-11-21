// MCP tools 與權限：服務是 repo 內的範例服務（test/fixtures/services.js，auxiliary worker），tool 清單與執行都經服務綁定的 RPC
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_LIMIT } from '../src/throttle';
import { authorize, authorizePath, consent, csrfOf, gw, login, pkce, registerClient } from './helpers/oauth';
import { callTool, listTools } from './helpers/mcp';

const READ = ['notes:read'];
const READ_WRITE = ['notes:read', 'notes:write'];

let readToken: string;
let writeToken: string;
let firstId: number;

beforeAll(async () => {
  readToken = (await authorize(READ)).token;
  writeToken = (await authorize(READ_WRITE)).token;
});

describe('tools/list 來自服務的 describe()，依範圍過濾', () => {
  it('只有 read：剛好列出讀取類的 tool', async () => {
    const names = (await listTools(readToken)).map((t) => t.name).sort();
    expect(names).toEqual(['notes_crash', 'notes_get', 'notes_list']);
  });

  it('read + write：多了 notes_add', async () => {
    const names = (await listTools(writeToken)).map((t) => t.name).sort();
    expect(names).toEqual(['notes_add', 'notes_crash', 'notes_get', 'notes_list']);
  });

  it('title、description、inputSchema、annotations 照服務宣告的內容', async () => {
    const add = (await listTools(writeToken)).find((t) => t.name === 'notes_add');
    expect(add.title).toBe('新增記事');
    expect(add.description).toContain('同一個標題只能新增一次');
    expect(add.inputSchema.required).toEqual(['title']);
    expect(add.inputSchema.properties.title.maxLength).toBe(100);
    expect(add.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    const list = (await listTools(readToken)).find((t) => t.name === 'notes_list');
    expect(list.annotations.readOnlyHint).toBe(true);
  });
});

describe('tools/call 轉給服務的 call()', () => {
  it('notes_add 成功，回應是服務回傳的資料；服務拿得到呼叫者的 client id', async () => {
    const grant = await authorize(READ_WRITE);
    const { result, data } = await callTool(grant.token, 'notes_add', { title: '第一則', body: '內容' });
    expect(result?.isError).toBeFalsy();
    expect(data.note).toMatchObject({ title: '第一則', body: '內容', client: grant.clientId });
    firstId = data.note.id;
  });

  it('notes_list 找得到剛才新增的；notes_get 取回同一筆', async () => {
    const { data } = await callTool(readToken, 'notes_list', { q: '第一' });
    expect(data.items.map((n: any) => n.title)).toEqual(['第一則']);
    expect((await callTool(readToken, 'notes_get', { id: firstId })).data.note.title).toBe('第一則');
  });

  it('服務回 ok: false 時，說明文字成為 tool 錯誤結果，不是協定錯誤', async () => {
    const missing = await callTool(readToken, 'notes_get', { id: 999999 });
    expect(missing.response.error).toBeUndefined();
    expect(missing.result?.isError).toBe(true);
    expect(missing.text).toBe('找不到 id 為 999999 的記事');
    const duplicate = await callTool(writeToken, 'notes_add', { title: '第一則' });
    expect(duplicate.result?.isError).toBe(true);
    expect(duplicate.text).toContain(`既有記事 id：${firstId}`);
  });

  it('JSON Schema 表達不了的規則由服務擋：標題只有空白時回服務的說明，沒有新增', async () => {
    const { result, text } = await callTool(writeToken, 'notes_add', { title: '   ' });
    expect(result?.isError).toBe(true);
    expect(text).toBe('標題不可空白');
  });

  it('服務丟出例外時只回固定說明，不含例外內容', async () => {
    const { response, result, text } = await callTool(readToken, 'notes_crash');
    expect(response.error).toBeUndefined();
    expect(result?.isError).toBe(true);
    expect(text).toBe('服務暫時無法處理這個請求，請稍後再試。');
    expect(text).not.toContain('SECRET-STACK');
  });
});

describe('參數在閘道依服務宣告的 inputSchema 先驗一次', () => {
  it('缺必填、型別不對、超過長度、多帶欄位都回參數錯誤，沒有執行', async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ['notes_add', {}],
      ['notes_add', { title: 123 }],
      ['notes_add', { title: 'x'.repeat(101) }],
      ['notes_add', { title: '多帶欄位', extra: true }],
    ];
    for (const [name, args] of attempts) {
      const { response, result, text } = await callTool(writeToken, name, args);
      const rejected = response.error?.code === -32602 || (result?.isError === true && text.includes('Input validation error'));
      expect(rejected, `${name} ${JSON.stringify(args)}：${JSON.stringify(response)}`).toBe(true);
    }
    expect((await callTool(readToken, 'notes_list', { q: '多帶欄位' })).data.items).toEqual([]);
  });

  it('notes_get 的 id 不是正整數時回參數錯誤', async () => {
    for (const id of [0, -1, 1.5, 'abc']) {
      const { response, result, text } = await callTool(readToken, 'notes_get', { id });
      const rejected = response.error?.code === -32602 || (result?.isError === true && text.includes('Input validation error'));
      expect(rejected, `id=${String(id)}：${JSON.stringify(response)}`).toBe(true);
    }
  });
});

describe('權限在 tools/call 再檢查一次', () => {
  it('只有 read 的 token 直接呼叫 notes_add：被拒，說明缺哪個範圍，沒有新增', async () => {
    const { response, result, text } = await callTool(readToken, 'notes_add', { title: '不該出現' });
    expect(response.error).toBeUndefined();
    expect(result?.isError).toBe(true);
    expect(text).toContain('notes:write');
    expect((await callTool(readToken, 'notes_list', { q: '不該出現' })).data.items).toEqual([]);
  });

  it('服務沒有宣告的 tool：不執行', async () => {
    const { response, result } = await callTool(writeToken, 'notes_delete', { id: firstId });
    expect(response.error !== undefined || result?.isError === true).toBe(true);
    expect((await callTool(readToken, 'notes_get', { id: firstId })).data.note.title).toBe('第一則');
  });
});

describe('服務只能宣告自己名稱開頭的 tool 與範圍', () => {
  let rogueToken: string;
  beforeAll(async () => {
    rogueToken = (await authorize(['rogue:read', ...READ_WRITE])).token;
  });

  it('越權的服務：別的服務名稱開頭的 tool、用到別人範圍的 tool、沒有範圍的 tool 都不列出', async () => {
    const names = (await listTools(rogueToken)).map((t) => t.name).filter((name) => !name.startsWith('notes_') || name === 'notes_wipe');
    expect(names).toEqual(['rogue_ok']);
  });

  it('被丟掉的 tool 直接呼叫也不執行；合法的那個照常執行', async () => {
    for (const name of ['notes_wipe', 'rogue_steal', 'rogue_open']) {
      const { response, result, text } = await callTool(rogueToken, name);
      expect(response.error !== undefined || result?.isError === true, name).toBe(true);
      expect(text, name).not.toContain('ran');
    }
    expect((await callTool(rogueToken, 'rogue_ok')).data).toEqual({ ran: 'rogue_ok' });
  });

  it('metadata 與同意頁只有各服務自己的範圍；形狀不對、沒有 binding、名稱不合法的服務不出現', async () => {
    const metadata = (await (await gw('/.well-known/oauth-authorization-server')).json()) as { scopes_supported?: string[] };
    expect(metadata.scopes_supported?.sort()).toEqual(['notes:read', 'notes:write', 'rogue:read']);
    const clientId = await registerClient();
    const path = authorizePath(clientId, (await pkce()).challenge);
    const cookie = (await login(undefined, path))!;
    const html = await (await gw(path, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('範例記事本');
    expect(html).toContain('越權的服務');
    expect(html).not.toContain('notes:admin');
    expect(html).not.toContain('壞掉的服務');
  });

  it('同意時勾了沒有服務宣告的範圍：不會進到 token', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const path = authorizePath(clientId, challenge);
    const cookie = (await login(undefined, path))!;
    const page = await (await gw(path, { headers: { Cookie: cookie } })).text();
    const res = await consent(path, cookie, { csrf: csrfOf(page), action: 'approve', scope: ['notes:read', 'notes:admin', 'other:read'] });
    expect(res.status).toBe(302);
    const settings = await (await gw('/settings', { headers: { Cookie: cookie } })).text();
    const item = settings.split('<section').find((part) => part.includes(clientId))!;
    expect(item).toContain('notes:read');
    expect(item).not.toContain('notes:admin');
    expect(item).not.toContain('other:read');
  });
});

describe('頻率限制：同一個 client 三秒內只執行一次寫入類 tool', () => {
  beforeEach(() => {
    TOOL_LIMIT.intervalMs = 3000;
  });
  afterEach(() => {
    TOOL_LIMIT.intervalMs = 0;
    vi.useRealTimers();
  });

  it('三秒內的第二次新增不執行，回 tool 錯誤結果請 client 排隊；滿三秒後放行', async () => {
    const { token } = await authorize(READ_WRITE);
    vi.useFakeTimers({ toFake: ['Date'] });
    expect((await callTool(token, 'notes_add', { title: '限流第一筆' })).result?.isError).toBeFalsy();

    const second = await callTool(token, 'notes_add', { title: '限流太快' });
    expect(second.response.error).toBeUndefined();
    expect(second.result?.isError).toBe(true);
    expect(second.text).toContain('排隊');
    expect(second.text).toContain('3 秒');
    expect((await callTool(token, 'notes_list', { q: '限流太快' })).data.items).toEqual([]);

    vi.setSystemTime(Date.now() + 3000);
    expect((await callTool(token, 'notes_add', { title: '限流太快' })).result?.isError).toBeFalsy();
  });

  it('讀取類（服務標了 readOnlyHint）不受限：連續查詢、新增後立刻查詢都執行', async () => {
    const { token } = await authorize(READ_WRITE);
    expect((await callTool(token, 'notes_add', { title: '先新增再查' })).result?.isError).toBeFalsy();
    const calls = [callTool(token, 'notes_list'), callTool(token, 'notes_list', { q: '先' }), callTool(token, 'notes_list')];
    for (const { result } of await Promise.all(calls)) expect(result?.isError).toBeFalsy();
  });

  it('各 client 分開計算', async () => {
    const [a, b] = await Promise.all([authorize(READ_WRITE), authorize(READ_WRITE)]);
    expect((await callTool(a.token, 'notes_add', { title: 'client A' })).result?.isError).toBeFalsy();
    expect((await callTool(b.token, 'notes_add', { title: 'client B' })).result?.isError).toBeFalsy();
  });

  it('同時送出的兩次新增只有一次執行', async () => {
    const { token } = await authorize(READ_WRITE);
    const results = await Promise.all([callTool(token, 'notes_add', { title: '同時 1' }), callTool(token, 'notes_add', { title: '同時 2' })]);
    expect(results.filter((r) => r.result?.isError).length).toBe(1);
  });

  it('參數不合法的新增不佔名額', async () => {
    const { token } = await authorize(READ_WRITE);
    expect((await callTool(token, 'notes_add', {})).result?.isError ?? true).toBe(true);
    expect((await callTool(token, 'notes_add', { title: '照常新增' })).result?.isError).toBeFalsy();
  });
});
