/**
 * Linux 计划任务 (Cron) 远端交互与 Crontab 解析器。
 *
 * 核心机制：
 * - 读取：通过 `crontab -l` 读取当前用户的定时任务列表并结构化解析；
 * - 保存：将结构化任务重新组装为符合 crontab 规范的文本，通过管道回写；
 * - 执行文件：支持把脚本写入服务器指定路径并赋予执行权限 (`chmod +x`)；
 * - 立即运行：支持手动执行一次任务，输出返回给前端弹窗展示。
 */

export type CronTaskType = 'command' | 'script';

export interface CronTask {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  type: CronTaskType;
  scriptPath?: string;
}

export interface CronSnapshot {
  tasks: CronTask[];
  rawText: string;
  timestamp: number;
}

/** 动作支持：list / save / run / save_script / read_script */
export type CronAction = 'list' | 'save' | 'run' | 'save_script' | 'read_script';

const CRON_PREFIX = '# [EdgeSSH:';
const DISABLED_PREFIX = '# [DISABLED] ';

/**
 * 校验路径安全，防止路径遍历或参数逃逸。
 */
function isValidFilePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
  if (!path.startsWith('/') || /[\0\r\n`$<>|;&]/.test(path)) return false;
  return true;
}

/**
 * 校验 Base64 编码字符串，防止 shell 命令参数注入。
 */
function isValidBase64(str: unknown): str is string {
  if (typeof str !== 'string' || str.length === 0 || str.length > 256 * 1024) return false;
  return /^[A-Za-z0-9+/=]+$/.test(str.trim());
}

/**
 * 将 Unicode 文本编码为标准 Base64。
 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * 解码 Base64 文本为 Unicode。
 */
export function fromBase64(b64: string): string {
  const binary = atob(b64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * 判断是否为 Linux 系统 crontab 自带的标准模板指引注释（如 # m h dom mon dow command 等），
 * 避免把系统语法说明行误当成用户的任务名称。
 */
function isGenericCrontabHeader(comment: string): boolean {
  const norm = comment.toLowerCase().trim();
  if (!norm) return true;
  if (/\bm\s+h\s+dom\s+mon\s+dow(\s+command)?\b/i.test(norm)) return true;
  if (/^(edit this file|each task to run|for more information see|for example|minute\s+hour)/i.test(norm)) return true;
  return false;
}

/**
 * 解析用户 crontab 文本为结构化的 CronTask 列表。
 * 同时兼顾 EdgeSSH 自身元数据注释与用户原有的第三方 crontab 记录。
 */
export function parseCrontab(raw: string): CronTask[] {
  const tasks: CronTask[] = [];
  const lines = raw.split(/\r?\n/);
  let pendingMeta: Partial<CronTask> | null = null;
  let prevComment = '';

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    const line = originalLine.trim();
    if (!line) {
      prevComment = '';
      continue;
    }

    // 1. 识别 EdgeSSH 专属元数据行：# [EdgeSSH:id=xxx:name=b64:type=xxx:script=b64:enabled=1]
    if (line.startsWith(CRON_PREFIX) && line.endsWith(']')) {
      const content = line.slice(CRON_PREFIX.length, -1);
      const meta: Record<string, string> = {};
      for (const part of content.split(':')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          meta[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
        }
      }
      try {
        pendingMeta = {
          id: meta.id || `task-${tasks.length + 1}`,
          name: meta.name ? fromBase64(meta.name) : '未命名任务',
          type: (meta.type === 'script' ? 'script' : 'command') as CronTaskType,
          scriptPath: meta.script ? fromBase64(meta.script) : undefined,
          enabled: meta.enabled !== '0',
        };
      } catch {
        pendingMeta = null;
      }
      continue;
    }

    // 2. 识别普通注释，过滤掉标准模板头部语法说明
    if (line.startsWith('#') && !line.startsWith(DISABLED_PREFIX)) {
      const comment = line.replace(/^#+\s*/, '').trim();
      if (!isGenericCrontabHeader(comment)) {
        prevComment = comment;
      }
      continue;
    }

    // 3. 检查是否为停用任务：# [DISABLED] 0 3 * * * command
    const isDisabled = line.startsWith(DISABLED_PREFIX);
    const activeLine = isDisabled ? line.slice(DISABLED_PREFIX.length).trim() : line;

    // 4. 解析 cron 表达式与命令（支持标准 5 段如 `0 3 * * *` 或 `@reboot`）
    const parsed = parseCronLine(activeLine);
    if (!parsed) continue;

    const id = pendingMeta?.id || `cron-${tasks.length + 1}`;
    const name = pendingMeta?.name || prevComment || parsed.command.slice(0, 48);
    const taskType = pendingMeta?.type || (parsed.command.includes('.sh') ? 'script' : 'command');
    const enabled = pendingMeta?.enabled !== undefined ? pendingMeta.enabled : !isDisabled;

    tasks.push({
      id,
      name,
      schedule: parsed.schedule,
      command: parsed.command,
      enabled,
      type: taskType,
      scriptPath: pendingMeta?.scriptPath,
    });

    pendingMeta = null;
    prevComment = '';
  }

  return tasks;
}

/**
 * 提取时间表达式与命令行。
 */
function parseCronLine(line: string): { schedule: string; command: string } | null {
  if (line.startsWith('@')) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx < 0) return null;
    return {
      schedule: line.slice(0, spaceIdx).trim(),
      command: line.slice(spaceIdx + 1).trim(),
    };
  }
  const parts = line.split(/\s+/);
  if (parts.length < 6) return null;
  // 前 5 段是分、时、日、月、周
  const schedule = parts.slice(0, 5).join(' ');
  const command = parts.slice(5).join(' ');
  return { schedule, command };
}

/**
 * 将结构化任务组装为标准的 crontab 格式文本。
 */
export function formatCrontab(tasks: CronTask[]): string {
  const chunks: string[] = [
    '# Crontab managed by EdgeSSH · Generated automatically',
    '',
  ];

  for (const task of tasks) {
    const metaParts = [
      `id=${task.id}`,
      `name=${toBase64(task.name)}`,
      `type=${task.type}`,
      `enabled=${task.enabled ? '1' : '0'}`,
    ];
    if (task.scriptPath) {
      metaParts.push(`script=${toBase64(task.scriptPath)}`);
    }
    chunks.push(`${CRON_PREFIX}${metaParts.join(':')}]`);
    const line = `${task.schedule} ${task.command}`;
    if (!task.enabled) {
      chunks.push(`${DISABLED_PREFIX}${line}`);
    } else {
      chunks.push(line);
    }
    chunks.push('');
  }

  return chunks.join('\n');
}

/**
 * 构造一次性计划任务命令。
 */
export function buildCronActionCommand(
  action: unknown,
  payload: {
    base64Data?: unknown;
    path?: unknown;
  } = {},
): string | null {
  if (action === 'list') {
    return 'crontab -l 2>/dev/null || true';
  }

  if (action === 'save') {
    if (!isValidBase64(payload.base64Data)) return null;
    return `printf "%s" "${payload.base64Data}" | base64 -d | crontab -`;
  }

  if (action === 'run') {
    if (!isValidBase64(payload.base64Data)) return null;
    return `sh -c "$(printf "%s" "${payload.base64Data}" | base64 -d)"`;
  }

  if (action === 'save_script') {
    if (typeof payload.path !== 'string' || !isValidFilePath(payload.path)) return null;
    if (!isValidBase64(payload.base64Data)) return null;
    const dir = payload.path.slice(0, payload.path.lastIndexOf('/')) || '/';
    return `mkdir -p "${dir}" && printf "%s" "${payload.base64Data}" | base64 -d > "${payload.path}" && chmod +x "${payload.path}"`;
  }

  if (action === 'read_script') {
    if (typeof payload.path !== 'string' || !isValidFilePath(payload.path)) return null;
    return `cat "${payload.path}" 2>/dev/null || true`;
  }

  return null;
}
