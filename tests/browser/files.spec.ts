import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { connectFiles, fileFixture } from './file-fixture';

test('工作台入口、空状态与移动端布局', async ({ page }, testInfo) => {
  await fileFixture(page, { noHosts: true });
  // 默认落在文件页面：左上纯中文标题，侧边栏高亮文件。
  await expect(page.locator('#files-heading')).toHaveText('文件');
  await expect(page.locator('#rail-files')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#files-connect')).toBeDisabled();
  await expect(page.locator('#file-upload')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('files-empty.png'), fullPage: true });
  await page.locator('#rail-overview').click();
  await expect(page.locator('#hosts-heading')).toBeVisible();
});

test('文件管理全屏保留目录、选择和共享连接', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await fileFixture(page);
  await expect(page.locator('#fullscreen-files')).toBeDisabled();
  await connectFiles(page);
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).click();

  const panel = page.locator('#file-manager-panel');
  const before = await panel.boundingBox();
  await page.locator('#fullscreen-files').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('file-manager-panel');
  await expect(page.locator('#fullscreen-files')).toBeHidden();
  await expect(page.locator('#exit-fullscreen-files')).toBeVisible();
  await expect(page.locator('#exit-fullscreen-files')).toBeFocused();
  const exitBounds = await page.locator('#exit-fullscreen-files').boundingBox();
  expect(exitBounds!.width).toBeGreaterThanOrEqual(44);
  expect(exitBounds!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('#file-download')).toBeEnabled();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');
  const bounds = await panel.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(bounds!.x).toBe(0);
  expect(bounds!.y).toBe(0);
  expect(bounds!.width).toBe(viewport.width);
  expect(bounds!.height).toBe(viewport.height);
  expect(bounds!.height).toBeGreaterThan(before!.height);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const table = await panel.locator('.file-table-wrap').boundingBox();
  expect(table!.height).toBeGreaterThan(viewport.height / 2);
  await page.screenshot({ path: testInfo.outputPath('files-fullscreen.png') });
  await page.locator('#exit-fullscreen-files').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator('#fullscreen-files')).toBeFocused();
  await expect(page.locator('#exit-fullscreen-files')).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'files');
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');

  // 全屏前后都是同一个 SSH / SFTP 会话。
  expect(fixture.sshSockets).toHaveLength(1);
  expect(fixture.sftpSockets).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.locator('#files-connect').click();
  await expect(page.locator('#fullscreen-files')).toBeDisabled();
});

test('连接、目录导航与共享终端会话不重复附着', async ({ page }, testInfo) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');
  await expect(page.locator('.files-list')).toContainText('README.md');
  await expect(page.locator('#files-host')).toBeDisabled();
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  await expect(page.locator('.header-add')).toBeHidden();
  await page.locator('.files-footer').scrollIntoViewIfNeeded();
  await expect(page.locator('.files-footer')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#toast-region .toast')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('files-connected.png'), fullPage: true });
  await page.locator('.files-list [role="treeitem"]').filter({ hasText: 'backups' }).dblclick();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/backups');
  await page.locator('#file-up').click();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');
  // 切到终端再切回文件：同一会话不重复附着，终端保持后台连接。
  await page.locator('#rail-terminal').click();
  await expect(page.locator('#terminal-page-heading')).toHaveText('终端');
  await expect(page.locator('.terminal-page')).toBeVisible();
  await expect(page.locator('.files-page')).toBeHidden();
  await page.locator('#rail-files').click();
  await expect(page.locator('#files-heading')).toHaveText('文件');
  await expect(page.locator('.files-page #file-manager-panel')).toBeVisible();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');
  await expect(page.locator('.files-list [role="tree"]')).toBeVisible();
  // 切回面板会重建列表，重新选中同一条目验证数据仍在。
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  // 关键断言：三个通道都只有一个，切换面板没有重连。
  expect(fixture.sshSockets).toHaveLength(1);
  expect(fixture.sftpSockets).toHaveLength(1);
  expect(fixture.calls.filter((call) => call.type === 'terminal-input')).toHaveLength(0);
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
});

