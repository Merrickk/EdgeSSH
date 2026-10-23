/**
 * Docker 容器管理的远端命令与快照解析。
 *
 * 与进程监控一样，容器通道是一条常驻 exec：循环输出 `docker ps`（列表）
 * 与 `docker stats`（资源占用），用标记行分帧。容器名的格式由
 * `--format` 固定，因此解析不依赖人类可读列宽。
 *
 * 没有 docker 的主机会在首个标记行前退出（exit 127 / command not found），
 * 由前端把这种"缺失"与"执行失败"区分开，提示安装 Docker。
 */

import { retainTrailingMarkerPrefix } from './process-framing.ts';

export const CONTAINER_SNAPSHOT_MARKER = '__CF_WEBSSH_DOCKER__';
const MARKER_ESCAPED = '\\137\\137CF_WEBSSH_DOCKER\\137\\137';
/**
 * ps 段与 stats 段之间的阶段标记。两个子命令都输出 7 列 TAB 分隔行，
 * 只能靠这个显式标记区分，不能用列数或内容猜。
 */
const STATS_SECTION_PREFIX = '__CF_WEBSSH_STATS__';

/** 容器状态；与 `docker ps --format '{{.State}}'` 的取值对齐。 */
export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'unknown';

export interface ContainerEntry {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  created: string;
  ports: string;
  /** `docker stats` 的 CPU 百分比字符串，如 "0.05%"；无数据时为 null。 */
  cpuPercent: string | null;
  memoryUsage: string | null;
  memoryPercent: string | null;
  netIo: string | null;
  blockIo: string | null;
  pids: number | null;
}

export interface ContainerSnapshot {
  containers: ContainerEntry[];
  images: number | null;
  timestamp: number;
}

/** 单次容器动作（start/stop/restart/rm/rmi/logs）的结果。 */
export interface ContainerActionResult {
  ok: boolean;
  exitStatus: number | null;
  stdout: string;
  stderr: string;
}

const MAX_CONTAINERS = 512;
const MAX_OUTPUT_BYTES = 32 * 1024;
/** 单个格式字段的字符上限，防止异常输出把快照撑大。 */
const MAX_FIELD_LENGTH = 512;
const TAB = '\t';

/**
 * 常驻 exec 命令：每轮先输出空标记行，再依次输出
 * `docker ps -a`、`docker stats --no-stream`、`docker images -q | wc -l`。
 * 三个子命令都设置了 2>/dev/null 与 `|| true`，缺一项不影响其他项。
 */
export const CONTAINER_MONITOR_COMMAND = `LC_ALL=C LANG=C sh -c 'while :; do printf "${MARKER_ESCAPED}\\n"; docker ps -a --no-trunc --format "{{.ID}}${TAB}{{.Names}}${TAB}{{.Image}}${TAB}{{.State}}${TAB}{{.Status}}${TAB}{{.CreatedAt}}${TAB}{{.Ports}}" 2>/dev/null || true; printf "${STATS_SECTION_PREFIX}\\n"; docker stats --no-stream --format "{{.ID}}${TAB}{{.CPUPerc}}${TAB}{{.MemUsage}}${TAB}{{.MemPerc}}${TAB}{{.NetIO}}${TAB}{{.BlockIO}}${TAB}{{.PIDs}}" 2>/dev/null || true; printf "__CF_WEBSSH_IMAGES__%s\\n" "$(docker images -q 2>/dev/null | wc -l | tr -d " ")" 2>/dev/null || true; sleep 5; done'`;

/** 镜像数量行前缀。 */
const IMAGES_PREFIX = '__CF_WEBSSH_IMAGES__';


function normalizeState(raw: string): ContainerState {
  const value = raw.trim().toLowerCase();
  const known: ContainerState[] = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'];
  return (known as string[]).includes(value) ? value as ContainerState : 'unknown';
}

function cleanField(value: string | undefined, max = MAX_FIELD_LENGTH): string {
  return (value ?? '').replace(/[\0\r\n]/g, ' ').trim().slice(0, max);
}

function parseContainerRow(line: string): ContainerEntry | null {
  const fields = line.split(TAB);
  if (fields.length < 7) return null;
  const [id, name, image, state, status, created, ...portParts] = fields;
  if (!id.trim() || !name.trim()) return null;
  return {
    id: cleanField(id, 128),
    name: cleanField(name, 256),
    image: cleanField(image, 256),
    state: normalizeState(state),
    status: cleanField(status),
    created: cleanField(created),
    ports: cleanField(portParts.join(TAB)),
    cpuPercent: null,
    memoryUsage: null,
    memoryPercent: null,
    netIo: null,
    blockIo: null,
    pids: null,
  };
}

