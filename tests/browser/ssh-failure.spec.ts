import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

for (const signal of ['error-message', 'close-code', 'reconnect-close-code']) {
  test(`SSH deterministic failure stops automatic reconnect: ${signal}`, async ({ page }) => {
    await fileFixture(page);
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket('**/api/ssh?*', (ws) => {
      sockets.push(ws);
      ws.onMessage((raw) => {
        if (typeof raw !== 'string' || JSON.parse(raw).type !== 'connect') return;
        ws.send(JSON.stringify({ type: 'ready' }));
      });
    });
    await connectFiles(page);
    await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
    if (signal === 'reconnect-close-code') {
      sockets[0].close({ code: 1011, reason: 'Transport interrupted' });
      await expect.poll(() => sockets.length).toBe(2);
      await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
    }
    const active = sockets.at(-1)!;
    if (signal === 'error-message') {
      active.send(JSON.stringify({ type: 'error', message: 'SSH authentication failed', retryable: false }));
    } else {
      active.close({ code: 4001, reason: 'SSH session failed' });
    }
    await expect(page.locator('#files-connect')).toBeEnabled();
    await expect(page.locator('#files-connection-state')).not.toHaveText('SSH 已连接');
    const count = sockets.length;
    // 首次自动重连延迟为 1 秒，跨过该期限核验不再使用失败凭据。
    await page.waitForTimeout(1400);
    expect(sockets.length).toBe(count);
    await page.locator('#files-connect').click();
    await expect.poll(() => sockets.length).toBe(count + 1);
    await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  });
}

test('initial SSH connection failure before ready never triggers auto-reconnect and reveals event log in workspace', async ({ page }) => {
  await fileFixture(page);
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    sockets.push(ws);
    ws.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).type !== 'connect') return;
      ws.send(JSON.stringify({ type: 'error', message: 'Cloudflare Tunnel WebSocket handshake failed (HTTP 502)' }));
      ws.close({ code: 1011, reason: 'SSH session failed' });
    });
  });
  await connectFiles(page);
  await expect(page.locator('#files-connect')).toBeEnabled();
  await expect(page.locator('#files-connection-state')).not.toHaveText('SSH 已连接');
  await page.waitForTimeout(1400);
  expect(sockets.length).toBe(1);
  await page.locator('#rail-terminal').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'terminal');
  await expect(page.locator('#event-log')).toContainText('Cloudflare Tunnel WebSocket handshake failed (HTTP 502)');
  // 日志是终局面板内的折叠区块：失败时自动展开，也可用工具栏开关手动控制。
  await expect(page.locator('#event-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#event-log-close')).toBeVisible();
  // 失败时连接抽屉会自动收起，这里直接操作日志浮层即可。
  // 关闭按钮收起日志，工具栏开关可再次展开，Esc 也能收起。
  await page.locator('#event-log-close').click();
  await expect(page.locator('#event-log-container')).toBeHidden();
  await expect(page.locator('#event-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#event-toggle').click();
  await expect(page.locator('#event-log-container')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#event-log-container')).toBeHidden();
});
