import { test, expect } from '@playwright/test';
import { fileFixture } from './file-fixture';

test.describe.configure({ mode: 'serial' });

/** 打开统一工作台的容器面板并连接主机。 */
async function openContainers(page: import('@playwright/test').Page, id = 'alpha') {
  await page.locator('#rail-overview').click();
  await page.locator('#rail-containers').click();
  await expect(page.locator('#containers-heading')).toHaveText('容器');
  await expect(page.locator('#rail-containers')).toHaveAttribute('aria-current', 'page');
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
  await expect(page.locator('#container-image-count')).toHaveText('2');
  const rows = page.locator('#container-table-body tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'web-nginx' })).toContainText('nginx:1.25');
  await expect(rows.filter({ hasText: 'web-nginx' })).toContainText('0.05%');
  await expect(rows.filter({ hasText: 'web-nginx' })).toContainText('3.12%');
  await expect(rows.filter({ hasText: 'db-postgres' })).toContainText('已退出');
  // 运行中的容器显示停止/重启/升级，已退出的显示启动/升级。
  await expect(rows.filter({ hasText: 'web-nginx' }).locator('[data-container-action="stop"]')).toBeVisible();
  await expect(rows.filter({ hasText: 'web-nginx' }).locator('[data-container-action="upgrade"]')).toBeVisible();
  await expect(rows.filter({ hasText: 'db-postgres' }).locator('[data-container-action="start"]')).toBeVisible();
  await expect(fixture.containerSockets).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('containers-list.png'), fullPage: true });
});

test('容器升级按 Compose 与镜像名自动选中模式，并支持一键添加到计划任务', async ({ page }) => {
  const fixture = await fileFixture(page, { webImage: 'ghcr.io/acme/web:v2' });
  await openContainers(page);

  const row = page.locator('#container-table-body tr').filter({ hasText: 'web-nginx' });
  await row.locator('[data-container-action="edit"]').click();
  const editDialog = page.locator('#container-edit-dialog');
  await expect(editDialog).toBeVisible();
  await expect(page.locator('#container-edit-command')).toHaveValue(/docker compose/);
  await expect(page.locator('#container-edit-command')).toHaveValue(/compose.yaml/);
  await expect(page.locator('#container-edit-hint')).toContainText('Compose');
  await page.locator('#container-edit-close').click();

  await row.locator('[data-container-action="upgrade"]').click();

  const dialog = page.locator('#container-upgrade-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#container-upgrade-name')).toHaveText('web-nginx');
  await expect(page.locator('#container-upgrade-image')).toHaveText('ghcr.io/acme/web:v2');

  // 无智能推荐单项；Compose 容器且镜像名含 /，自动选中 compose_pull。
  await expect(page.locator('input[name="containerUpgradeMode"][value="auto"]')).toHaveCount(0);
  await expect(page.locator('#container-upgrade-type-badge')).toContainText('镜像更新');
  await expect(page.locator('input[name="containerUpgradeMode"][value="compose_pull"]')).toBeChecked();
  const composePull = "cd '/opt/web-app' && docker compose pull && docker compose up -d";
  await expect(page.locator('#container-upgrade-command')).toHaveValue(composePull);

  // 手动切到 Git 模式再切回，命令与选中项保持一致。
  await page.locator('input[name="containerUpgradeMode"][value="compose_git"]').check();
  await expect(page.locator('#container-upgrade-command')).toHaveValue("cd '/opt/web-app' && git pull && docker compose up -d --build");
  await page.locator('input[name="containerUpgradeMode"][value="compose_pull"]').check();
  await expect(page.locator('#container-upgrade-command')).toHaveValue(composePull);

  // 添加到计划任务时带上当前命令。
  await page.locator('#container-upgrade-add-cron').click();
  await expect(dialog).toBeHidden();
  const cronDialog = page.locator('#cron-task-dialog');
  await expect(cronDialog).toBeVisible();
  await expect(page.locator('#cron-task-name')).toHaveValue('定时升级: web-nginx');
  await expect(page.locator('#cron-command-input')).toHaveValue(composePull);
  await expect(page.locator('#cron-task-schedule')).toHaveValue('0 3 * * 0');
  await page.locator('#cron-dialog-cancel').click();
  await expect(cronDialog).toBeHidden();
});

test('编辑独立容器时带出镜像、端口、环境变量和挂载参数', async ({ page }) => {
  await fileFixture(page);
  await openContainers(page);
  const row = page.locator('#container-table-body tr').filter({ hasText: 'db-postgres' });
  await row.locator('[data-container-action="edit"]').click();
  await expect(page.locator('#container-edit-dialog')).toBeVisible();
  await expect(page.locator('#container-edit-command')).toHaveValue(/docker run -d/);
  await expect(page.locator('#container-edit-command')).toHaveValue(/MODE=production/);
  await expect(page.locator('#container-edit-command')).toHaveValue(/8080:80/);
  await expect(page.locator('#container-edit-command')).toHaveValue(/\/srv\/www/);
  await page.locator('#container-edit-close').click();
});

