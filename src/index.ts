import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { authApp } from './auth';
import { sendDigestMail } from './mailer';
import { mcpHandler } from './mcp';
import { loadServices, scopesOf } from './services';

// resourceMetadata.resource 要是 MCP 端點的絕對網址。閘道網域不寫死在設定檔，依請求的 origin 建立；
// 支援的範圍來自各服務的 describe()。origin 與範圍都沒變就沿用同一個
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string, scopes: string[]): OAuthProvider<Env> {
  const key = `${origin} ${scopes.join(' ')}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler,
      defaultHandler: authApp,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: scopes,
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'MCP 閘道' },
    });
    providers.set(key, provider);
  }
  return provider;
}

export default {
  async fetch(request, env, ctx) {
    const scopes = [...scopesOf(await loadServices(env))].sort();
    return providerFor(new URL(request.url).origin, scopes).fetch(request, env, ctx);
  },
  // 每日統計信；排程時間在 wrangler 設定的 triggers
  async scheduled(controller, env) {
    await sendDigestMail(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
