import { defineConfig } from '@playwright/test';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  // 文件管理相关用例共享同一个 SFTP 模拟通道，并行时上传完成的目录刷新
  // 会因 dev server 冷启动而超时；限制单文件执行，保持确定性。
  workers: process.env.CI ? 2 : 1,
  // GitHub runners give the suite two cores and a cold Vite dev server; the
  // shared file-manager tests then exceed the 30s default on occasional runs.
  timeout: ci ? 90_000 : 30_000,
  expect: { timeout: ci ? 10_000 : 5_000 },
  retries: ci ? 2 : 0,
  reporter: ci ? [['github'], ['line']] : [['line']],
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL,
    baseURL: 'http://127.0.0.1:5173',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'npm run dev:web -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !ci,
    // First Vite start also pre-bundles React/xterm; give CI room before the suite races it.
    timeout: ci ? 180_000 : 60_000,
  },
});