function parseStatsRow(line: string): { id: string; entry: Partial<ContainerEntry> } | null {
  const fields = line.split(TAB);
  if (fields.length < 7) return null;
  const [id, cpu, memUsage, memPerc, netIo, blockIo, pids] = fields;
  if (!id.trim()) return null;
  const pidsValue = Number.parseInt(cleanField(pids, 16), 10);
  return {
    id: cleanField(id, 128),
    entry: {
      cpuPercent: cleanField(cpu, 32) || null,
      memoryUsage: cleanField(memUsage, 64) || null,
      memoryPercent: cleanField(memPerc, 32) || null,
      netIo: cleanField(netIo, 64) || null,
      blockIo: cleanField(blockIo, 64) || null,
      pids: Number.isFinite(pidsValue) && pidsValue >= 0 ? pidsValue : null,
    },
  };
}

/** 把一个标记帧（marker 之后到下一个 marker 之前的文本）解析成快照。 */
export function parseContainerFrame(frame: string, timestamp: number): ContainerSnapshot {
  const byId = new Map<string, ContainerEntry>();
  let images: number | null = null;
  let inStats = false;

  for (const rawLine of frame.split(/\r?\n/)) {
    // 只去掉换行残留，不能 trim 整行：末尾的 TAB 是 ps 的空 Ports 字段，
    // trim 会把最后一个字段一起吃掉，导致该行被当作畸形行丢弃。
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.trimStart().startsWith(STATS_SECTION_PREFIX)) { inStats = true; continue; }
    if (line.trimStart().startsWith(IMAGES_PREFIX)) {
      const value = Number.parseInt(line.trimStart().slice(IMAGES_PREFIX.length).trim(), 10);
      images = Number.isFinite(value) && value >= 0 ? value : null;
      continue;
    }
    if (inStats) {
      // stats 段：按 ID 合并到 ps 段已登记的容器；未登记的 ID 直接忽略。
      const parsed = parseStatsRow(line.replace(/\s+$/, ''));
      const target = parsed ? byId.get(parsed.id) : undefined;
      if (target && parsed) Object.assign(target, parsed.entry);
      continue;
    }
    const container = parseContainerRow(line);
    if (container) byId.set(container.id, container);
  }

  return {
    containers: [...byId.values()].slice(0, MAX_CONTAINERS),
    images,
    timestamp,
  };
}

/** 保留尾部可能不完整的标记行，避免跨 chunk 断帧。 */
export function retainContainerMarkerPrefix(buffer: string): string {
  return retainTrailingMarkerPrefix(buffer, CONTAINER_SNAPSHOT_MARKER);
}

export const CONTAINER_ACTION_OUTPUT_LIMIT = MAX_OUTPUT_BYTES;

/**
 * 容器动作白名单。每个动作只接受"容器名 / 容器 ID"一个参数，
 * 且严格限定字符集，因此不存在命令注入面。
 */
const CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart', 'rm', 'rmi', 'logs', 'pause', 'unpause']);

/**
 * 单个路径段的合法字符：Docker 自身规则是 [a-zA-Z0-9][a-zA-Z0-9_.-]。
 * 镜像引用 `registry:5000/app:1.2` 由多个段与冒号组成，逐段校验。
 */
const TARGET_SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_TAIL_LINES = 2000;
/** 默认日志行数，与前端下拉的 200 对齐。 */
const DEFAULT_LOG_TAIL = 200;

/**
 * 构造一次性 docker 命令；返回 null 表示请求不合法（由调用方抛错）。
 * `rmi` 的 target 允许 `name:tag`，因此额外接受一个冒号分段。
 */
export function buildContainerActionCommand(
  action: unknown, target: unknown, tail: unknown,
): string | null {
  if (typeof action !== 'string' || !CONTAINER_ACTIONS.has(action)) return null;
  if (typeof target !== 'string' || target.length === 0 || target.length > 255) return null;
  if (!isValidDockerTarget(target)) return null;
  if (action === 'logs') {
    const lines = typeof tail === 'number' && Number.isSafeInteger(tail) && tail > 0
      ? Math.min(tail, MAX_TAIL_LINES)
      : DEFAULT_LOG_TAIL;
    return `docker logs --tail ${lines} ${target}`;
  }
  if (tail !== undefined) return null;
  if (action === 'rmi') return `docker rmi ${target}`;
  return `docker ${action} ${target}`;
}

/**
 * 校验容器名 / 容器 ID / 镜像引用。
 * 镜像引用形如 `registry:5000/app:1.2`，按 `/` 分段、段内按 `:` 分段，
 * 每一段都必须是 Docker 的合法字符集，因此 shell 元字符无法通过。
 */
function isValidDockerTarget(target: string): boolean {
  return target.split('/').every((segment) => segment !== '' && segment.split(':').every((part) => TARGET_SEGMENT_PATTERN.test(part)));
}