test('Compose 镜像名不含 / 时自动选中 Git 源码更新', async ({ page }) => {
  await fileFixture(page);
  await openContainers(page);
  const row = page.locator('#container-table-body tr').filter({ hasText: 'web-nginx' });
  await row.locator('[data-container-action="upgrade"]').click();
  await expect(page.locator('#container-upgrade-image')).toHaveText('nginx:1.25');
  await expect(page.locator('#container-upgrade-type-badge')).toContainText('Git 源码更新');
  await expect(page.locator('input[name="containerUpgradeMode"][value="compose_git"]')).toBeChecked();
  await expect(page.locator('#container-upgrade-command')).toHaveValue("cd '/opt/web-app' && git pull && docker compose up -d --build");
  await page.locator('#container-upgrade-close').click();
});

test('单个非 Compose 容器使用 Watchtower 一次性更新', async ({ page }) => {
  await fileFixture(page, { dbCompose: false });
  await openContainers(page);
  const row = page.locator('#container-table-body tr').filter({ hasText: 'db-postgres' });
  await row.locator('[data-container-action="upgrade"]').click();
  const dialog = page.locator('#container-upgrade-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#container-upgrade-image')).toHaveText('postgres:16');
  await expect(page.locator('#container-upgrade-type-badge')).toContainText('Watchtower');
  await expect(page.locator('input[name="containerUpgradeMode"][value="image_pull"]')).toBeChecked();
  await expect(page.locator('#container-upgrade-command')).toHaveValue("docker run --rm -v /var/run/docker.sock:/var/run/docker.sock containrrr/watchtower --run-once --cleanup 'db-postgres'");
  await page.locator('#container-upgrade-close').click();
});

test('镜像管理查看列表、拉取新镜像与清理未用镜像', async ({ page }, testInfo) => {
  const fixture = await fileFixture(page);
  await openContainers(page);

  // 点击切到「镜像管理」子 Tab
  await page.locator('#container-subtab-images').click();
  await expect(page.locator('#container-view-images')).toBeVisible();
  await expect(page.locator('#container-view-containers')).toBeHidden();

  // 镜像统计与列表渲染
  await expect(page.locator('#image-summary-total')).toHaveText('2');
  const imgRows = page.locator('#container-image-table-body tr');
  await expect(imgRows).toHaveCount(2);
  await expect(imgRows.nth(0)).toContainText('nginx');
  await expect(imgRows.nth(0)).toContainText('1.25');
  await expect(imgRows.nth(0)).toContainText('142MB');
  await expect(imgRows.nth(1)).toContainText('postgres');
  await expect(imgRows.nth(1)).toContainText('16-alpine');

  // 测试拉取镜像弹窗
  await page.locator('#image-btn-pull').click();
  const pullDialog = page.locator('#container-pull-dialog');
  await expect(pullDialog).toBeVisible();
  await page.locator('#container-pull-input').fill('redis:7-alpine');
  await page.locator('#container-pull-confirm').click();
  await expect(pullDialog).toBeHidden();
  await expect.poll(() => fixture.containerCalls.map((c) => c.action)).toContain('pull');
  expect(fixture.containerCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'pull', target: 'redis:7-alpine' }),
  ]));

  // 关闭拉取展示的日志弹窗
  await page.locator('#container-log-dismiss').click();
  await expect(page.locator('#container-log-dialog')).toBeHidden();

  // 测试清理未用镜像 prune
  await page.locator('#image-btn-prune').click();
  await expect(page.locator('#container-confirm-dialog')).toBeVisible();
  await page.locator('#container-confirm-accept').click();
  await expect.poll(() => fixture.containerCalls.map((c) => c.action)).toContain('prune_images');

  await page.screenshot({ path: testInfo.outputPath('container-images.png') });
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

  // 删除需要确认，取消则不发送命令。弹窗标题与描述中展示容器名称而不是裸 ID。
  await page.locator('#container-table-body tr').filter({ hasText: 'db-postgres' }).locator('[data-container-action="rm"]').click();
  await expect(page.locator('#container-confirm-dialog')).toBeVisible();
  await expect(page.locator('#container-confirm-title')).toContainText('db-postgres');
  await page.locator('#container-confirm-reject').click();
  await expect(page.locator('#container-confirm-dialog')).toBeHidden();
  expect(fixture.containerCalls.filter((call) => call.action === 'rm')).toHaveLength(0);

  // 运行中的容器直接点击删除，弹窗提示将自动停止并强制删除
  await page.locator('#container-table-body tr').filter({ hasText: 'web-nginx' }).locator('[data-container-action="rm"]').click();
  await expect(page.locator('#container-confirm-dialog')).toBeVisible();
  await expect(page.locator('#container-confirm-title')).toContainText('web-nginx');
  await expect(page.locator('#container-confirm-description')).toContainText('自动停止并强制删除');
  await page.locator('#container-confirm-accept').click();
  await expect.poll(() => fixture.containerCalls.map((call) => call.action)).toContain('rm');
  expect(fixture.containerCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'rm', target: 'abc123def456' }),
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

test('侧边栏完整导航与总览主机卡片', async ({ page }) => {
  await fileFixture(page);
  await page.locator('#rail-overview').click();
  await expect(page.locator('#rail-hosts')).toHaveCount(0);
  await expect(page.locator('#rail-overview')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#rail-terminal')).toHaveText('终端');
  await expect(page.locator('#rail-files')).toHaveText('文件');
  await expect(page.locator('#rail-containers')).toHaveText('容器');
  await expect(page.locator('#rail-cron')).toHaveText('计划任务');
  await expect(page.locator('.host-card').first()).toBeVisible();
  await expect(page.locator('.host-card').first()).toContainText('Tokyo production');
});