test('常用文件图标、键盘选择和 Enter 导航', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await fileFixture(page);
  const base = fixture.directories.get('/root')![2];
  fixture.directories.get('/root')!.push(
    ...['backup.tar.gz', 'deploy.sh', '.env', 'unknown.bin'].map((name) => ({ ...base, name })),
    { ...base, name: 'current', type: 'symlink' },
  );
  await connectFiles(page);
  const list = page.locator('.files-list');
  const cases = { backups: 'folder', 'backup.tar.gz': 'archive', 'README.md': 'document', 'deploy.sh': 'script', '.env': 'config', 'unknown.bin': 'file', current: 'link' };
  for (const [name, kind] of Object.entries(cases)) {
    const row = list.getByRole('treeitem', { name, exact: true });
    // 虚拟列表只挂载可见行，用键盘搜索定位，不依赖一次性渲染所有文件。
    await list.getByRole('tree').focus();
    await list.getByRole('tree').press('Home');
    await page.keyboard.type(name);
    await expect(row.locator('svg')).toHaveAttribute('data-file-kind', kind);
    await page.waitForTimeout(650);
  }
  await list.getByRole('treeitem', { name: 'backups', exact: true }).click();
  await expect(page.locator('#file-download')).toBeDisabled();
  await expect(page.locator('#file-rename')).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/backups');
  await expect(page.locator('#file-manager-empty')).toBeVisible();
  await page.locator('#file-up').click();
  await list.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await expect(page.locator('#file-download')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('files-arborist-icons.png'), fullPage: true });
  await page.locator('#files-connect').click();
  await expect(list.getByRole('treeitem')).toHaveCount(0);
  await expect(page.locator('#file-download')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('大目录虚拟化、首尾键盘导航与滚动选择', async ({ page }) => {
  const fixture = await fileFixture(page);
  const base = fixture.directories.get('/root')![2];
  fixture.directories.set('/root', Array.from({ length: 2000 }, (_, index) => ({
    ...base, name: `server-${String(index).padStart(4, '0')}.log`,
  })));
  await connectFiles(page);
  const list = page.locator('.files-list');
  await expect(list.getByRole('treeitem', { name: 'server-0000.log', exact: true })).toBeVisible();
  expect(await list.getByRole('treeitem').count()).toBeLessThan(30);
  // 独立页不在隐藏表格里再生成一份完整 DOM。
  await expect(page.locator('#file-table-body tr')).toHaveCount(0);
  await list.getByRole('tree').focus();
  await page.keyboard.press('End');
  const last = list.getByRole('treeitem', { name: 'server-1999.log', exact: true });
  await expect(last).toBeVisible();
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#file-download')).toBeEnabled();
  await page.keyboard.press('ArrowUp');
  await expect(list.getByRole('treeitem', { name: 'server-1998.log', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(list.getByRole('treeitem', { name: 'server-0000.log', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('复用新建文件夹、重命名和删除协议', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await expect(page.locator('#file-mkdir')).toBeEnabled();
  page.once('dialog', (dialog) => dialog.accept('test-folder'));
  await page.locator('#file-mkdir').click();
  const folder = page.locator('.files-list [role="treeitem"]').filter({ hasText: 'test-folder' });
  await expect(folder).toBeVisible();
  await folder.click();
  page.once('dialog', (dialog) => dialog.accept('renamed-folder'));
  await page.locator('#file-rename').click();
  const renamed = page.locator('.files-list [role="treeitem"]').filter({ hasText: 'renamed-folder' });
  await expect(renamed).toBeVisible();
  await renamed.click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#file-delete').click();
  await expect(renamed).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#file-delete').click();
  await expect(renamed).toHaveCount(0);
  await page.locator('.files-list [role="treeitem"]').filter({ hasText: 'README.md' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#file-delete').click();
  await expect(page.locator('.files-list')).not.toContainText('README.md');
  expect(fixture.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'sftp_mkdir', path: '/root/test-folder' }),
    expect.objectContaining({ type: 'sftp_rename', oldPath: '/root/test-folder', newPath: '/root/renamed-folder' }),
    expect.objectContaining({ type: 'sftp_rmdir', path: '/root/renamed-folder' }),
    expect.objectContaining({ type: 'sftp_delete', path: '/root/README.md' }),
  ]));
});

test('上传与下载校验实际字节', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await expect(page.locator('#file-upload')).toBeEnabled();
  const payload = Buffer.from('file manager upload regression\n');
  await page.locator('#file-upload-input').setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: payload });
  await expect(page.locator('.files-list')).toContainText('upload.txt');
  expect(Buffer.concat(fixture.uploaded)).toEqual(payload);
  await page.locator('.files-list [role="treeitem"]').filter({ hasText: 'README.md' }).click();
  const downloading = page.waitForEvent('download');
  await page.locator('#file-download').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('README.md');
  expect(await readFile((await download.path())!, 'utf8')).toBe('hello files\n');
});

test('更换主机清理旧会话，文件页继续可操作', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await expect(page.locator('#file-upload')).toBeEnabled();
  await page.locator('#files-connect').click();
  await expect(page.locator('#file-upload')).toBeDisabled();
  await expect(page.locator('#files-host')).toBeEnabled();
  await connectFiles(page, 'beta');
  await expect(page.locator('#file-upload')).toBeEnabled();
  expect(fixture.calls.filter((call) => call.type === 'connect').map((call) => call.host)).toEqual(['192.0.2.10', '192.0.2.20']);
  expect(fixture.calls.filter((call) => call.type === 'sftp_close')).toHaveLength(1);
});

test('文件页仍需指纹确认', async ({ page }) => {
  const fixture = await fileFixture(page, { firstSeen: true });
  await connectFiles(page);
  await expect(page.locator('#host-key-dialog')).toBeVisible();
  await expect(page.locator('#file-upload')).toBeDisabled();
  expect(fixture.sftpSockets).toHaveLength(0);
  await page.locator('#accept-host-key').click();
  await expect(page.locator('#file-upload')).toBeEnabled();
});

test('凭据和目录错误显示在文件页', async ({ page }) => {
  await fileFixture(page, { credentialError: true });
  await connectFiles(page);
  await expect(page.locator('#files-notice')).toContainText('读取凭据失败');
  await expect(page.locator('#files-connect')).toBeEnabled();
});

test('目录权限错误可恢复', async ({ page }) => {
  await fileFixture(page);
  await connectFiles(page);
  await expect(page.locator('#file-upload')).toBeEnabled();
  await page.locator('#file-manager-path').fill('/forbidden');
  await page.locator('#file-manager-path').press('Enter');
  await expect(page.locator('#file-manager-error')).toBeVisible();
  await page.locator('#file-home').click();
  await expect(page.locator('.files-list')).toContainText('README.md');
  await expect(page.locator('#file-manager-error')).toBeHidden();
});

test('传输时离开需确认，切换终端不打断传输', async ({ page }) => {
  const fixture = await fileFixture(page, { holdUpload: true });
  await connectFiles(page);
  await expect(page.locator('#file-upload')).toBeEnabled();
  await page.locator('#file-upload-input').setInputFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('pending') });
  await expect(page.locator('#file-manager-progress')).toBeVisible();
  // 传输中切到终端再切回：进度保留，SFTP 通道没有重连。
  await page.locator('#rail-terminal').click();
  await expect(page.locator('#file-manager-progress')).toBeHidden();
  await page.locator('#rail-files').click();
  await expect(page.locator('#file-manager-progress')).toBeVisible();
  expect(fixture.sftpSockets).toHaveLength(1);
  // 只有真正断开连接才需要确认。
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#rail-overview').click();
  await expect(page.locator('#file-manager-progress')).toBeVisible();
  await page.locator('#rail-files').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#files-connect').click();
  await expect(page.locator('#file-manager-progress')).toBeHidden();
});

