import type { Page, WebSocketRoute } from '@playwright/test';

export interface FileFixtureOptions {
  firstSeen?: boolean;
  credentialError?: boolean;
  noHosts?: boolean;
  holdUpload?: boolean;
  /** 推迟到调用方注册完自己的 /api 路由后再 navigate()。 */
  skipNavigate?: boolean;
}
import { parseContainerFrame } from '../../src/backend/container-command.ts';

const fingerprint = `SHA256:${'A'.repeat(43)}`;
const host = (id: string, name: string, address: string) => ({
  id, name, host: address, port: 22, username: 'root', group: '测试主机',
  authMethod: 'password', initialCommand: 'echo should-not-run-in-files',
  termType: 'xterm-256color', encoding: 'utf-8', fingerprint,
  location: null, system: null, hasCredential: true, updatedAt: Date.now(),
});
const entry = (name: string, type = 'file', size = 12) => ({
  name, type, size, mtime: 1_790_100_000, permissions: type === 'directory' ? '0755' : '0644', owner: 'root', group: 'root',
});

// 只在测试浏览器内模拟 API/协议，不访问真实主机、不增加生产认证绕过。
export async function fileFixture(page: Page, options: FileFixtureOptions = {}) {
  const hosts = options.noHosts ? [] : [host('alpha', 'Tokyo production', '192.0.2.10'), host('beta', 'Singapore backup', '192.0.2.20')];
  const directories = new Map([
    ['/', [entry('root', 'directory')]],
    ['/root', [entry('backups', 'directory'), entry('deploy', 'directory'), entry('README.md'), entry('nginx.conf', 'file', 2480)]],
    ['/root/backups', []],
    ['/root/deploy', []],
  ]);
  const calls: Array<Record<string, any>> = [];
  const sshSockets: WebSocketRoute[] = [];
  const sftpSockets: WebSocketRoute[] = [];
  const uploaded: Buffer[] = [];
  const containerSockets: WebSocketRoute[] = [];
  const containerCalls: Array<Record<string, any>> = [];
  const cronSockets: WebSocketRoute[] = [];
  const cronCalls: Array<Record<string, any>> = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/session') return route.fulfill({ json: { ticket: 'test-ticket', sessionId: crypto.randomUUID() } });
    if (path.endsWith('/credentials')) {
      return route.fulfill(options.credentialError
        ? { status: 500, json: { error: '读取凭据失败，请重试。' } }
        : { json: { password: 'test-only-password' } });
    }
    if (path === '/api/hosts') return route.fulfill({ json: { hosts } });
    return route.fulfill({ json: { host: hosts.find((item) => path.includes(item.id)) ?? hosts[0] } });
  });
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    sshSockets.push(ws);
    const ready = () => {
      ws.send(JSON.stringify({ type: 'ready' }));
      ws.send(JSON.stringify({ type: 'sftp_attach', url: '/api/sftp?session=test&token=test' }));
      ws.send(JSON.stringify({ type: 'process_attach', url: '/api/processes?session=test&token=test' }));
      ws.send(JSON.stringify({ type: 'container_attach', url: '/api/containers?session=test&token=test' }));
      ws.send(JSON.stringify({ type: 'cron_attach', url: '/api/cron?session=test&token=test' }));
    };
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') { calls.push({ type: 'terminal-input', data: raw.toString() }); return; }
      const message = JSON.parse(raw);
      calls.push(message);
      if (message.type === 'connect') {
        if (options.firstSeen) {
          // 返回变化指纹，确保仍需真实 UI 确认，而不是由测试直接放行。
          ws.send(JSON.stringify({ type: 'host_key', fingerprint: `SHA256:${'B'.repeat(43)}`, expectedFingerprint: fingerprint, keyType: 'ssh-ed25519', trusted: false }));
        } else ready();
      }
      if (message.type === 'host_key_decision' && message.accept) ready();
    });
  });
  await page.routeWebSocket('**/api/sftp?*', (ws) => {
    sftpSockets.push(ws);
    let upload: { requestId: string; path: string; size: number } | undefined;
    const send = (data: object) => ws.send(JSON.stringify(data));
    const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
    const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') {
        uploaded.push(Buffer.from(raw));
        send({ type: 'sftp_upload_progress', requestId: upload!.requestId, loaded: uploaded.reduce((sum, chunk) => sum + chunk.length, 0) });
        return;
      }
      const message = JSON.parse(raw);
      calls.push(message);
      const { type, requestId, path } = message;
      if (type === 'sftp_init') send({ type: 'sftp_ready', cwd: '/root', version: 3 });
      if (type === 'sftp_list') {
        if (path === '/forbidden') send({ type: 'sftp_error', requestId, message: 'Permission denied' });
        else send({ type: 'sftp_list_result', requestId, path, entries: directories.get(path) ?? [] });
      }
      if (type === 'sftp_mkdir') {
        directories.get(parent(path))!.push(entry(name(path), 'directory'));
        directories.set(path, []);
      }
      if (type === 'sftp_rename') {
        directories.get(parent(message.oldPath))!.find((item) => item.name === name(message.oldPath))!.name = name(message.newPath);
      }
      if (type === 'sftp_delete' || type === 'sftp_rmdir') {
        directories.set(parent(path), directories.get(parent(path))!.filter((item) => item.name !== name(path)));
      }
      if (['sftp_mkdir', 'sftp_rename', 'sftp_delete', 'sftp_rmdir'].includes(type)) send({ type: `${type}_result`, requestId });
      if (type === 'sftp_upload_start') {
        upload = message;
        if (!options.holdUpload) send({ type: 'sftp_upload_ready', requestId });
      }
      if (type === 'sftp_upload_end') {
        directories.get(parent(upload!.path))!.push(entry(name(upload!.path), 'file', upload!.size));
        send({ type: 'sftp_upload_complete', requestId });
      }
      if (type === 'sftp_download') {
        const data = Buffer.from(name(path) === 'nginx.conf' ? 'server {\n  listen 80;\n}\n' : 'hello files\n');
        send({ type: 'sftp_download_start', requestId, size: data.length });
        ws.send(data);
        send({ type: 'sftp_download_done', requestId, size: data.length });
      }
    });
  });
  // 容器监控：与真实后端一致，先 container_start 再按周期推送快照。
  await page.routeWebSocket('**/api/containers**', (ws) => {
    containerSockets.push(ws);
    const send = (data: object) => ws.send(JSON.stringify(data));
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      const message = JSON.parse(raw);
      calls.push(message);
      if (message.type === 'container_start') {
        send({ type: 'container_ready' });
        // 与真实后端一致：把标记帧交给解析器，再把 JSON 快照发给前端。
        const frame = [
          'abc123def456\tweb-nginx\tnginx:1.25\trunning\tUp 3 hours\t2026-09-20 09:00\t0.0.0.0:80->80/tcp',
          'aaa111bbb222\tdb-postgres\tpostgres:16\texited\tExited (0) 2 hours ago\t2026-09-18 12:00\t',
          '__CF_WEBSSH_STATS__',
          'abc123def456\t0.05%\t32MiB / 1GiB\t3.12%\t1.2kB / 3.4kB\t8MB / 12MB\t12',
          '__CF_WEBSSH_IMAGES__2',
          '__CF_WEBSSH_IMAGES_LIST__',
          'sha256:img111222333\tnginx\t1.25\t142MB\t2 weeks ago',
          'sha256:img444555666\tpostgres\t16-alpine\t379MB\t1 month ago',
        ].join('\n');
        const snapshot = parseContainerFrame(frame, Date.now());
        send({ type: 'container_snapshot', ...snapshot });
      }
      if (message.type === 'container_action') {
        containerCalls.push(message);
        if (message.action === 'logs') {
          send({ type: 'container_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: '2026-09-23 10:00:01 GET /\n', stderr: '' });
          return;
        }
        if (message.action === 'inspect') {
          const inspectData = [{
            Id: message.target,
            Config: {
              Image: 'nginx:1.25',
              Labels: {
                'com.docker.compose.project.working_dir': '/opt/web-app',
                'com.docker.compose.service': 'web-nginx',
              },
            },
          }];
          send({ type: 'container_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: JSON.stringify(inspectData), stderr: '' });
          return;
        }
        send({ type: 'container_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: message.target, stderr: '' });
      }
    });
  });
  // 计划任务模拟 WebSocket 通道
  await page.routeWebSocket('**/api/cron**', (ws) => {
    cronSockets.push(ws);
    const send = (data: object) => ws.send(JSON.stringify(data));
    let crontabText = [
      '# [EdgeSSH:id=task-1:name=5q+P5pel5pWw5o2u5aSH5Lu9:type=script:script=L3Jvb3Qvc2NyaXB0cy9iYWNrdXAuc2g=:enabled=1]',
      '0 3 * * * /bin/bash /root/scripts/backup.sh',
      '',
      '# 系统日志清理',
      '0 2 * * 0 /usr/sbin/logrotate /etc/logrotate.conf',
    ].join('\n');

    ws.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      const message = JSON.parse(raw);
      calls.push(message);
      if (message.type === 'cron_action') {
        cronCalls.push(message);
        if (message.action === 'list') {
          send({ type: 'cron_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: crontabText, stderr: '' });
        } else if (message.action === 'save') {
          crontabText = Buffer.from(message.payload?.base64Data || '', 'base64').toString('utf8');
          send({ type: 'cron_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: '', stderr: '' });
        } else if (message.action === 'run') {
          send({ type: 'cron_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: 'Backup finished successfully. 12 files archived.\n', stderr: '' });
        } else if (message.action === 'save_script') {
          send({ type: 'cron_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: '', stderr: '' });
        } else if (message.action === 'read_script') {
          send({ type: 'cron_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: '#!/bin/bash\necho "demo script"\n', stderr: '' });
        } else {
          send({ type: 'cron_action_result', requestId: message.requestId, ok: true, exitStatus: 0, stdout: 'ok', stderr: '' });
        }
      }
    });
  });
  // 默认在这里导航。若调用方需要先注册自己的 /api 路由（例如覆盖片段列表），
  // 传 skipNavigate: true，注册完再调用返回的 navigate()——Playwright 按注册
  // 顺序匹配路由，先注册者优先，晚注册的覆盖规则永远排在本函数之后。
  if (!options.skipNavigate) {
    await page.goto('/');
    await page.locator('#rail-files').click();
  }
  return {
    hosts, calls, sshSockets, sftpSockets, uploaded, directories, containerSockets, containerCalls, cronSockets, cronCalls,
    async navigate() {
      await page.goto('/');
      await page.locator('#rail-files').click();
    },
  };
}

export async function connectFiles(page: Page, id = 'alpha') {
  await page.locator('#files-host').selectOption(id);
  await page.locator('#files-connect').click();
}
