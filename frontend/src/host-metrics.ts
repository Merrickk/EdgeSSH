/**
 * 总览卡片上的主机指标缓存。
 *
 * EdgeSSH 是按需 SSH，没有常驻探针，所以卡片上的 CPU/内存/磁盘/网络
 * 取自"最近一次连接"时进程监控通道的快照，落 localStorage；未连接过
 * 的主机只显示占位。CF Tunnel 只负责把 SSH/WS 流量代理到 Worker，本身
 * 不提供探针上报能力，因此这里不做后台定时采集。
 */

export type MetricKey = 'cpu' | 'memory' | 'disk' | 'network';

export interface MetricUsage {
  percent: number;
  /** 已用量（字节），用于副标题。 */
  used: number;
  total: number;
  /** 网络速率（字节/秒）；其他指标为 null。 */
  rate?: { up: number; down: number } | null;
}

export type HostSnapshot = Partial<Record<MetricKey, MetricUsage>>;

const STORAGE_KEY = 'cf-webssh.host-metrics';
/** 超过该时长的快照视为过期，卡片回落到占位状态。 */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface StoredSnapshot extends HostSnapshot {
  at: number;
}

type Store = Record<string, StoredSnapshot>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch { return {}; }
}

export function readHostSnapshot(hostId: string): HostSnapshot | null {
  const entry = readStore()[hostId];
  if (!entry || typeof entry.at !== 'number' || Date.now() - entry.at > MAX_AGE_MS) return null;
  const { at: _at, ...usage } = entry;
  return usage;
}

export function writeHostSnapshot(hostId: string, snapshot: HostSnapshot): void {
  if (!hostId) return;
  try {
    const store = readStore();
    store[hostId] = { ...snapshot, at: Date.now() };
    // 只保留最近 50 台，避免 localStorage 无限增长。
    const trimmed = Object.fromEntries(
      Object.entries(store).sort((left, right) => right[1].at - left[1].at).slice(0, 50),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch { /* 隐私模式下写入失败可以忽略，卡片回落到占位。 */ }
}

export function clearHostSnapshot(hostId: string): void {
  try {
    const store = readStore();
    delete store[hostId];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch { /* ignore */ }
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit++; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 磁盘与网络在 SSH 会话里没有现成来源时显示为占位，由调用方决定是否写入。 */
export function mergeSnapshot(base: HostSnapshot, patch: HostSnapshot): HostSnapshot {
  return { ...base, ...patch };
}
