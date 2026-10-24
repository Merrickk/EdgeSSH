import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCrontab,
  formatCrontab,
  buildCronActionCommand,
  toBase64,
  fromBase64,
  type CronTask,
} from '../src/backend/cron-command.ts';

test('Base64 编解码支持中文与特殊字符', () => {
  const original = '测试数据备份\n# echo "hello" & $path';
  const b64 = toBase64(original);
  assert.equal(fromBase64(b64), original);
});

test('解析与格式化 EdgeSSH 标记的任务', () => {
  const tasks: CronTask[] = [
    {
      id: 'task-1',
      name: '每日零点备份',
      schedule: '0 0 * * *',
      command: 'sh /root/backup.sh',
      enabled: true,
      type: 'command',
    },
    {
      id: 'task-2',
      name: 'Docker 升级脚本',
      schedule: '0 3 * * 0',
      command: '/bin/bash /root/scripts/upgrade.sh',
      enabled: false,
      type: 'script',
      scriptPath: '/root/scripts/upgrade.sh',
    },
  ];

  const formatted = formatCrontab(tasks);
  assert.match(formatted, /# \[EdgeSSH:id=task-1/);
  assert.match(formatted, /0 0 \* \* \* sh \/root\/backup\.sh/);
  assert.match(formatted, /# \[DISABLED\] 0 3 \* \* 0/);

  const parsed = parseCrontab(formatted);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'task-1');
  assert.equal(parsed[0].name, '每日零点备份');
  assert.equal(parsed[0].enabled, true);
  assert.equal(parsed[1].id, 'task-2');
  assert.equal(parsed[1].name, 'Docker 升级脚本');
  assert.equal(parsed[1].enabled, false);
  assert.equal(parsed[1].type, 'script');
  assert.equal(parsed[1].scriptPath, '/root/scripts/upgrade.sh');
});

test('兼容解析普通第三方系统的 crontab 注释和行', () => {
  const raw = [
    '# 系统日志清理',
    '30 2 * * * /usr/sbin/logrotate /etc/logrotate.conf',
    '',
    '# [DISABLED] 0 12 * * * echo "noon"',
    '# 普通未命名任务',
    '@reboot /usr/local/bin/on_boot.sh',
  ].join('\n');

  const parsed = parseCrontab(raw);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, '系统日志清理');
  assert.equal(parsed[0].schedule, '30 2 * * *');
  assert.equal(parsed[0].enabled, true);

  assert.equal(parsed[1].enabled, false);
  assert.equal(parsed[1].schedule, '0 12 * * *');

  assert.equal(parsed[2].schedule, '@reboot');
  assert.equal(parsed[2].enabled, true);
});

test('构造 cron 命令安全防注入', () => {
  assert.equal(buildCronActionCommand('list'), 'crontab -l 2>/dev/null || true');

  const validB64 = toBase64('0 0 * * * echo test\n');
  const saveCmd = buildCronActionCommand('save', { base64Data: validB64 });
  assert.match(saveCmd!, /^printf "%s" "[A-Za-z0-9+/=]+" \| base64 -d \| crontab -$/);

  // 恶意 base64 注入测试
  assert.equal(buildCronActionCommand('save', { base64Data: 'abc"; rm -rf /; echo "' }), null);
  assert.equal(buildCronActionCommand('save', { base64Data: '' }), null);

  // 路径注入测试
  assert.equal(buildCronActionCommand('read_script', { path: '/root/test.sh' }), 'cat "/root/test.sh" 2>/dev/null || true');
  assert.equal(buildCronActionCommand('read_script', { path: '/root/test; rm -rf /' }), null);
  assert.equal(buildCronActionCommand('read_script', { path: 'relative/path.sh' }), null);
  assert.equal(buildCronActionCommand('read_script', { path: '' }), null);

  // 保存脚本命令
  const saveScriptCmd = buildCronActionCommand('save_script', {
    path: '/root/scripts/task.sh',
    base64Data: toBase64('#!/bin/bash\necho hello'),
  });
  assert.match(saveScriptCmd!, /^mkdir -p "\/root\/scripts" && printf "%s" "[A-Za-z0-9+/=]+" \| base64 -d > "\/root\/scripts\/task\.sh" && chmod \+x "\/root\/scripts\/task\.sh"$/);
});
