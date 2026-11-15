import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRecreateCommand, buildUpgradeModeCommand, detectUpgradeStrategy,
  fallbackUpgradeDetection,
} from '../frontend/src/container-upgrade.ts';

const entry = { name: 'web-nginx', image: 'nginx:1.25' };
const common = {
  Id: 'abc123',
  Config: { Image: 'nginx:1.25', Env: ['MODE=production'], Cmd: ['nginx', '-g', 'daemon off;'] },
  HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } },
  Mounts: [{ Type: 'bind', Source: '/srv/www', Destination: '/usr/share/nginx/html', RW: true }],
};

function composeInspect(image = 'nginx:1.25') {
  return [{
    ...common,
    Config: {
      ...common.Config,
      Image: image,
      Labels: {
        'com.docker.compose.project': 'web-app',
        'com.docker.compose.project.working_dir': '/opt/web-app',
        'com.docker.compose.project.config_files': '/opt/web-app/compose.yaml',
        'com.docker.compose.service': 'web-nginx',
      },
    },
    RepoDigests: [],
  }];
}

test('非 Compose 容器会自动拉取镜像并按 inspect 参数重建，而不是 restart', () => {
  const detected = detectUpgradeStrategy([{ ...common, RepoDigests: [] }], entry);
  assert.equal(detected.isCompose, false);
  assert.equal(detected.recommendedMode, 'image_pull');
  assert.equal(detected.recommendedCommand.includes('docker restart'), false);
  assert.match(detected.recommendedCommand, /^docker pull 'nginx:1.25' && /);
  assert.match(detected.recommendedCommand, /docker run -d/);
  assert.match(detected.recommendedCommand, /MODE=production/);
  assert.match(detected.recommendedCommand, /8080:80\/tcp/);
  assert.match(detected.recommendedCommand, /\/srv\/www/);
  assert.match(detected.recommendedCommand, /docker rename "\$backup" "\$name"/);
  assert.ok(detected.recommendedCommand.length <= 2048);
  assert.match(detected.hint, /按 inspect 参数/);
});

test('Compose 容器镜像名不含 / 时选中 Git 源码更新', () => {
  const detected = detectUpgradeStrategy(composeInspect('nginx:1.25'), entry);
  assert.equal(detected.isCompose, true);
  assert.equal(detected.recommendedMode, 'compose_git');
  assert.equal(detected.recommendedCommand, "cd '/opt/web-app' && git pull && docker compose up -d --build");
  assert.match(detected.badge, /Git/);
  assert.match(detected.hint, /不含/);
});

test('Compose 容器镜像名含 / 时选中 Compose 镜像更新', () => {
  const remote = { ...entry, image: 'ghcr.io/acme/web:v2' };
  const detected = detectUpgradeStrategy(composeInspect(remote.image), remote);
  assert.equal(detected.isCompose, true);
  assert.equal(detected.recommendedMode, 'compose_pull');
  assert.equal(detected.recommendedCommand, "cd '/opt/web-app' && docker compose pull && docker compose up -d");
  assert.equal(detected.recommendedCommand.includes('git pull'), false);
  assert.match(detected.hint, /含 \//);
});

test('镜像名判断使用列表显示的 image，inspect 中的镜像名不覆盖它', () => {
  const detected = detectUpgradeStrategy(composeInspect('ghcr.io/acme/web:v2'), { ...entry, image: 'nginx:1.25' });
  assert.equal(detected.recommendedMode, 'compose_git');
  assert.match(detected.recommendedCommand, /git pull/);
});

test('三个单选模式分别生成对应命令，且非 Compose 手动选 Compose 模式会安全回退', () => {
  const detected = detectUpgradeStrategy(composeInspect('nginx:1.25'), entry);
  assert.match(buildUpgradeModeCommand('compose_git', entry, detected).command, /git pull && docker compose up -d --build/);
  assert.match(buildUpgradeModeCommand('compose_pull', entry, detected).command, /docker compose pull && docker compose up -d/);
  assert.match(buildUpgradeModeCommand('image_pull', entry, detected).command, /^docker pull 'nginx:1.25' && .*docker compose up -d --force-recreate/);

  const standalone = detectUpgradeStrategy([{ ...common, RepoDigests: [] }], entry);
  for (const mode of ['compose_git', 'compose_pull'] as const) {
    const result = buildUpgradeModeCommand(mode, entry, standalone);
    assert.equal(result.command.includes('git pull'), false);
    assert.equal(result.command.includes('docker compose'), false);
    assert.equal(result.command.includes('docker restart'), false);
    assert.match(result.command, /^docker pull 'nginx:1.25' && /);
    assert.match(result.command, /docker run -d/);
  }
});

test('编辑容器仍按 inspect 参数重建且失败时自动回滚旧容器', () => {
  const recreate = buildRecreateCommand(common, entry.name);
  assert.match(recreate, /docker run -d/);
  assert.match(recreate, /MODE=production/);
  assert.match(recreate, /8080:80\/tcp/);
  assert.match(recreate, /\/srv\/www/);
  assert.match(recreate, /docker rename "\$name" "\$backup"/);
  assert.match(recreate, /docker rename "\$backup" "\$name"/);
  assert.match(recreate, /docker start "\$name"/);
});

test('inspect 失败与畸形响应回退为直接 pull，不生成 git 或 compose', () => {
  for (const response of [undefined, null, [], {}, 'not-json']) {
    const detected = detectUpgradeStrategy(response, entry);
    assert.deepEqual(detected, fallbackUpgradeDetection(entry));
  }
  const fallback = fallbackUpgradeDetection(entry);
  assert.equal(fallback.recommendedMode, 'image_pull');
  assert.equal(fallback.recommendedCommand, "docker pull 'nginx:1.25'");
  assert.equal(fallback.recommendedCommand.includes('docker restart'), false);
  assert.equal(fallback.recreateCommand, null);
});