test('读取凭据期间禁止切换终端，避免无反馈取消连接', async ({ page }) => {
  await fileFixture(page);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  await page.route('**/api/hosts/alpha/credentials', async (route) => {
    await pending;
    await route.fulfill({ json: { password: 'test-only' } });
  });
  await connectFiles(page);
  await expect(page.locator('#files-connect')).toHaveText('读取凭据中…');
  finish();
  await expect(page.locator('#file-upload')).toBeEnabled();
  await expect(page.locator('#files-connect')).toHaveText('断开连接');
});

test('离开再返回文件页，迟到的凭据不会启动已取消会话', async ({ page }) => {
  const fixture = await fileFixture(page);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  await page.route('**/api/hosts/alpha/credentials', async (route) => {
    await pending;
    await route.fulfill({ json: { password: 'test-only' } });
  });
  await connectFiles(page);
  await expect(page.locator('#files-connect')).toHaveText('读取凭据中…');
  await page.locator('#rail-overview').click();
  await expect(page.locator('#hosts-heading')).toBeVisible();
  await page.locator('#rail-files').click();
  finish();
  await expect(page.locator('#files-connect')).toHaveText('连接主机');
  expect(fixture.sshSockets).toHaveLength(0);
});

test('会话授权失败后可重试，文件操作保持禁用', async ({ page }) => {
  await fileFixture(page);
  await page.route('**/api/session', (route) => route.fulfill({ status: 403, json: { error: '会话授权失败，请重新登录。' } }));
  await connectFiles(page);
  await expect(page.locator('#files-notice')).toContainText('会话授权失败');
  await expect(page.locator('#files-connection-state')).toHaveText('连接失败');
  await expect(page.locator('#files-connect')).toBeEnabled();
  await expect(page.locator('#file-upload')).toBeDisabled();
  await expect(page.locator('#files-host')).toBeEnabled();
});

