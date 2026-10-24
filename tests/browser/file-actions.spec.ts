import { test, expect } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

/** 打开工作台文件面板。 */
async function openDockFiles(page: import('@playwright/test').Page) {
  await page.locator('#rail-overview').click();
  await page.locator('#rail-files').click();
  await expect(page.locator('#file-manager-panel')).toBeVisible();
}

test('工作台三个面板可切换且终局面板常驻', async ({ page }, testInfo) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await expect(page.locator('#workbench-title')).toHaveText('文件');

  // 标签切换：标题、面板可见性、aria 状态同步更新。
  await page.locator('#workbench-tab-containers').click();
  await expect(page.locator('#workbench-title')).toHaveText('容器');
  await expect(page.locator('#workbench-panel-containers')).toBeVisible();
  await expect(page.locator('#workbench-panel-files')).toBeHidden();
  await expect(page.locator('#workbench-tab-containers')).toHaveAttribute('aria-selected', 'true');

  await page.locator('#workbench-tab-terminal').click();
  await expect(page.locator('#workbench-title')).toHaveText('终端');
  await expect(page.locator('#workbench-panel-terminal')).toBeVisible();
  await expect(page.locator('#workbench-panel-files')).toBeHidden();
  await expect(page.locator('#workbench-panel-containers')).toBeHidden();

  await page.locator('#workbench-tab-files').click();
  await expect(page.locator('#workbench-panel-files')).toBeVisible();
  // 三个通道都只有一个：切换面板没有重连，终端保持后台连接。
  expect(fixture.sshSockets).toHaveLength(1);
  expect(fixture.sftpSockets).toHaveLength(1);
  expect(fixture.containerSockets).toHaveLength(1);
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');

  // 键盘同样可以切换：方向键在三个标签间循环。
  await page.locator('#workbench-tab-files').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#workbench-title')).toHaveText('容器');
  await page.keyboard.press('End');
  await expect(page.locator('#workbench-title')).toHaveText('终端');
  await page.keyboard.press('Home');
  await expect(page.locator('#workbench-title')).toHaveText('文件');
});

test('行内操作菜单打开操作面板并复用重命名协议', async ({ page }, testInfo) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  const row = page.locator('.files-list').getByRole('treeitem', { name: 'README.md' });
  await row.click();
  const menu = row.locator('.files-list-menu');
  await expect(menu).toBeVisible();
  await menu.scrollIntoViewIfNeeded();
  const box = (await menu.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#file-action-sheet')).toBeVisible();
  await expect(page.locator('#file-action-sheet-title')).toHaveText('README.md');
  await expect(page.locator('#file-action-sheet-subtitle')).toContainText('文件');
  await expect(page.locator('[data-file-sheet="download"]')).toBeEnabled();

  page.once('dialog', (dialog) => dialog.accept('renamed.md'));
  await page.locator('[data-file-sheet="rename"]').click();
  await expect(page.locator('#file-action-sheet')).toBeHidden();
  await expect(page.locator('.files-list')).toContainText('renamed.md');
  expect(fixture.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'sftp_rename', oldPath: '/root/README.md', newPath: '/root/renamed.md' }),
  ]));

  // Escape 关闭面板且不收起工作台。
  const renamed = page.locator('.files-list').getByRole('treeitem', { name: 'renamed.md' });
  const again = (await renamed.locator('.files-list-menu').boundingBox())!;
  await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
  await expect(page.locator('#file-action-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#file-action-sheet')).toBeHidden();
  await expect(page.locator('#file-manager-panel')).toBeVisible();
});

