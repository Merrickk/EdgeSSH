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

const composeInspect = [{
  ...common,
  Config: {
    ...common.Config,
    Labels: {
      'com.docker.compose.project': 'web-app',
      'com.docker.compose.project.working_dir': '/opt/web-app',
      'com.docker.compose.project.config_files': '/opt/web-app/compose.yaml',
      'com.docker.compose.service': 'web-nginx',
    },
  },
  // 本地 build 或旧版 docker inspect 经常没有 RepoDigests；这不能成为 git pull 的依据。
  RepoDigests: [],
}];

test('Compose 容器智能升级永远推荐 compose pull，不自动选择 git 模式', () => {
  const detected = detectUpgradeStrategy(composeInspect, entry);
  assert.equal(detected.isCompose, true);
  assert.equal(detected.recommendedMode, 'compose_pull');
  assert.equal(detected.recommendedCommand.includes('git pull'), false);
  assert.match(detected.recommendedCommand, /docker compose -p 'web-app' -f '\/opt\/web-app\/compose.yaml' pull/);
  const auto = buildUpgradeModeCommand('auto', entry, detected);
  assert.equal(auto.command, detected.recommendedCommand);
  const git = buildUpgradeModeCommand('compose_git', entry, detected);
  assert.match(git.command, /^cd '\/opt\/web-app' && git pull && docker compose/);
  assert.match(git.hint, /手动 Git 模式/);
});

test('远程镜像、命名空间镜像与本地构建镜像均不会误判为 Git 源码更新', () => {
  const variants = [
    { Image: 'nginx:1.25', Labels: {} },
    { Image: 'ghcr.io/acme/web:v2', Labels: { 'com.docker.compose.project': 'acme' } },
    { Image: 'acme-local-build:latest', Labels: { 'com.docker.compose.project': 'acme' } },
  ];
  for (const variant of variants) {
    const inspect = [{
      ...common,
      Config: { ...common.Config, Image: variant.Image, Labels: variant.Labels },
      RepoDigests: variant.Image.includes('/') ? [`${variant.Image}@sha256:test`] : [],
    }];
    const detected = detectUpgradeStrategy(inspect, { ...entry, image: variant.Image });
    assert.notEqual(detected.recommendedMode, 'compose_git');
    assert.equal(detected.recommendedCommand.includes('git pull'), false, `image=${variant.Image}`);
  }
});

test('独立容器按 inspect 参数重建且失败时自动回滚旧容器', () => {
  const detected = detectUpgradeStrategy([{ ...common, RepoDigests: ['nginx@sha256:test'] }], entry);
  assert.equal(detected.isCompose, false);
  assert.equal(detected.recommendedMode, 'image_pull');
  assert.match(detected.recommendedCommand, /docker pull 'nginx:1.25'/);
  assert.match(detected.recommendedCommand, /MODE=production/);
  assert.match(detected.recommendedCommand, /8080:80\/tcp/);
  assert.match(detected.recommendedCommand, /\/srv\/www/);
  const recreate = buildRecreateCommand(common, entry.name);
  assert.match(recreate, /docker rename 'web-nginx' 'web-nginx-edgessh-backup'/);
  assert.match(recreate, /docker rename 'web-nginx-edgessh-backup' 'web-nginx'/);
  assert.match(recreate, /docker start 'web-nginx'/);
});

test('inspect 失败与畸形响应只回退到安全的 pull，不生成 git pull', () => {
  for (const response of [undefined, null, [], {}, 'not-json']) {
    const detected = detectUpgradeStrategy(response, entry);
    assert.deepEqual(detected, fallbackUpgradeDetection(entry));
  }
  const fallback = fallbackUpgradeDetection(entry);
  assert.equal(fallback.recommendedCommand, "docker pull 'nginx:1.25'");
  assert.equal(buildUpgradeModeCommand('auto', entry, fallback).command.includes('git pull'), false);
});
