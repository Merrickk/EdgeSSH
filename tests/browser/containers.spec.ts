import { test, expect } from '@playwright/test';
import { fileFixture } from './file-fixture';

test.describe.configure({ mode: 'serial' });

/** 打开独立容器页并连接主机。 */
async function openContainers(page: import('@playwright/test').Page, id = 'alpha') {
  await page.locator('#rail-overview').click();
  await page.locator('#rail-containers').click();
  await expect(page.locator('#containers-heading')).toBeVisible();
  await page.locator('#containers-host').selectOption(id);
  await page.locator('#containers-connect').click();
}

test('容器页入口、连接与列表渲染', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await fileFixture(page);
  await openContainers(page);
  await expect(page.locator('#containers-connection-state')).toHaveText('SSH 已连接');
  // 计数与列表都由快照驱动。
  await expect(page.locator('#container-running-count')).toHaveText('1');
  await expect(page.locator('#container-total-count')).toHaveText('2');
  await expect(page.locator('#container-image-count')).toHaveText('7');
  const rows = page.locator('#container-table-body tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'web-nginx' })).toContainText('nginx:1.25');
  await expect(rows.filter({ hasText: 'web-nginx' })).toContainText('0.05%');
  await expect(rows.filter({ hasText: 'web-nginx' })).toContainText('3.12%');
  await expect(rows.filter({ hasText: 'db-postgres' })).toContainText('已退出');
  // 运行中的容器显示停止/重启，已退出的显示启动。
  await expect(rows.filter({ hasText: 'web-nginx' }).locator('[data-container-action="stop"]')).toBeVisible();
  await expect(rows.filter({ hasText: 'db-postgres' }).locator('[data-container-action="start"]')).toBeVisible();
  await expect(fixture.containerSockets).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('containers-list.png'), fullPage: true });
});

test('容器启停与删除走白名单命令', async ({ page }) => {
  const fixture = await fileFixture(page);
  await openContainers(page);
  await expect(page.locator('#container-table-body tr')).toHaveCount(2);
  await page.locator('#container-table-body tr').filter({ hasText: 'web-nginx' }).locator('[data-container-action="stop"]').click();
  await expect.poll(() => fixture.containerCalls.map((call) => call.action)).toContain('stop');
  expect(fixture.containerCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'stop', target: 'abc123def456' }),
  ]));

  // 删除需要确认，取消则不发送命令。
  await page.locator('#container-table-body tr').filter({ hasText: 'db-postgres' }).locator('[data-container-action="rm"]').click();
  await expect(page.locator('#container-confirm-dialog')).toBeVisible();
  await page.locator('#container-confirm-reject').click();
  await expect(page.locator('#container-confirm-dialog')).toBeHidden();
  expect(fixture.containerCalls.filter((call) => call.action === 'rm')).toHaveLength(0);

  await page.locator('#container-table-body tr').filter({ hasText: 'db-postgres' }).locator('[data-container-action="rm"]').click();
  await page.locator('#container-confirm-accept').click();
  await expect.poll(() => fixture.containerCalls.map((call) => call.action)).toContain('rm');
  expect(fixture.containerCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'rm', target: 'aaa111bbb222' }),
  ]));
});

test('容器日志对话框按行数读取', async ({ page }) => {
  const fixture = await fileFixture(page);
  await openContainers(page);
  await expect(page.locator('#container-table-body tr')).toHaveCount(2);
  await page.locator('#container-table-body tr').filter({ hasText: 'web-nginx' }).locator('[data-container-action="logs"]').click();
  const dialog = page.locator('#container-log-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#container-log-text')).toContainText('GET /');
  await expect(page.locator('#container-log-path')).toHaveText('abc123def456');
  expect(fixture.containerCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'logs', target: 'abc123def456', tail: 200 }),
  ]));

  await page.locator('#container-log-tail').selectOption('500');
  await expect.poll(() => fixture.containerCalls.filter((call) => call.action === 'logs').at(-1)?.tail).toBe(500);
  await page.locator('#container-log-dismiss').click();
  await expect(dialog).toBeHidden();
});

test('总览标签只剩一个，并新增容器标签', async ({ page }) => {
  await fileFixture(page);
  await page.locator('#rail-overview').click();
  // “主机”与“总览”合并，侧边栏不再出现重复入口。
  await expect(page.locator('#rail-hosts')).toHaveCount(0);
  await expect(page.locator('#rail-overview')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#rail-files')).toHaveText('文件');
  await expect(page.locator('#rail-containers')).toHaveText('容器');
  // 总览页仍渲染主机卡片；没有常驻探针，所以不再放长期占位的指标带。
  await expect(page.locator('.host-card').first()).toBeVisible();
  await expect(page.locator('.host-card .host-metric')).toHaveCount(0);
  await expect(page.locator('.host-card').first()).toContainText('Tokyo production');
});