test('窄屏目录树抽屉可开合且不遮挡工具栏', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'drawer only exists on narrow viewports');
  await fileFixture(page);
  await connectFiles(page);
  const panel = page.locator('#file-manager-panel');
  const toggle = page.locator('#file-tree-toggle');
  await expect(toggle).toBeVisible();
  await expect(panel).not.toHaveClass(/tree-open/);
  await toggle.click();
  await expect(panel).toHaveClass(/tree-open/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#file-tree-scrim')).toBeVisible();
  const tree = (await page.locator('#file-tree').boundingBox())!;
  expect(tree.width).toBeGreaterThan(100);
  // 点击抽屉右侧的遮罩关闭，而不是树本身；坐标取面板内的空白处。
  const scrim = (await page.locator('#file-tree-scrim').boundingBox())!;
  await page.mouse.click(scrim.x + scrim.width - 8, scrim.y + scrim.height / 2);
  await expect(panel).not.toHaveClass(/tree-open/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('多文件上传按队列依次传输', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  const a = Buffer.from('alpha');
  const b = Buffer.from('bravo-bravo');
  await page.locator('#file-upload-input').setInputFiles([
    { name: 'a.txt', mimeType: 'text/plain', buffer: a },
    { name: 'b.txt', mimeType: 'text/plain', buffer: b },
  ]);
  // 队列排空后目录才刷新，列表最终应包含两个新文件。
  await expect(page.locator('.files-list')).toContainText('b.txt', { timeout: 15_000 });
  const starts = fixture.calls
    .filter((call) => call.type === 'sftp_upload_start')
    .map((call) => call.path);
  expect(starts).toEqual(['/root/a.txt', '/root/b.txt']);
  // 服务端按顺序收到两个文件的完整字节。
  expect(Buffer.concat(fixture.uploaded)).toEqual(Buffer.concat([a, b]));
  await expect(page.locator('#file-manager-progress')).toBeHidden();
});

test('筛选与排序只作用于当前目录视图', async ({ page }) => {
  await fileFixture(page);
  await connectFiles(page);
  await expect(page.locator('.files-list').getByRole('treeitem').first()).toBeVisible();
  const names = () => page.locator('.files-list').getByRole('treeitem').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')));
  await expect.poll(names).toEqual(['backups', 'deploy', 'nginx.conf', 'README.md']);

  await page.locator('#file-filter-toggle').click();
  await expect(page.locator('#file-filter-bar')).toBeVisible();
  await page.locator('#file-filter').fill('README');
  await expect(page.locator('.files-list').getByRole('treeitem')).toHaveCount(1);
  await expect(page.locator('#file-filter-count')).toHaveText('1 / 4');
  await page.locator('#file-filter-clear').click();
  await expect(page.locator('.files-list').getByRole('treeitem')).toHaveCount(4);

  await page.locator('#file-sort-key').selectOption('size');
  await expect.poll(names).toEqual(['backups', 'deploy', 'README.md', 'nginx.conf']);
  await page.locator('#file-sort-dir').click();
  await expect.poll(names).toEqual(['backups', 'deploy', 'nginx.conf', 'README.md']);
  await expect(page.locator('#file-sort-dir')).toHaveText('↓');
});

test('预览文本文件并查看属性', async ({ page }) => {
  await fileFixture(page);
  await connectFiles(page);
  const row = page.locator('.files-list').getByRole('treeitem', { name: 'README.md' });
  await row.click();
  const box = (await row.locator('.files-list-menu').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#file-action-sheet')).toBeVisible();

  await page.locator('[data-file-sheet="preview"]').click();
  await expect(page.locator('#file-preview-dialog')).toBeVisible();
  await expect(page.locator('#file-preview-text')).toContainText('hello files');
  await expect(page.locator('#file-preview-image')).toBeHidden();
  await page.locator('#file-preview-dismiss').click();
  await expect(page.locator('#file-preview-dialog')).toBeHidden();

  // 预览对话框关闭后重新定位菜单按钮，避免用到过期坐标。
  const reopen = (await row.locator('.files-list-menu').boundingBox())!;
  await page.mouse.click(reopen.x + reopen.width / 2, reopen.y + reopen.height / 2);
  await page.locator('[data-file-sheet="properties"]').click();
  await expect(page.locator('#file-properties-dialog')).toBeVisible();
  const list = page.locator('#file-properties-list');
  await expect(list).toContainText('README.md');
  await expect(list).toContainText('/root/README.md');
  await expect(list).toContainText('0644');
  await expect(list).toContainText('root');
  await page.locator('#file-properties-dismiss').click();
  await expect(page.locator('#file-properties-dialog')).toBeHidden();
});

test('文本文件可读入编辑并保存回远端', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  const row = page.locator('.files-list').getByRole('treeitem', { name: 'nginx.conf' });
  await row.click();
  const box = (await row.locator('.files-list-menu').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#file-action-sheet')).toBeVisible();

  // 白名单内的配置文件才出现“编辑”，图片/压缩包不会。
  await expect(page.locator('[data-file-sheet="edit"]')).toBeEnabled();
  await page.locator('[data-file-sheet="edit"]').click();
  await expect(page.locator('#file-action-sheet')).toBeHidden();

  const dialog = page.locator('#file-editor-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#file-editor-path')).toHaveText('/root/nginx.conf');
  await expect(page.locator('#file-editor-area')).toHaveValue('server {\n  listen 80;\n}\n');
  await expect(page.locator('#file-editor-save')).toBeDisabled();

  await page.locator('#file-editor-area').fill('server {\n  listen 8080;\n}\n');
  await expect(page.locator('#file-editor-save')).toBeEnabled();
  await expect(page.locator('#file-editor-cancel')).toBeVisible();

  await page.locator('#file-editor-save').click();
  await expect(page.locator('#file-editor-status')).toHaveText('已保存');
  await expect(page.locator('#file-editor-save')).toBeDisabled();
  // 保存走的是上传通道，字节必须原样落到远端。
  expect(Buffer.concat(fixture.uploaded).toString('utf8')).toBe('server {\n  listen 8080;\n}\n');
  expect(fixture.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'sftp_upload_start', path: '/root/nginx.conf' }),
  ]));

  // 放弃修改还原为上次保存的内容。
  await page.locator('#file-editor-area').fill('broken');
  await page.locator('#file-editor-cancel').click();
  await expect(page.locator('#file-editor-area')).toHaveValue('server {\n  listen 8080;\n}\n');
  await expect(page.locator('#file-editor-status')).toHaveText('已放弃修改');

  await page.locator('#file-editor-dismiss').click();
  await expect(dialog).toBeHidden();
});

test('编辑器只接受文本白名单，未保存时关闭需确认', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  const row = page.locator('.files-list').getByRole('treeitem', { name: 'backups' });
  await row.click();
  const box = (await row.locator('.files-list-menu').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('[data-file-sheet="edit"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#file-action-sheet')).toBeHidden();

  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md' }).click();
  const readme = (await page.locator('.files-list').getByRole('treeitem', { name: 'README.md' }).locator('.files-list-menu').boundingBox())!;
  await page.mouse.click(readme.x + readme.width / 2, readme.y + readme.height / 2);
  await page.locator('[data-file-sheet="edit"]').click();
  await expect(page.locator('#file-editor-dialog')).toBeVisible();
  await expect(page.locator('#file-editor-area')).toHaveValue('hello files\n');

  await page.locator('#file-editor-area').fill('changed\n');
  // 有改动时 Escape 不直接关闭，取消确认后编辑器保持打开。
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.locator('#file-editor-dialog')).toBeVisible();
  // 确认后关闭，且不会把改动写回远端。
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(page.locator('#file-editor-dialog')).toBeHidden();
  expect(fixture.calls.filter((call) => call.type === 'sftp_upload_start')).toHaveLength(0);
});
