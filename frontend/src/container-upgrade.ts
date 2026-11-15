import type { ContainerEntry } from './container-types';

export type RecommendedUpgradeMode = 'compose_pull' | 'image_pull';
export type UpgradeMode = 'auto' | RecommendedUpgradeMode | 'compose_git';

export interface UpgradeDetection {
  workingDir: string;
  project: string;
  configFile: string;
  service: string;
  image: string;
  name: string;
  isCompose: boolean;
  recommendedMode: RecommendedUpgradeMode;
  recommendedCommand: string;
  badge: string;
  hint: string;
  composeArgs: string;
  inspectAvailable: boolean;
  recreateCommand: string | null;
}

export interface UpgradeModeCommand {
  command: string;
  hint: string;
  badge: string;
}

type InspectRecord = Record<string, any>;
type UpgradeTarget = Pick<ContainerEntry, 'name' | 'image'>;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function asRecord(value: unknown): InspectRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as InspectRecord : null;
}

function inspectItem(value: unknown): InspectRecord | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  const item = asRecord(candidate);
  if (!item || !asRecord(item.Config)) return null;
  return item;
}

function label(labels: Record<string, unknown>, key: string): string {
  const value = labels[key];
  return typeof value === 'string' ? value.trim() : '';
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '';
}

/** 根据 docker inspect 生成尽量保真、且失败时自动回滚的 docker run 命令。 */
export function buildRecreateCommand(inspect: Record<string, any>, containerName: string): string {
  const config = inspect.Config ?? {};
  const host = inspect.HostConfig ?? {};
  const args = ['docker run -d', `--name ${shellQuote(containerName)}`];
  if (host.RestartPolicy?.Name && host.RestartPolicy.Name !== 'no') {
    args.push(`--restart ${shellQuote(String(host.RestartPolicy.Name))}`);
  }
  if (host.Privileged) args.push('--privileged');
  if (host.ReadonlyRootfs) args.push('--read-only');
  if (host.NetworkMode && !['default', 'bridge'].includes(host.NetworkMode)) {
    args.push(`--network ${shellQuote(String(host.NetworkMode))}`);
  }
  if (host.PidMode) args.push(`--pid ${shellQuote(String(host.PidMode))}`);
  if (host.IpcMode) args.push(`--ipc ${shellQuote(String(host.IpcMode))}`);
  if (host.UsernsMode) args.push(`--userns ${shellQuote(String(host.UsernsMode))}`);
  if (host.CpusetCpus) args.push(`--cpuset-cpus ${shellQuote(String(host.CpusetCpus))}`);
  if (host.NanoCpus) args.push(`--cpus ${Number(host.NanoCpus) / 1e9}`);
  if (host.Memory) args.push(`--memory ${host.Memory}`);
  if (host.MemorySwap) args.push(`--memory-swap ${host.MemorySwap}`);
  if (host.PidsLimit && host.PidsLimit > 0) args.push(`--pids-limit ${host.PidsLimit}`);
  for (const [key, value] of Object.entries(config.Labels ?? {})) {
    args.push(`--label ${shellQuote(`${key}=${value}`)}`);
  }
  for (const env of config.Env ?? []) args.push(`--env ${shellQuote(String(env))}`);
  for (const [containerPort, bindings] of Object.entries(host.PortBindings ?? {})) {
    for (const binding of (bindings as Array<{ HostIp?: string; HostPort?: string }> | null) ?? []) {
      if (!binding.HostPort) continue;
      const hostIp = binding.HostIp && binding.HostIp !== '0.0.0.0' ? `${binding.HostIp}:` : '';
      args.push(`--publish ${shellQuote(`${hostIp}${binding.HostPort}:${containerPort}`)}`);
    }
  }
  for (const mount of inspect.Mounts ?? []) {
    if (mount.Type !== 'bind' && mount.Type !== 'volume') continue;
    const source = mount.Type === 'bind' ? mount.Source : mount.Name;
    args.push(`--volume ${shellQuote(`${source}:${mount.Destination}${mount.RW ? '' : ':ro'}`)}`);
  }
  if (host.LogConfig?.Type && host.LogConfig.Type !== 'json-file') {
    args.push(`--log-driver ${shellQuote(String(host.LogConfig.Type))}`);
  }
  for (const [key, value] of Object.entries(host.LogConfig?.Config ?? {})) {
    args.push(`--log-opt ${shellQuote(`${key}=${value}`)}`);
  }
  if (config.WorkingDir) args.push(`--workdir ${shellQuote(String(config.WorkingDir))}`);
  if (config.User) args.push(`--user ${shellQuote(String(config.User))}`);
  if (config.Tty) args.push('--tty');
  if (config.OpenStdin) args.push('--interactive');
  if (config.Entrypoint) {
    const entrypoint = Array.isArray(config.Entrypoint) ? config.Entrypoint.join(' ') : String(config.Entrypoint);
    args.push(`--entrypoint ${shellQuote(entrypoint)}`);
  }
  const image = String(config.Image || '');
  if (!image) throw new Error('inspect 缺少 image 信息');
  args.push(shellQuote(image));
  for (const command of config.Cmd ?? []) args.push(shellQuote(String(command)));

  const name = shellQuote(containerName);
  const backup = shellQuote(`${containerName}-edgessh-backup`);
  const run = args.join(' ');
  // 先把旧容器改名保留；新容器创建失败时自动恢复旧容器，避免直接 rm 后服务无法回滚。
  return [
    `docker stop ${name} >/dev/null 2>&1 || true`,
    `docker rm -f ${backup} >/dev/null 2>&1 || true`,
    `if docker rename ${name} ${backup}; then`,
    `if ${run}; then docker rm -f ${backup}; else docker rename ${backup} ${name} || true; docker start ${name} >/dev/null 2>&1 || true; exit 1; fi`,
    `else docker rm -f ${name} >/dev/null 2>&1 || true; ${run}; fi`,
  ].join('; ');
}

