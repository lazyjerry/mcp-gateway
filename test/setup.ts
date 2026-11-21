import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { TOOL_LIMIT } from '../src/throttle';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// tool 的頻率限制預設關閉：測試會連續呼叫。要測限制的測試自己打開
TOOL_LIMIT.intervalMs = 0;
