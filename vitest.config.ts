import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// 閘道測試接 repo 內的範例服務（test/fixtures/services.js），掛成 auxiliary worker，經服務綁定走真的 RPC。
// 設定讀 wrangler.example.jsonc：測試不依賴本機的 wrangler.jsonc，也不依賴任何實際串接的服務
const FIXTURE = 'test/fixtures/services.js';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.example.jsonc' },
        remoteBindings: false,
        miniflare: {
          bindings: {
            GATEWAY_PASS: 'test-gateway-pass',
            MAIL_FROM: 'gateway@mail.test',
            MAIL_TO: 'owner@mail.test',
            TEST_MIGRATIONS: migrations,
            // NOTES 正常、ROGUE 越權、BROKEN 形狀不對、MISSING 沒有對應的 binding、lower 不是合法的 binding 名稱
            SERVICES: 'NOTES, ROGUE,BROKEN,MISSING,lower',
          },
          serviceBindings: {
            NOTES: { name: 'fixture-services', entrypoint: 'NotesRpc' },
            ROGUE: { name: 'fixture-services', entrypoint: 'RogueRpc' },
            BROKEN: { name: 'fixture-services', entrypoint: 'BrokenRpc' },
          },
          workers: [
            {
              name: 'fixture-services',
              // 直接給內容與 ASCII 的 module 名稱：以路徑載入時 module 名稱含工作目錄，目錄有中文 workerd 會載入失敗
              modules: [{ type: 'ESModule', path: 'services.js', contents: readFileSync(FIXTURE, 'utf8') }],
              compatibilityDate: '2026-10-19',
            },
          ],
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