/**
 * 智能升级策略只做安全、可预测的选择：
 * - Compose 容器默认 compose pull + up -d，绝不因为 RepoDigests 为空或镜像名格式而自动 Git；
 * - 独立容器默认 pull 镜像并按 inspect 参数重建；
 * - Git 源码更新只保留为明确手动选择的模式。
 */
export function detectUpgradeStrategy(inspect: unknown, entry: UpgradeTarget): UpgradeDetection {
  const item = inspectItem(inspect);
  if (!item) return fallbackUpgradeDetection(entry);
  const config = asRecord(item.Config) ?? {};
  const labels = asRecord(config.Labels) ?? {};
  const project = label(labels, 'com.docker.compose.project');
  const service = label(labels, 'com.docker.compose.service');
  const configFiles = label(labels, 'com.docker.compose.project.config_files');
  const configFile = configFiles.split(',')[0]?.trim() ?? '';
  const workingDirLabel = label(labels, 'com.docker.compose.project.working_dir');
  const workingDir = workingDirLabel || dirname(configFile);
  const isCompose = Boolean(project || service || configFile || workingDir);
  const image = String(config.Image || entry.image);
  const composeArgs = `${project ? ` -p ${shellQuote(project)}` : ''}${configFile ? ` -f ${shellQuote(configFile)}` : ''}`;
  const compose = `docker compose${composeArgs}`;
  const prefix = workingDir ? `cd ${shellQuote(workingDir)} && ` : '';
  let recreateCommand: string | null = null;
  try { recreateCommand = buildRecreateCommand(item, entry.name); }
  catch { recreateCommand = null; }

  const common = {
    workingDir, project, configFile, service, image, name: entry.name,
    isCompose, composeArgs, inspectAvailable: true, recreateCommand,
  };

  if (isCompose) {
    return {
      ...common,
      recommendedMode: 'compose_pull',
      recommendedCommand: `${prefix}${compose} pull && ${compose} up -d`,
      badge: 'Docker Compose (镜像更新)',
      hint: '智能模式默认只拉取 Compose 服务镜像并重建，不自动执行 git pull；源码构建项目请手动选择「Git 源码更新」并确认工作目录。',
    };
  }
  return {
    ...common,
    recommendedMode: 'image_pull',
    recommendedCommand: recreateCommand
      ? `docker pull ${shellQuote(image)} && ${recreateCommand}`
      : `docker pull ${shellQuote(image)}`,
    badge: recreateCommand ? '独立容器 (保留配置重建)' : '独立容器 (仅拉取镜像)',
    hint: recreateCommand
      ? '已按 inspect 参数生成重建命令，升级会停止旧容器并创建同配置的新容器；请确认端口、挂载和环境变量后执行。'
      : 'inspect 未包含完整运行参数，智能模式只拉取镜像，不会改变正在运行的容器；请使用「编辑容器」核对参数后重建。',
  };
}

export function fallbackUpgradeDetection(entry: UpgradeTarget): UpgradeDetection {
  return {
    workingDir: '', project: '', configFile: '', service: '',
    image: entry.image, name: entry.name, isCompose: false,
    recommendedMode: 'image_pull',
    recommendedCommand: `docker pull ${shellQuote(entry.image)}`,
    badge: '无法识别容器参数',
    hint: '无法读取 inspect 元数据。本命令只拉取镜像，不会改变正在运行的容器；请重试或使用「编辑容器」核对参数后重建。',
    composeArgs: '', inspectAvailable: false, recreateCommand: null,
  };
}

export function buildUpgradeModeCommand(mode: UpgradeMode, entry: UpgradeTarget, detected: UpgradeDetection): UpgradeModeCommand {
  if (mode === 'auto') {
    return { command: detected.recommendedCommand, hint: detected.hint, badge: detected.badge };
  }
  const compose = `docker compose${detected.composeArgs}`;
  const prefix = detected.workingDir ? `cd ${shellQuote(detected.workingDir)} && ` : '';
  if (mode === 'compose_git') {
    return {
      command: `${prefix}git pull && ${compose} up -d --build`,
      hint: '手动 Git 模式：仅当工作目录确实是 Git 仓库且服务由源码 build 时使用；普通镜像容器请回到智能模式。',
      badge: '手动选择：Git 源码更新',
    };
  }
  if (mode === 'compose_pull') {
    return {
      command: `${prefix}${compose} pull && ${compose} up -d`,
      hint: '将拉取 Compose 服务的最新镜像并按 Compose 配置重启。',
      badge: '手动选择：Compose 镜像更新',
    };
  }
  const imagePull = `docker pull ${shellQuote(detected.image)}`;
  if (detected.isCompose) {
    return {
      command: `${imagePull} && ${prefix}${compose} up -d --force-recreate`,
      hint: '手动单镜像模式：拉取当前镜像后按 Compose 配置强制重建；不会执行 git pull。',
      badge: '手动选择：单镜像更新',
    };
  }
  return {
    command: detected.recreateCommand ? `${imagePull} && ${detected.recreateCommand}` : imagePull,
    hint: detected.recreateCommand
      ? '手动单镜像模式：拉取镜像后按 inspect 参数重建；请确认端口、挂载和环境变量。'
      : 'inspect 未包含完整运行参数，只能拉取镜像；请使用「编辑容器」核对参数后重建。',
    badge: '手动选择：单镜像更新',
  };
}
