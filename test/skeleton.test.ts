import { exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const ORIGIN = 'http://localhost';

it('GET / 回 200 或導向登入頁', async () => {
  const res = await exports.default.fetch(`${ORIGIN}/`, { redirect: 'manual' });
  expect([200, 302]).toContain(res.status);
});

it('POST /mcp 不帶 token 回 401', async () => {
  const res = await exports.default.fetch(`${ORIGIN}/mcp`, { method: 'POST' });
  expect(res.status).toBe(401);
});
