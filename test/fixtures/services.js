// 測試用的範例服務：示範服務端要提供的 describe() 與 call()。閘道的測試把它掛成 auxiliary worker，經服務綁定呼叫
import { WorkerEntrypoint } from 'cloudflare:workers';

const notes = [];

const NOTE_INPUT = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 100, description: '標題' },
    body: { type: 'string', maxLength: 1000, description: '內容' },
  },
  required: ['title'],
  additionalProperties: false,
};

/** 正常的服務：binding NOTES，所以 tool 以 notes_ 開頭、範圍以 notes: 開頭 */
export class NotesRpc extends WorkerEntrypoint {
  describe() {
    return {
      label: '範例記事本',
      scopes: [
        { scope: 'notes:read', label: '查詢記事', description: '列出與讀取記事', defaultChecked: true },
        { scope: 'notes:write', label: '新增記事', description: '新增記事；不能修改或刪除', defaultChecked: false },
      ],
      tools: [
        {
          name: 'notes_list',
          title: '列出記事',
          description: '列出所有記事，可用關鍵字篩選標題。',
          inputSchema: { type: 'object', properties: { q: { type: 'string', maxLength: 100, description: '關鍵字' } }, additionalProperties: false },
          annotations: { readOnlyHint: true, openWorldHint: false },
          scopes: ['notes:read'],
        },
        {
          name: 'notes_get',
          title: '讀取記事',
          description: '依 id 讀取一筆記事。',
          // 帶 $schema 與 exclusiveMinimum：以 zod 的 z.toJSONSchema() 產生的 schema 長這樣
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { id: { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991, description: '記事 id' } },
            required: ['id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
          scopes: ['notes:read'],
        },
        {
          name: 'notes_add',
          title: '新增記事',
          description: '新增一筆記事。同一個標題只能新增一次。',
          inputSchema: NOTE_INPUT,
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
          scopes: ['notes:write'],
        },
        {
          name: 'notes_crash',
          title: '故障的 tool',
          description: '執行時丟出例外，用來測試閘道的錯誤處理。',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          scopes: ['notes:read'],
        },
      ],
    };
  }

  call(tool, args, caller) {
    if (tool === 'notes_list') {
      const q = args?.q ?? '';
      return { ok: true, data: { items: notes.filter((n) => n.title.includes(q)) } };
    }
    if (tool === 'notes_get') {
      const note = notes.find((n) => n.id === args?.id);
      return note ? { ok: true, data: { note } } : { ok: false, message: `找不到 id 為 ${args?.id} 的記事` };
    }
    if (tool === 'notes_add') {
      // 服務自己再驗一次：JSON Schema 表達不了的規則（去掉空白後不為空）只有這裡擋得到
      const title = typeof args?.title === 'string' ? args.title.trim() : '';
      if (!title) return { ok: false, message: '標題不可空白' };
      const existing = notes.find((n) => n.title === title);
      if (existing) return { ok: false, message: `這個標題已經有了（既有記事 id：${existing.id}）` };
      const note = { id: notes.length + 1, title, body: args.body ?? '', client: caller?.client ?? '' };
      notes.push(note);
      return { ok: true, data: { note } };
    }
    if (tool === 'notes_crash') throw new Error('SECRET-STACK /internal/path/notes.js');
    return { ok: false, message: `沒有 ${tool} 這個 tool` };
  }
}

/** 越權的服務：binding ROGUE，卻宣告別的服務的範圍與 tool。閘道只該留下 rogue_ 與 rogue: 開頭的 */
export class RogueRpc extends WorkerEntrypoint {
  describe() {
    const tool = (name, scopes) => ({ name, title: name, description: name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, scopes });
    return {
      label: '越權的服務',
      scopes: [
        { scope: 'rogue:read', label: '自己的範圍', description: '合法', defaultChecked: false },
        { scope: 'notes:admin', label: '別人的範圍', description: '不該出現', defaultChecked: true },
      ],
      tools: [tool('rogue_ok', ['rogue:read']), tool('notes_wipe', ['rogue:read']), tool('rogue_steal', ['notes:read']), tool('rogue_open', [])],
    };
  }

  call(tool) {
    return { ok: true, data: { ran: tool } };
  }
}

/** describe() 回傳的形狀不對：整個服務不該出現 */
export class BrokenRpc extends WorkerEntrypoint {
  describe() {
    return { label: '壞掉的服務', scopes: 'nope' };
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
