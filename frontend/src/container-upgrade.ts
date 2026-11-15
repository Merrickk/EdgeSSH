import type { ContainerEntry } from './container-types';

/** 升级弹窗的三个单选值，也是自动检测会选中的值。 */
export type UpgradeMode = 'compose_git' | 'compose_pull' | 'image_pull';

export interface UpgradeDetection {
  workingDir: string;
  project: string;
  configFile: string;
  service: string;
  image: string;
  name: string;
  isCompose: boolean;
  recommendedMode: UpgradeMode;
  recommendedCommand: string;
  badge: string;
  hint: string;
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
  return item && asRecord(item.Config) ? item : null;
}

function label(labels: Record<string, unknown>, key: string): string {
  const value = labels[key];
  return typeof value === 'string' ? value.trim() : '';
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '';
}

/** 根据 docker inspect 生成尽量保真、且失败时自动回滚的 docker run 命令（供「编辑容器」使用）。 */
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
 * 生成某个升级模式对应的命令。
 * 目录可定位时先 cd 到 Compose 工作目录，其余保持简洁、可手工编辑。
 */
export function buildUpgradeModeCommand(mode: UpgradeMode, entry: UpgradeTarget, detected: UpgradeDetection): UpgradeModeCommand {
  const image = detected.image || entry.image;
  const pull = `docker pull ${shellQuote(image)}`;
  const prefix = detected.workingDir ? `cd ${shellQuote(detected.workingDir)} && ` : '';
  const compose = 'docker compose';
  const single: UpgradeModeCommand = {
    command: `${pull} && docker restart ${shellQuote(entry.name)}`,
    hint: '非 Compose 容器：直接拉取当前镜像并重启容器。命令可编辑，例如换成新镜像标签。',
    badge: '单容器 (镜像更新)',
  };

  if (mode === 'image_pull') return single;
  if (!detected.isCompose) {
    return { ...single, hint: '当前容器未检测到 Compose 标签，已回退为直接拉取镜像。' };
  }
  if (mode === 'compose_pull') {
    return {
      command: `${prefix}${compose} pull && ${compose} up -d`,
      hint: `镜像名 ${image} 含 /，按远程镜像 Compose 项目处理：拉取最新镜像并重建服务。`,
      badge: 'Docker Compose (镜像更新)',
    };
  }
  return {
    command: `${prefix}git pull && ${compose} up -d --build`,
    hint: `镜像名 ${image} 不含 /，按本地构建 Compose 项目处理：拉取源码并重新构建。`,
    badge: 'Docker Compose (Git 源码更新)',
  };
}

function finishDetection(base: UpgradeDetection, entry: UpgradeTarget): UpgradeDetection {
  const result = buildUpgradeModeCommand(base.recommendedMode, entry, base);
  return { ...base, recommendedCommand: result.command, badge: result.badge, hint: result.hint };
}

/**
 * 识别规则：
 * 1. 先看 Docker Compose 标签；不是 Compose 容器 → 直接 pull（单镜像更新）；
 * 2. 是 Compose 容器且镜像名含 `/` → compose pull + up；
 * 3. 是 Compose 容器且镜像名不含 `/` → git pull + up --build。
 *
 * 镜像名以列表显示的 `entry.image` 为准，与用户在界面上看到的名字一致；
 * inspect 仅用于判断是否 Compose、取工作目录和配置文件路径。
 */
export function detectUpgradeStrategy(inspect: unknown, entry: UpgradeTarget): UpgradeDetection {
  const item = inspectItem(inspect);
  if (!item) return fallbackUpgradeDetection(entry);
  const config = asRecord(item.Config)!;
  const labels = asRecord(config.Labels) ?? {};
  const project = label(labels, 'com.docker.compose.project');
  const service = label(labels, 'com.docker.compose.service');
  const configFiles = label(labels, 'com.docker.compose.project.config_files');
  const configFile = configFiles.split(',')[0]?.trim() ?? '';
  const workingDir = label(labels, 'com.docker.compose.project.working_dir') || dirname(configFile);
  const isCompose = Boolean(project || service || configFile || workingDir);
  const image = entry.image || String(config.Image || '');
  const recommendedMode: UpgradeMode = !isCompose
    ? 'image_pull'
    : image.includes('/') ? 'compose_pull' : 'compose_git';
  return finishDetection({
    workingDir, project, configFile, service, image, name: entry.name, isCompose,
    recommendedMode,
    recommendedCommand: '', badge: '', hint: '',
  }, entry);
}

export function fallbackUpgradeDetection(entry: UpgradeTarget): UpgradeDetection {
  const detection = finishDetection({
    workingDir: '', project: '', configFile: '', service: '',
    image: entry.image, name: entry.name, isCompose: false,
    recommendedMode: 'image_pull',
    recommendedCommand: '', badge: '', hint: '',
  }, entry);
  return {
    ...detection,
    hint: '无法读取容器 inspect 元数据，已按非 Compose 容器直接拉取镜像；请确认容器类型后再执行。',
    badge: '无法识别，按单容器处理',
  };
}
