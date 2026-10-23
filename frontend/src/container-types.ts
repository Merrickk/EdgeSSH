/** 容器管理的共享类型与标签，前后端共用同一套状态名。 */

export type ContainerState =
  | 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'unknown';

export const CONTAINER_STATES: ContainerState[] = [
  'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown',
];

export interface ContainerEntry {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  created: string;
  ports: string;
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

export interface ContainerActionResult {
  ok: boolean;
  exitStatus: number | null;
  stdout: string;
  stderr: string;
}

export function isRunning(state: ContainerState): boolean {
  return state === 'running';
}
