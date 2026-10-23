import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContainerActionCommand, parseContainerFrame, retainContainerMarkerPrefix,
  CONTAINER_SNAPSHOT_MARKER,
} from '../src/backend/container-command.ts';

test('容器帧解析合并 ps 与 stats，并读取镜像数', () => {
  const frame = [
    'abc123def456\tweb-nginx\tnginx:1.25\trunning\tUp 3 hours\t2026-09-20 09:00\t0.0.0.0:80->80/tcp',
    'aaa111bbb222\tdb\tpostgres:16\texited\tExited (0) 2 hours ago\t2026-09-18 12:00\t',
    '__CF_WEBSSH_STATS__',
    'abc123def456\t0.05%\t32MiB / 1GiB\t3.12%\t1.2kB / 3.4kB\t8MB / 12MB\t12',
    '__CF_WEBSSH_IMAGES__7',
  ].join('\n');
  const snapshot = parseContainerFrame(frame, 1_700_000_000_000);
  assert.equal(snapshot.images, 7);
  assert.equal(snapshot.containers.length, 2);
  const web = snapshot.containers.find((item) => item.name === 'web-nginx')!;
  assert.equal(web.id, 'abc123def456');
  assert.equal(web.state, 'running');
  assert.equal(web.image, 'nginx:1.25');
  assert.equal(web.ports, '0.0.0.0:80->80/tcp');
  // stats 行按 ID 合并到同一容器。
  assert.equal(web.cpuPercent, '0.05%');
  assert.equal(web.memoryPercent, '3.12%');
  assert.equal(web.netIo, '1.2kB / 3.4kB');
  assert.equal(web.pids, 12);
  const db = snapshot.containers.find((item) => item.name === 'db')!;
  assert.equal(db.state, 'exited');
  assert.equal(db.cpuPercent, null);
});

test('没有容器时返回空列表而不是 null', () => {
  const snapshot = parseContainerFrame('__CF_WEBSSH_IMAGES__3\n', 1);
  assert.deepEqual(snapshot.containers, []);
  assert.equal(snapshot.images, 3);
});

test('未知状态归一化为 unknown，畸形行被丢弃', () => {
  const snapshot = parseContainerFrame([
    'id1\tweird\timg\tnotastate\tUp\t2026\t\t',
    '只有三列',
  ].join('\n'), 1);
  assert.equal(snapshot.containers.length, 1);
  assert.equal(snapshot.containers[0].state, 'unknown');
});

test('容器动作命令白名单', () => {
  assert.equal(buildContainerActionCommand('stop', 'web-nginx', undefined), 'docker stop web-nginx');
  assert.equal(buildContainerActionCommand('restart', 'db-1', undefined), 'docker restart db-1');
  assert.equal(buildContainerActionCommand('rmi', 'nginx:1.25', undefined), 'docker rmi nginx:1.25');
  assert.equal(buildContainerActionCommand('logs', 'web', 500), 'docker logs --tail 500 web');
  // 默认行数
  assert.equal(buildContainerActionCommand('logs', 'web', undefined), 'docker logs --tail 200 web');
  // 超长 tail 被截断到上限
  assert.equal(buildContainerActionCommand('logs', 'web', 999_999), 'docker logs --tail 2000 web');
});

test('容器动作拒绝注入与越界参数', () => {
  // 命令注入面：分号、反引号、$()、换行全部拒绝。
  for (const target of ['web; rm -rf /', 'web`id`', 'web$(id)', 'web\nstop', 'web && stop',
    'web|stop', 'web>out', '-web', '.web', 'web name', '', 'web:', ':web', 'web::tag', '/web']) {
    assert.equal(buildContainerActionCommand('stop', target, undefined), null, `target: ${target}`);
  }
  // 未知动作
  assert.equal(buildContainerActionCommand('exec', 'web', undefined), null);
  assert.equal(buildContainerActionCommand('', 'web', undefined), null);
  assert.equal(buildContainerActionCommand('stop', 42, undefined), null);
  // 非 logs 动作不接受 tail
  assert.equal(buildContainerActionCommand('stop', 'web', 100), null);
  // logs 的 tail 非法时回落到默认行数，而不是报错
  assert.equal(buildContainerActionCommand('logs', 'web', -1), 'docker logs --tail 200 web');
  assert.equal(buildContainerActionCommand('logs', 'web', 1.5), 'docker logs --tail 200 web');
  assert.equal(buildContainerActionCommand('logs', 'web', '500'), 'docker logs --tail 200 web');
  assert.equal(buildContainerActionCommand('logs', 'web', 0), 'docker logs --tail 200 web');
});

test('合法容器名与 ID 通过校验', () => {
  for (const target of ['web', 'web-1', 'web_1', 'web.1', 'WebApp', 'abc123def456',
    'a'.repeat(128), 'nginx:latest', 'registry.io:5000/app:1.2']) {
    assert.ok(buildContainerActionCommand('stop', target, undefined), `target: ${target}`);
  }
});

test('标记行跨 chunk 不断帧', () => {
  assert.equal(retainContainerMarkerPrefix('abc__CF_WEBSSH_DOC'), '__CF_WEBSSH_DOC');
  assert.equal(retainContainerMarkerPrefix('__CF_WEBSSH_DO'), '__CF_WEBSSH_DO');
  assert.equal(retainContainerMarkerPrefix('完整的一行'), '');
  assert.equal(CONTAINER_SNAPSHOT_MARKER, '__CF_WEBSSH_DOCKER__');
});
