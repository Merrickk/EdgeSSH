import { test, expect } from '@playwright/test';
import { fileFixture } from './file-fixture';

test.describe.configure({ mode: 'serial' });

async function openCron(page: import('@playwright/test').Page, id = 'alpha') {
  await page.locator('#rail-overview').click();
  await page.locator('#rail-cron').click();
  await expect(page.locator('#cron-heading')).toBeVisible();
  await page.locator('#cron-host').selectOption(id);
  await page.locator('#cron-connect').click();
  await expect(page.locator('#cron-connection-state')).toHaveText('SSH 已连接');
  await expect(page.locator('#cron-table-body tr')).toHaveCount(2);
}

test('计划任务导航位置、连接与列表解析', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await fileFixture(page);

  // 1. 验证导航栏顺序：计划任务在代码片段之前
  const railItems = page.locator('.home-rail .rail-item span');
  const texts = await railItems.allTextContents();
  const cronIdx = texts.indexOf('计划任务');
  const snipIdx = texts.indexOf('代码片段');
  expect(cronIdx).toBeGreaterThan(-1);
  expect(snipIdx).toBeGreaterThan(-1);
  expect(cronIdx).toBeLessThan(snipIdx);

  // 2. 连接主机并展示计划任务
  await openCron(page);
  await expect(page.locator('#cron-connection-state')).toHaveText('SSH 已连接');

  await expect(page.locator('#cron-total-count')).toHaveText('2');
  await expect(page.locator('#cron-enabled-count')).toHaveText('2');

  const rows = page.locator('#cron-table-body tr');
  await expect(rows).toHaveCount(2);

  // 第1条任务是脚本任务，名称为中文“每日数据备份”，周期 0 3 * * *（每天 03:00 执行）
  await expect(rows.nth(0)).toContainText('每日数据备份');
  await expect(rows.nth(0)).toContainText('每天 03:00 执行');
  await expect(rows.nth(0)).toContainText('脚本文件');
  await expect(rows.nth(0)).toContainText('/root/scripts/backup.sh');
  await expect(rows.nth(0)).toContainText('已启用');

  // 第2条任务是普通命令任务“系统日志清理”
  await expect(rows.nth(1)).toContainText('系统日志清理');
  await expect(rows.nth(1)).toContainText('每周日 02:00 执行');
  await expect(rows.nth(1)).toContainText('Shell 命令');

  await page.screenshot({ path: testInfo.outputPath('cron-list.png'), fullPage: true });
});

test('计划任务立即运行并弹窗展示输出日志', async ({ page }) => {
  const fixture = await fileFixture(page);
  await openCron(page);

  const row = page.locator('#cron-table-body tr').first();
  await row.locator('[data-cron-action="run"]').click();

  const runDialog = page.locator('#cron-run-dialog');
  await expect(runDialog).toBeVisible();
  await expect(page.locator('#cron-run-title')).toContainText('每日数据备份');
  await expect(page.locator('#cron-run-text')).toContainText('Backup finished successfully');

  await page.locator('#cron-run-dismiss').click();
  await expect(runDialog).toBeHidden();

  expect(fixture.cronCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'run' }),
  ]));
});

test('新建与保存带在线脚本代码的计划任务', async ({ page }) => {
  const fixture = await fileFixture(page);
  await openCron(page);

  await page.locator('#cron-btn-new').click();
  const dialog = page.locator('#cron-task-dialog');
  await expect(dialog).toBeVisible();

  // 填写名称
  await page.locator('#cron-task-name').fill('自动备份与清理');

  // 快捷周期选择“每天凌晨 04:00”
  await page.locator('#cron-preset-select').selectOption('0 4 * * *');
  await expect(page.locator('#cron-task-schedule')).toHaveValue('0 4 * * *');
  await expect(page.locator('#cron-schedule-hint')).toContainText('每天 04:00 执行');

  // 切换为脚本文件任务
  await page.locator('#cron-type-script').check();
  await expect(page.locator('#cron-script-group')).toBeVisible();
  await expect(page.locator('#cron-command-group')).toBeHidden();

  await page.locator('#cron-script-path').fill('/root/scripts/autoclean.sh');
  await page.locator('#cron-script-area').fill('#!/bin/bash\necho "Cleaning temp files..."\nrm -rf /tmp/build_*\n');

  await page.locator('#cron-dialog-save').click();
  await expect(dialog).toBeHidden();

  // 保存时会先 save_script 再 save crontab
  expect(fixture.cronCalls.map((c) => c.action)).toContain('save_script');
  expect(fixture.cronCalls.map((c) => c.action)).toContain('save');
});

test('计划任务开启停用与删除', async ({ page }) => {
  const fixture = await fileFixture(page);
  await openCron(page);

  const firstRow = page.locator('#cron-table-body tr').first();
  // 停用任务
  await firstRow.locator('[data-cron-action="toggle"]').click();
  await expect.poll(() => fixture.cronCalls.filter((c) => c.action === 'save').length).toBeGreaterThanOrEqual(1);

  // 删除任务：带确认弹窗
  await firstRow.locator('[data-cron-action="delete"]').click();
  await expect(page.locator('#cron-confirm-dialog')).toBeVisible();

  await page.locator('#cron-confirm-accept').click();
  await expect(page.locator('#cron-confirm-dialog')).toBeHidden();
  await expect.poll(() => fixture.cronCalls.filter((c) => c.action === 'save').length).toBeGreaterThanOrEqual(2);
});
