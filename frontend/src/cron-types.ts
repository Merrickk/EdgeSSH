/** 计划任务类型与 Cron 周期中文人类可读格式化。 */

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

export interface CronActionResult {
  type: 'cron_action_result';
  requestId: string;
  ok: boolean;
  exitStatus: number | null;
  stdout: string;
  stderr: string;
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六', '日'];

/**
 * 将标准 cron 5 段表达式解析为友好的中文解释，
 * 支持 1Panel 常见的各种标准周期。
 */
export function explainCron(cron: string): string {
  const trimmed = cron.trim();
  if (trimmed === '@reboot') return '开机时执行';
  if (trimmed === '@hourly') return '每小时执行一次';
  if (trimmed === '@daily') return '每天 00:00 执行一次';
  if (trimmed === '@weekly') return '每周日 00:00 执行一次';
  if (trimmed === '@monthly') return '每月 1 号 00:00 执行一次';

  const parts = trimmed.split(/\s+/);
  if (parts.length < 5) return trimmed;

  const [min, hour, dom, mon, dow] = parts;

  // 1. 每隔 N 分钟：*/N * * * *
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每隔 ${min.slice(2)} 分钟执行一次`;
  }
  // 2. 每分钟：* * * * *
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return '每分钟执行一次';
  }
  // 3. 每隔 N 小时：0 */N * * *
  if (/^\d+$/.test(min) && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    return `每隔 ${hour.slice(2)} 小时（第 ${min} 分）执行一次`;
  }
  // 4. 每天固定时间：M H * * *
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    const hh = hour.padStart(2, '0');
    const mm = min.padStart(2, '0');
    return `每天 ${hh}:${mm} 执行`;
  }
  // 5. 每周固定时间：M H * * D
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^\d+$/.test(dow)) {
    const hh = hour.padStart(2, '0');
    const mm = min.padStart(2, '0');
    const day = WEEKDAY_NAMES[Number(dow)] ?? dow;
    return `每周${day} ${hh}:${mm} 执行`;
  }
  // 6. 每月固定时间：M H D * *
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
    const hh = hour.padStart(2, '0');
    const mm = min.padStart(2, '0');
    return `每月 ${dom} 号 ${hh}:${mm} 执行`;
  }

  return trimmed;
}

/** 常用 Cron 预设，参考 1Panel。 */
export const CRON_PRESETS = [
  { label: '每天凌晨 03:00', value: '0 3 * * *' },
  { label: '每天凌晨 04:00', value: '0 4 * * *' },
  { label: '每周日凌晨 03:00', value: '0 3 * * 0' },
  { label: '每小时整点', value: '0 * * * *' },
  { label: '每隔 15 分钟', value: '*/15 * * * *' },
  { label: '每隔 30 分钟', value: '*/30 * * * *' },
  { label: '每月 1 号 02:00', value: '0 2 1 * *' },
  { label: '开机自启 (@reboot)', value: '@reboot' },
];
