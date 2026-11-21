import { describe, expect, it } from 'vitest';
import { authorize, authorizePath, consent, csrfOf, exchangeCode, gw, login, pkce, REDIRECT_URI, registerClient } from './helpers/oauth';

describe('OAuth metadata 與註冊', () => {
  it('GET /.well-known/oauth-authorization-server 回 metadata', async () => {
    const res = await gw('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, string>;
    expect(meta.authorization_endpoint).toBe('http://localhost/authorize');
    expect(meta.token_endpoint).toBe('http://localhost/token');
    expect(meta.registration_endpoint).toBe('http://localhost/register');
  });

  it('metadata 列出支援的授權範圍', async () => {
    const metadata = (await (await gw('/.well-known/oauth-authorization-server')).json()) as { scopes_supported?: string[] };
    expect(metadata.scopes_supported?.sort()).toEqual(['notes:read', 'notes:write', 'rogue:read']);
  });

  it('POST /mcp 不帶 token 回 401，WWW-Authenticate 指向 resource metadata', async () => {
    const res = await gw('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata="http://localhost/.well-known/oauth-protected-resource');
  });

  it('POST /register 動態註冊回 client_id', async () => {
    expect(await registerClient()).toMatch(/.+/);
  });
});

describe('登入', () => {
  it('GET /authorize 未登入時顯示登入頁，不發 code', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const res = await gw(authorizePath(clientId, challenge));
    expect(res.status).toBe(200);
    expect(res.headers.get('Location')).toBeNull();
    const html = await res.text();
    expect(html).toContain('name="password"');
    expect(html).not.toContain('name="csrf"');
  });
});

describe('登入與同意頁', () => {
  it('錯誤密碼登入失敗，不發 Session', async () => {
    const res = await gw('/login', { method: 'POST', body: new URLSearchParams({ password: 'wrong', next: '/settings' }) });
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('正確密碼登入後顯示同意頁：client 名稱與各服務宣告的範圍，預設勾選照服務的宣告', async () => {
    const clientId = await registerClient('同意頁測試 client');
    const { challenge } = await pkce();
    const path = authorizePath(clientId, challenge);
    const cookie = await login(undefined, path);
    expect(cookie).not.toBeNull();
    const html = await (await gw(path, { headers: { Cookie: cookie! } })).text();
    expect(html).toContain('同意頁測試 client');
    const boxes = [...html.matchAll(/<input type="checkbox" id="[^"]+" name="scope" value="([^"]+)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]);
    expect(boxes).toEqual([
      ['notes:read', true],
      ['notes:write', false],
      ['rogue:read', false],
    ]);
  });

  it('同意表單沒帶正確的 CSRF token 時拒絕', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const path = authorizePath(clientId, challenge);
    const cookie = (await login(undefined, path))!;
    const missing = await consent(path, cookie, { action: 'approve', scope: 'notes:read' });
    const wrong = await consent(path, cookie, { csrf: 'forged', action: 'approve', scope: 'notes:read' });
    for (const res of [missing, wrong]) {
      expect(res.status).toBe(403);
      expect(res.headers.get('Location')).toBeNull();
    }
  });
});

describe('授權碼與 token', () => {
  it('同意後導回 redirect_uri 帶 code，用 code + PKCE verifier 換到 access token', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkce();
    const path = authorizePath(clientId, challenge, 'state-xyz');
    const cookie = (await login(undefined, path))!;
    const csrf = csrfOf(await (await gw(path, { headers: { Cookie: cookie } })).text());
    const res = await consent(path, cookie, { csrf, action: 'approve', scope: 'notes:read' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('state-xyz');
    const token = await exchangeCode(clientId, location.searchParams.get('code')!, verifier);
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; scope: string };
    expect(body.access_token).toMatch(/.+/);
    expect(body.scope).toBe('notes:read');
  });

  it('拒絕授權時導回 redirect_uri 帶 error=access_denied', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const path = authorizePath(clientId, challenge, 'state-deny');
    const cookie = (await login(undefined, path))!;
    const csrf = csrfOf(await (await gw(path, { headers: { Cookie: cookie } })).text());
    const res = await consent(path, cookie, { csrf, action: 'deny' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-deny');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('帶 token 呼叫 /mcp 的 initialize 成功', async () => {
    const { token } = await authorize(['notes:read']);
    const res = await gw('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain('"serverInfo"');
    expect(text).toContain('mcp-gateway');
  });
});