test('1Panel 风格路径面包屑导航与手填切换', async ({ page }, testInfo) => {
  await fileFixture(page);
  await connectFiles(page);

  // 1. 面包屑默认分解当前路径：[根目录 /] > [root]
  const crumbs = page.locator('#file-breadcrumbs .file-breadcrumb-btn');
  await expect(crumbs).toHaveCount(2);
  await expect(crumbs.nth(0)).toHaveText('根目录 /');
  await expect(crumbs.nth(1)).toHaveText('root');

  // 进入 backups 目录
  await page.locator('.files-list [role="treeitem"]').filter({ hasText: 'backups' }).dblclick();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/backups');

  // 面包屑自动更新为 3 级：[根目录 /] > [root] > [backups]
  await expect(crumbs).toHaveCount(3);
  await expect(crumbs.nth(2)).toHaveText('backups');

  // 点击第 2 级「root」段，一键快速跳转回 /root
  await crumbs.nth(1).click();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');
  await expect(crumbs).toHaveCount(2);

  // 点击铅笔按钮切换为手动输入框
  await page.locator('#file-path-edit-toggle').click();
  await expect(page.locator('.file-path-field')).toBeVisible();
  await expect(page.locator('#file-breadcrumbs')).toBeHidden();

  // 再次点击切回面包屑
  await page.locator('#file-path-edit-toggle').click();
  await expect(page.locator('#file-breadcrumbs')).toBeVisible();
  await expect(page.locator('.file-path-container')).not.toHaveClass(/is-manual/);

  await page.screenshot({ path: testInfo.outputPath('file-breadcrumbs.png') });
});

test('1Panel 风格新建文件并立即在线编辑保存', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);

  // 触发新建文件
  page.once('dialog', (dialog) => dialog.accept('deploy.yaml'));
  await page.locator('#file-new-file').click();

  // 自动弹出在线编辑器，填入内容并保存
  const editorDialog = page.locator('#file-editor-dialog');
  await expect(editorDialog).toBeVisible();
  await expect(page.locator('#file-editor-title')).toHaveText('deploy.yaml');
  await expect(page.locator('#file-editor-path')).toHaveText('/root/deploy.yaml');

  await page.locator('#file-editor-area').fill('version: "3"\nservices:\n  web:\n    image: nginx\n');
  await page.locator('#file-editor-save').click();
  await expect(page.locator('#file-editor-status')).toHaveText('已保存');

  // 保存走上传通道写回服务器
  await expect.poll(() => Buffer.concat(fixture.uploaded).toString('utf8')).toContain('services:');
  expect(fixture.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'sftp_upload_start', path: '/root/deploy.yaml' }),
  ]));

  await page.locator('#file-editor-dismiss').click();
  await expect(editorDialog).toBeHidden();
});
