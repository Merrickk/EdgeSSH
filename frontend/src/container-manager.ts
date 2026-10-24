import type {
  ContainerEntry, ContainerSnapshot, ContainerState, ImageEntry,
} from './container-types';

interface LocalizedText { zh: string; en: string }

/** 单个容器与镜像动作的请求类型。 */
export type ContainerAction =
  | 'start' | 'stop' | 'restart' | 'rm' | 'rmi' | 'logs' | 'pause' | 'unpause'
  | 'inspect' | 'pull' | 'prune_images' | 'upgrade';

export interface ContainerManagerElements {
  panel: HTMLElement;
  tableBody: HTMLTableSectionElement;
  status: HTMLElement;
  empty: HTMLElement;
  error: HTMLElement;
  updated: HTMLElement;
  /** 顶部统计：运行中 / 总数 / 镜像数。 */
  runningCount: HTMLElement;
  totalCount: HTMLElement;
  imageCount: HTMLElement;

  // 容器 / 镜像子导航与视图块
  subtabContainers?: HTMLButtonElement;
  subtabImages?: HTMLButtonElement;
  viewContainers?: HTMLElement;
  viewImages?: HTMLElement;

  // 镜像管理界面相关
  imageSummaryTotal?: HTMLElement;
  imageSummarySize?: HTMLElement;
  imageSummaryDangling?: HTMLElement;
  imageBtnPull?: HTMLButtonElement;
  imageBtnPrune?: HTMLButtonElement;
  imageSearchInput?: HTMLInputElement;
  imageTableBody?: HTMLTableSectionElement;
  imageEmpty?: HTMLElement;

  // 容器升级弹窗
  upgradeDialog?: HTMLDialogElement;
  upgradeTitle?: HTMLElement;
  upgradeName?: HTMLElement;
  upgradeImage?: HTMLElement;
  upgradeTypeBadge?: HTMLElement;
  upgradeCommand?: HTMLTextAreaElement;
  upgradeHint?: HTMLElement;
  upgradeAddCron?: HTMLButtonElement;
  upgradeDismiss?: HTMLButtonElement;
  upgradeExec?: HTMLButtonElement;
  upgradeClose?: HTMLButtonElement;

  // 镜像拉取弹窗
  pullDialog?: HTMLDialogElement;
  pullClose?: HTMLButtonElement;
  pullInput?: HTMLInputElement;
  pullDismiss?: HTMLButtonElement;
  pullConfirm?: HTMLButtonElement;

  /** 操作列按钮由事件委托处理，这里只需要容器。 */
  logDialog: HTMLDialogElement;
  logTitle: HTMLElement;
  logPath: HTMLElement;
  logText: HTMLElement;
  logClose: HTMLButtonElement;
  logDismiss: HTMLButtonElement;
  logTailSelect: HTMLSelectElement;
  logRefresh: HTMLButtonElement;
  confirmDialog: HTMLDialogElement;
  confirmTitle: HTMLElement;
  confirmDescription: HTMLElement;
  confirmAccept: HTMLButtonElement;
  confirmReject: HTMLButtonElement;
  toastRegion: HTMLElement;
}

export interface ContainerManagerOptions {
  elements: ContainerManagerElements;
  getLanguage: () => string;
  onError?: (message: string) => void;
  onStatus?: (message: string) => void;
  onToast?: (zh: string, en: string, kind: 'info' | 'error') => void;
  /** 点击容器升级弹窗的「一键添加到计划任务」时触发回调 */
  onAddToCron?: (task: { name: string; command: string; schedule: string }) => void;
}

interface PendingAction {
  requestId: string;
  action: ContainerAction;
  target: string;
}

const MAX_CONTAINERS = 512;
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_DELAYS: readonly number[] = [1000, 2000, 4000];
const MAX_LOG_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 128): string {
  return typeof value === 'string' ? value.replace(/[\0\r\n]/g, ' ').trim().slice(0, max) : '';
}

function optionalText(value: unknown, max = 128): string | null {
  const cleaned = text(value, max);
  return cleaned || null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

/** 校验并归一化一条容器记录；字段缺失时给默认值而不是丢弃整行。 */
export function parseContainerEntry(value: unknown): ContainerEntry | null {
  if (!isRecord(value)) return null;
  const id = text(value.id, 128);
  const name = text(value.name, 256);
  if (!id && !name) return null;
  const rawState = text(value.state, 32).toLowerCase();
  const state: ContainerState = (['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'] as string[])
    .includes(rawState) ? rawState as ContainerState : 'unknown';
  return {
    id,
    name: name || id.slice(0, 12),
    image: text(value.image, 256),
    state,
    status: text(value.status, 256),
    created: text(value.created, 128),
    ports: text(value.ports, 512),
    cpuPercent: optionalText(value.cpuPercent, 32),
    memoryUsage: optionalText(value.memoryUsage, 64),
    memoryPercent: optionalText(value.memoryPercent, 32),
    netIo: optionalText(value.netIo, 64),
    blockIo: optionalText(value.blockIo, 64),
    pids: optionalCount(value.pids),
  };
}

function parseSnapshot(value: unknown): ContainerSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.containers)) return null;
  const containers: ContainerEntry[] = [];
  for (const raw of value.containers) {
    const entry = parseContainerEntry(raw);
    if (entry) containers.push(entry);
    if (containers.length >= MAX_CONTAINERS) break;
  }
  const imageEntries: ImageEntry[] = [];
  if (Array.isArray(value.imageEntries)) {
    for (const raw of value.imageEntries) {
      if (isRecord(raw) && typeof raw.id === 'string') {
        imageEntries.push({
          id: text(raw.id, 128),
          repository: text(raw.repository, 256),
          tag: text(raw.tag, 128),
          size: text(raw.size, 64),
          created: text(raw.created, 128),
        });
      }
    }
  }
  return {
    containers,
    images: optionalCount(value.images),
    imageEntries,
    timestamp: typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) ? value.timestamp : Date.now(),
  };
}

function requiredElement<T extends Element>(root: ParentNode, id: string): T {
  const node = root.querySelector<T>(`#${id}`);
  if (!node) throw new Error(`Missing container manager element #${id}`);
  return node;
}

export function collectContainerManagerElements(root: ParentNode = document): ContainerManagerElements {
  return {
    panel: requiredElement(root, 'container-manager-panel'),
    tableBody: requiredElement(root, 'container-table-body'),
    status: requiredElement(root, 'container-manager-status'),
    empty: requiredElement(root, 'container-manager-empty'),
    error: requiredElement(root, 'container-manager-error'),
    updated: requiredElement(root, 'container-updated'),
    runningCount: requiredElement(root, 'container-running-count'),
    totalCount: requiredElement(root, 'container-total-count'),
    imageCount: requiredElement(root, 'container-image-count'),

    subtabContainers: root.querySelector<HTMLButtonElement>('#container-subtab-containers') ?? undefined,
    subtabImages: root.querySelector<HTMLButtonElement>('#container-subtab-images') ?? undefined,
    viewContainers: root.querySelector<HTMLElement>('#container-view-containers') ?? undefined,
    viewImages: root.querySelector<HTMLElement>('#container-view-images') ?? undefined,

    imageSummaryTotal: root.querySelector<HTMLElement>('#image-summary-total') ?? undefined,
    imageSummarySize: root.querySelector<HTMLElement>('#image-summary-size') ?? undefined,
    imageSummaryDangling: root.querySelector<HTMLElement>('#image-summary-dangling') ?? undefined,
    imageBtnPull: root.querySelector<HTMLButtonElement>('#image-btn-pull') ?? undefined,
    imageBtnPrune: root.querySelector<HTMLButtonElement>('#image-btn-prune') ?? undefined,
    imageSearchInput: root.querySelector<HTMLInputElement>('#image-search-input') ?? undefined,
    imageTableBody: root.querySelector<HTMLTableSectionElement>('#container-image-table-body') ?? undefined,
    imageEmpty: root.querySelector<HTMLElement>('#container-image-empty') ?? undefined,

    upgradeDialog: root.querySelector<HTMLDialogElement>('#container-upgrade-dialog') ?? undefined,
    upgradeTitle: root.querySelector<HTMLElement>('#container-upgrade-title') ?? undefined,
    upgradeName: root.querySelector<HTMLElement>('#container-upgrade-name') ?? undefined,
    upgradeImage: root.querySelector<HTMLElement>('#container-upgrade-image') ?? undefined,
    upgradeTypeBadge: root.querySelector<HTMLElement>('#container-upgrade-type-badge') ?? undefined,
    upgradeCommand: root.querySelector<HTMLTextAreaElement>('#container-upgrade-command') ?? undefined,
    upgradeHint: root.querySelector<HTMLElement>('#container-upgrade-hint') ?? undefined,
    upgradeAddCron: root.querySelector<HTMLButtonElement>('#container-upgrade-add-cron') ?? undefined,
    upgradeDismiss: root.querySelector<HTMLButtonElement>('#container-upgrade-dismiss') ?? undefined,
    upgradeExec: root.querySelector<HTMLButtonElement>('#container-upgrade-exec') ?? undefined,
    upgradeClose: root.querySelector<HTMLButtonElement>('#container-upgrade-close') ?? undefined,

    pullDialog: root.querySelector<HTMLDialogElement>('#container-pull-dialog') ?? undefined,
    pullClose: root.querySelector<HTMLButtonElement>('#container-pull-close') ?? undefined,
    pullInput: root.querySelector<HTMLInputElement>('#container-pull-input') ?? undefined,
    pullDismiss: root.querySelector<HTMLButtonElement>('#container-pull-dismiss') ?? undefined,
    pullConfirm: root.querySelector<HTMLButtonElement>('#container-pull-confirm') ?? undefined,

    logDialog: requiredElement(root, 'container-log-dialog'),
    logTitle: requiredElement(root, 'container-log-title'),
    logPath: requiredElement(root, 'container-log-path'),
    logText: requiredElement(root, 'container-log-text'),
    logClose: requiredElement(root, 'container-log-close'),
    logDismiss: requiredElement(root, 'container-log-dismiss'),
    logTailSelect: requiredElement(root, 'container-log-tail'),
    logRefresh: requiredElement(root, 'container-log-refresh'),
    confirmDialog: requiredElement(root, 'container-confirm-dialog'),
    confirmTitle: requiredElement(root, 'container-confirm-title'),
    confirmDescription: requiredElement(root, 'container-confirm-description'),
    confirmAccept: requiredElement(root, 'container-confirm-accept'),
    confirmReject: requiredElement(root, 'container-confirm-reject'),
    toastRegion: requiredElement(root, 'toast-region'),
  };
}

/**
 * 容器管理器：与进程管理同构，一条常驻 WebSocket 承载快照与动作。
 * 列表渲染用原生 DOM（容器数量通常远小于进程数，无需虚拟化）。
 */
export class ContainerManager {
  private socket: WebSocket | null = null;
  private generation = 0;
  private requestSequence = 0;
  private ready = false;
  private wantConnection = false;
  private url: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private containers: ContainerEntry[] = [];
  private images: ImageEntry[] = [];
  private imageCount: number | null = null;
  private lastTimestamp = 0;
  private activeSubtab: 'containers' | 'images' = 'containers';
  private imageSearch = '';
  private upgradeTarget: ContainerEntry | null = null;
  private detectedUpgrade: {
    workingDir: string;
    image: string;
    name: string;
    isCompose: boolean;
    recommendedMode: string;
    recommendedCommand: string;
  } | null = null;
  private pendingActions = new Map<string, PendingAction>();
  private actionResolvers = new Map<string, (res: { ok: boolean; stdout: string; stderr: string }) => void>();
  private logTarget: string | null = null;
  private logTail = 200;
  private confirmResolve: ((confirmed: boolean) => void) | null = null;
  private readonly bindings = new AbortController();
  private readonly localize: (copy: LocalizedText) => string;

  constructor(private readonly options: ContainerManagerOptions) {
    this.localize = (copy) => options.getLanguage().toLowerCase().startsWith('zh') ? copy.zh : copy.en;
    this.bindControls();
    this.renderDisconnected();
  }

  private get elements(): ContainerManagerElements {
    return this.options.elements;
  }

  attach(url: string): void {
    this.clearReconnectTimer();
    this.reset();
    this.wantConnection = true;
    this.url = url;
    let target: URL;
    try {
      target = new URL(url, window.location.href);
      if (target.protocol === 'http:') target.protocol = 'ws:';
      if (target.protocol === 'https:') target.protocol = 'wss:';
      const expectedProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (target.host !== window.location.host || target.protocol !== expectedProtocol || target.username || target.password) {
        throw new Error('Container WebSocket must use the current origin');
      }
      target.hash = '';
    } catch (error) {
      this.showError(this.localize({ zh: '容器监控地址无效。', en: 'The container-monitor address is invalid.' }));
      throw error;
    }
    const generation = this.generation;
    const socket = new WebSocket(target);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setStatus({ zh: '正在连接容器监控…', en: 'Connecting to the container monitor…' });
    socket.addEventListener('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.reconnectAttempts = 0;
      this.send({ type: 'container_start' });
    });
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      if (typeof event.data !== 'string') return;
      this.handleMessage(event.data, generation);
    });
    socket.addEventListener('error', () => {
      if (this.isCurrent(socket, generation)) {
        this.showError(this.localize({ zh: '容器监控连接失败。', en: 'The container-monitor connection failed.' }));
      }
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.ready = false;
      if (event.code !== 1000 && event.code !== 1005 && this.wantConnection) this.scheduleReconnect();
      else this.renderDisconnected(true);
    });
  }

  reset(): void {
    this.wantConnection = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.pendingActions.clear();
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'container_stop' })); } catch { /* unusable */ }
      }
      if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Container client reset');
    }
    this.renderDisconnected();
  }

  destroy(): void {
    this.reset();
    this.bindings.abort();
  }

  setLanguage(): void {
    this.renderEntries();
    this.renderImages();
    this.renderCounters();
  }

  private bindControls(): void {
    const signal = this.bindings.signal;
    this.elements.tableBody.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-container-action]')
        : null;
      if (!button || button.disabled) return;
      const id = button.dataset.containerId ?? '';
      const action = button.dataset.containerAction as ContainerAction | undefined;
      if (!id || !action) return;
      event.stopPropagation();
      if (action === 'upgrade') {
        const entry = this.containers.find((c) => c.id === id);
        if (entry) void this.openUpgradeModal(entry);
        return;
      }
      void this.performAction(action, id);
    }, { signal });

    // 子 Tab：容器 vs 镜像
    this.elements.subtabContainers?.addEventListener('click', () => this.switchSubtab('containers'), { signal });
    this.elements.subtabImages?.addEventListener('click', () => this.switchSubtab('images'), { signal });

    // 镜像操作与搜索
    this.elements.imageBtnPull?.addEventListener('click', () => this.openPullModal(), { signal });
    this.elements.imageBtnPrune?.addEventListener('click', () => void this.pruneImages(), { signal });
    this.elements.imageSearchInput?.addEventListener('input', () => {
      this.imageSearch = this.elements.imageSearchInput?.value.trim().toLowerCase() ?? '';
      this.renderImages();
    }, { signal });

    this.elements.imageTableBody?.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-image-action]')
        : null;
      if (!button || button.disabled) return;
      const id = button.dataset.imageId ?? '';
      const action = button.dataset.imageAction as ContainerAction | undefined;
      if (!id || !action) return;
      event.stopPropagation();
      void this.performAction(action, id);
    }, { signal });

    // 拉取镜像弹窗
    this.elements.pullClose?.addEventListener('click', () => this.elements.pullDialog?.close(), { signal });
    this.elements.pullDismiss?.addEventListener('click', () => this.elements.pullDialog?.close(), { signal });
    this.elements.pullConfirm?.addEventListener('click', () => void this.handlePullConfirm(), { signal });

    // 升级弹窗
    this.elements.upgradeClose?.addEventListener('click', () => this.elements.upgradeDialog?.close(), { signal });
    this.elements.upgradeDismiss?.addEventListener('click', () => this.elements.upgradeDialog?.close(), { signal });
    this.elements.upgradeExec?.addEventListener('click', () => void this.handleUpgradeExec(), { signal });
    this.elements.upgradeAddCron?.addEventListener('click', () => this.handleUpgradeAddToCron(), { signal });

    // 升级模式单选切换
    this.elements.upgradeDialog?.querySelectorAll<HTMLInputElement>('input[name="containerUpgradeMode"]').forEach((radio) => {
      radio.addEventListener('change', () => this.updateUpgradeCommandFromMode(radio.value), { signal });
    });

    this.elements.logClose?.addEventListener('click', () => this.closeLog(), { signal });
    this.elements.logDismiss?.addEventListener('click', () => this.closeLog(), { signal });
    this.elements.logRefresh?.addEventListener('click', () => {
      if (this.logTarget) void this.performAction('logs', this.logTarget);
    }, { signal });
    this.elements.logTailSelect?.addEventListener('change', () => {
      this.logTail = Number(this.elements.logTailSelect.value) || 200;
      if (this.logTarget) void this.performAction('logs', this.logTarget);
    }, { signal });
    this.elements.logDialog?.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.closeLog();
    }, { signal });
    this.elements.confirmReject?.addEventListener('click', () => this.resolveConfirm(false), { signal });
    this.elements.confirmAccept?.addEventListener('click', () => this.resolveConfirm(true), { signal });
  }

  private switchSubtab(tab: 'containers' | 'images'): void {
    this.activeSubtab = tab;
    const isCont = tab === 'containers';
    this.elements.subtabContainers?.classList.toggle('is-active', isCont);
    this.elements.subtabContainers?.setAttribute('aria-selected', String(isCont));
    this.elements.subtabImages?.classList.toggle('is-active', !isCont);
    this.elements.subtabImages?.setAttribute('aria-selected', String(!isCont));
    if (this.elements.viewContainers) this.elements.viewContainers.hidden = !isCont;
    if (this.elements.viewImages) this.elements.viewImages.hidden = isCont;
    if (!isCont) this.renderImages();
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setStatus(copy: LocalizedText): void {
    this.options.onStatus?.(this.localize(copy));
    const status = this.elements.status;
    status.dataset.i18nZh = copy.zh;
    status.dataset.i18nEn = copy.en;
    status.textContent = this.localize(copy);
  }

  private showError(message: string): void {
    this.elements.error.textContent = message;
    this.elements.error.hidden = false;
    this.elements.empty.hidden = true;
    this.options.onError?.(message);
  }

  private handleMessage(serialized: string, generation: number): void {
    if (generation !== this.generation) return;
    let message: unknown;
    try { message = JSON.parse(serialized); } catch { return; }
    if (!isRecord(message)) return;
    const type = text(message.type, 64);
    if (type === 'pong') return;
    if (type === 'container_ready') {
      this.ready = true;
      this.setStatus({ zh: '正在读取容器列表…', en: 'Loading the container list…' });
      return;
    }
    if (type === 'container_snapshot') {
      const snapshot = parseSnapshot(message);
      if (!snapshot) return;
      this.containers = snapshot.containers;
      this.images = snapshot.imageEntries;
      this.imageCount = snapshot.images;
      this.lastTimestamp = snapshot.timestamp;
      this.ready = true;
      this.renderEntries();
      this.renderImages();
      this.renderCounters();
      this.elements.error.hidden = true;
      const running = snapshot.containers.filter((entry) => entry.state === 'running').length;
      this.setStatus({
        zh: `${running} 个运行中 · 共 ${snapshot.containers.length} 个容器 · ${this.images.length} 个镜像`,
        en: `${running} running · ${snapshot.containers.length} container${snapshot.containers.length === 1 ? '' : 's'} · ${this.images.length} images`,
      });
      return;
    }
    if (type === 'container_action_stream') {
      const data = typeof message.data === 'string' ? message.data : '';
      if (data && this.elements.logText) {
        this.elements.logText.textContent += data;
        const body = this.elements.logText.closest('.container-log-body') as HTMLElement | null;
        if (body) body.scrollTop = body.scrollHeight;
      }
      return;
    }
    if (type === 'container_action_result') {
      this.handleActionResult(message);
      return;
    }
    if (type === 'container_error') {
      const code = text(message.code, 64);
      const message_ = text(message.message, 512) || this.localize({ zh: '容器监控出错。', en: 'The container monitor reported an error.' });
      // 缺 docker 是一次性提示，清空列表并引导安装，不要每 5 秒重复报错。
      if (code === 'docker_missing') {
        this.containers = [];
        this.imageCount = null;
        this.renderEntries();
        this.renderCounters();
        this.elements.error.textContent = this.localize({
          zh: '该主机未安装 Docker 或当前用户无权限执行 docker 命令。',
          en: 'Docker is not installed on this host, or the user cannot run docker.',
        });
        this.elements.error.hidden = false;
        this.setStatus({ zh: 'Docker 不可用', en: 'Docker unavailable' });
        return;
      }
      this.showError(message_);
      return;
    }
    if (type === 'container_stopped') {
      this.ready = false;
      this.renderDisconnected(true);
    }
  }

  private handleActionResult(message: Record<string, unknown>): void {
    const requestId = text(message.requestId, 64);
    const pending = this.pendingActions.get(requestId);
    if (!pending) return;
    this.pendingActions.delete(requestId);
    const ok = message.ok === true;
    const stdout = typeof message.stdout === 'string' ? message.stdout : '';
    const stderr = typeof message.stderr === 'string' ? message.stderr : '';

    const resolver = this.actionResolvers.get(requestId);
    if (resolver) {
      this.actionResolvers.delete(requestId);
      resolver({ ok, stdout, stderr });
    }

    if (pending.action === 'logs' || pending.action === 'upgrade' || pending.action === 'pull') {
      // 日志、升级、拉取等把输出渲染到日志对话框。
      if (this.logTarget === pending.target || pending.action === 'upgrade' || pending.action === 'pull') {
        const title = pending.action === 'upgrade' ? '容器升级输出' : pending.target;
        this.elements.logTitle.textContent = title;
        const currentText = this.elements.logText.textContent || '';
        const exitStatus = typeof message.exitStatus === 'number' ? message.exitStatus : (ok ? 0 : 1);
        const statusSummary = `\n────────────────────────────────────────\n[${ok ? '✓ 执行完成 (Success)' : '✗ 执行失败 (Failed: exitStatus=' + exitStatus + ')'}]\n`;
        const contentToAdd = ok ? (stdout || '(无更多输出)') : `${stdout}\n${stderr}`.trim();
        if (currentText && (currentText.includes(stdout) && stdout.length > 20)) {
          this.elements.logText.textContent = `${currentText}${statusSummary}`;
        } else {
          this.elements.logText.textContent = `${currentText}\n${contentToAdd}${statusSummary}`;
        }
        const body = this.elements.logText.closest('.container-log-body') as HTMLElement | null;
        if (body) body.scrollTop = body.scrollHeight;
      }
      const label = pending.action === 'upgrade' ? '容器升级' : (pending.action === 'pull' ? '镜像拉取' : '日志');
      this.options.onToast?.(
        ok ? `${label}完成` : `${label}失败：${stderr || stdout || '命令执行返回错误'}`,
        ok ? `${label} finished` : `${label} failed: ${stderr || stdout || 'error'}`,
        ok ? 'info' : 'error',
      );
      return;
    }
    const label = containerActionLabel(pending.action, this.localize);
    this.options.onToast?.(
      ok ? `${label}：${pending.target}` : `${label}失败：${stderr || stdout || pending.target}`,
      ok ? `${label}: ${pending.target}` : `${label} failed: ${stderr || stdout || pending.target}`,
      ok ? 'info' : 'error',
    );
  }

  private renderDisconnected(channelLost = false): void {
    this.containers = [];
    this.images = [];
    this.imageCount = null;
    this.renderEntries();
    this.renderImages();
    this.renderCounters();
    this.elements.error.hidden = true;
    this.elements.empty.hidden = true;
    this.setStatus(channelLost
      ? { zh: '容器监控连接已断开', en: 'Container monitor disconnected' }
      : { zh: '连接 SSH 后即可管理容器', en: 'Connect to SSH to manage containers' });
  }

  private renderCounters(): void {
    const running = this.containers.filter((entry) => entry.state === 'running').length;
    this.elements.runningCount.textContent = String(running);
    this.elements.totalCount.textContent = String(this.containers.length);
    this.elements.imageCount.textContent = this.imageCount === null ? '—' : String(this.imageCount);
    this.elements.updated.textContent = this.lastTimestamp
      ? new Intl.DateTimeFormat(this.options.getLanguage().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date(this.lastTimestamp))
      : '--';
  }

  private renderEntries(): void {
    const body = this.elements.tableBody;
    body.replaceChildren();
    const connected = this.ready || this.containers.length > 0;
    this.elements.empty.hidden = !connected || this.containers.length > 0;
    for (const entry of this.containers) {
      const row = document.createElement('tr');
      row.dataset.containerId = entry.id;
      const nameCell = document.createElement('td');
      const nameWrap = document.createElement('span');
      nameWrap.className = 'container-name-cell';
      const dot = document.createElement('i');
      dot.className = `container-dot is-${entry.state}`;
      dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.textContent = entry.name;
      name.title = `${entry.name} · ${entry.id.slice(0, 12)}`;
      nameWrap.append(dot, name);
      nameCell.append(nameWrap);
      const image = document.createElement('td');
      image.textContent = entry.image;
      image.title = entry.image;
      const state = document.createElement('td');
      state.className = 'container-state-cell';
      state.dataset.state = entry.state;
      state.textContent = containerStateLabel(entry.state, this.localize);
      state.title = entry.status;
      const status = document.createElement('td');
      status.textContent = entry.status;
      status.title = entry.status;
      const ports = document.createElement('td');
      ports.textContent = entry.ports || '—';
      ports.title = entry.ports;
      const cpu = document.createElement('td');
      cpu.textContent = entry.cpuPercent ?? '—';
      const memory = document.createElement('td');
      memory.textContent = entry.memoryPercent ? `${entry.memoryPercent} · ${entry.memoryUsage ?? ''}`.trim() : '—';
      memory.title = entry.memoryUsage ?? '';
      const actions = document.createElement('td');
      actions.className = 'container-actions-cell';
      const running = entry.state === 'running';
      const buttons: Array<[ContainerAction, string]> = running
        ? [['stop', '停止'], ['restart', '重启'], ['pause', '暂停']]
        : [['start', '启动'], ['restart', '重启']];
      buttons.push(['upgrade', '升级'], ['logs', '日志'], ['rm', '删除']);
      for (const [action, label] of buttons) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `container-action${action === 'rm' ? ' danger' : ''}`;
        button.dataset.containerAction = action;
        button.dataset.containerId = entry.id;
        button.textContent = label;
        button.setAttribute('aria-label', `${label} ${entry.name}`);
        actions.append(button);
      }
      row.append(nameCell, image, state, status, ports, cpu, memory, actions);
      body.append(row);
    }
  }

  /** 渲染镜像表格与概览统计（参考 1Panel） */
  private renderImages(): void {
    const body = this.elements.imageTableBody;
    if (!body) return;
    body.replaceChildren();

    const filtered = this.imageSearch
      ? this.images.filter((img) => `${img.repository}:${img.tag} ${img.id}`.toLowerCase().includes(this.imageSearch))
      : this.images;

    if (this.elements.imageEmpty) {
      this.elements.imageEmpty.hidden = filtered.length > 0 || !this.ready;
    }

    // 统计：总大小和悬虚镜像
    let danglingCount = 0;
    for (const img of this.images) {
      if (img.repository === '<none>' || img.tag === '<none>') danglingCount++;
    }
    if (this.elements.imageSummaryTotal) {
      this.elements.imageSummaryTotal.textContent = String(this.images.length);
    }
    if (this.elements.imageSummaryDangling) {
      this.elements.imageSummaryDangling.textContent = String(danglingCount);
    }

    for (const img of filtered) {
      const row = document.createElement('tr');
      row.dataset.imageId = img.id;

      const repoTd = document.createElement('td');
      repoTd.textContent = img.repository;
      repoTd.title = img.repository;

      const tagTd = document.createElement('td');
      const tagBadge = document.createElement('span');
      tagBadge.className = 'container-type-badge';
      tagBadge.textContent = img.tag;
      tagTd.append(tagBadge);

      const idTd = document.createElement('td');
      const idCode = document.createElement('code');
      idCode.textContent = img.id.replace('sha256:', '').slice(0, 12);
      idCode.title = img.id;
      idTd.append(idCode);

      const sizeTd = document.createElement('td');
      sizeTd.textContent = img.size;

      const createdTd = document.createElement('td');
      createdTd.textContent = img.created;

      const actionTd = document.createElement('td');
      actionTd.className = 'container-actions-cell';
      const rmiBtn = document.createElement('button');
      rmiBtn.type = 'button';
      rmiBtn.className = 'container-action danger';
      rmiBtn.dataset.imageAction = 'rmi';
      const targetName = img.repository !== '<none>' && img.tag !== '<none>' ? `${img.repository}:${img.tag}` : img.id.slice(0, 12);
      rmiBtn.dataset.imageId = targetName;
      rmiBtn.textContent = '删除';
      rmiBtn.setAttribute('aria-label', `删除镜像 ${targetName}`);
      actionTd.append(rmiBtn);

      row.append(repoTd, tagTd, idTd, sizeTd, createdTd, actionTd);
      body.append(row);
    }
  }

  private openPullModal(): void {
    if (!this.elements.pullDialog) return;
    if (this.elements.pullInput) this.elements.pullInput.value = '';
    if (!this.elements.pullDialog.open) this.elements.pullDialog.showModal();
    this.elements.pullInput?.focus();
  }

  private async handlePullConfirm(): Promise<void> {
    const image = this.elements.pullInput?.value.trim() ?? '';
    if (!image) {
      alert('请输入要拉取的镜像名称。');
      return;
    }
    this.elements.pullDialog?.close();
    this.logTarget = image;
    if (this.elements.logDialog && !this.elements.logDialog.open) this.elements.logDialog.showModal();
    this.elements.logTitle.textContent = `拉取镜像: ${image}`;
    this.elements.logPath.textContent = image;
    this.elements.logText.textContent = `[正在拉取镜像: docker pull ${image}...]\n`;
    await this.performAction('pull', image);
  }

  private async pruneImages(): Promise<void> {
    const confirmed = await this.confirm({
      title: { zh: '清理未使用的镜像', en: 'Prune unused images' },
      description: {
        zh: '将执行 docker image prune -f，删除所有未被容器使用的悬虚镜像。此操作不可撤销。',
        en: 'Runs docker image prune -f to remove all dangling images. This cannot be undone.',
      },
    });
    if (!confirmed) return;
    this.setStatus({ zh: '正在清理镜像…', en: 'Pruning images…' });
    await this.performAction('prune_images', 'all');
  }

  /**
   * 打开容器升级弹窗：
   * 自动调用 inspect 获取容器元数据，智能推测容器升级命令（Compose Git、Compose Pull、单镜像更新）。
   */
  private async openUpgradeModal(entry: ContainerEntry): Promise<void> {
    this.upgradeTarget = entry;
    const dialog = this.elements.upgradeDialog;
    if (!dialog) return;

    if (this.elements.upgradeName) this.elements.upgradeName.textContent = entry.name;
    if (this.elements.upgradeImage) this.elements.upgradeImage.textContent = entry.image;
    if (this.elements.upgradeTypeBadge) this.elements.upgradeTypeBadge.textContent = '分析中…';
    if (this.elements.upgradeHint) this.elements.upgradeHint.textContent = '正在获取容器详细信息…';
    const defaultCmd = `docker pull ${entry.image} && docker restart ${entry.name}`;
    if (this.elements.upgradeCommand) {
      this.elements.upgradeCommand.value = defaultCmd;
    }
    this.detectedUpgrade = {
      workingDir: '',
      image: entry.image,
      name: entry.name,
      isCompose: false,
      recommendedMode: 'image_pull',
      recommendedCommand: defaultCmd,
    };

    if (!dialog.open) dialog.showModal();

    // 尝试 inspect 容器
    try {
      const res = await this.executeAction('inspect', entry.id);
      if (res.ok && res.stdout) {
        let inspectData: any;
        try { inspectData = JSON.parse(res.stdout); } catch { /* ignore */ }
        const item = Array.isArray(inspectData) ? inspectData[0] : inspectData;
        const labels: Record<string, string> = item?.Config?.Labels ?? {};
        
        let workingDir = labels['com.docker.compose.project.working_dir'] || '';
        if (!workingDir && labels['com.docker.compose.project.config_files']) {
          const cfg = labels['com.docker.compose.project.config_files'].split(',')[0].trim();
          const lastSlash = cfg.lastIndexOf('/');
          if (lastSlash > 0) workingDir = cfg.slice(0, lastSlash);
        }

        const isCompose = Boolean(workingDir || labels['com.docker.compose.project'] || labels['com.docker.compose.service']);

        if (isCompose && workingDir) {
          const cmd = `cd "${workingDir}" && docker compose pull && docker compose up -d`;
          this.detectedUpgrade = {
            workingDir,
            image: entry.image,
            name: entry.name,
            isCompose: true,
            recommendedMode: 'compose_pull',
            recommendedCommand: cmd,
          };
          this.setUpgradeModeDisplay('compose_pull', cmd, 'Docker Compose (镜像更新)');
        } else if (isCompose) {
          const cmd = `docker compose pull && docker compose up -d`;
          this.detectedUpgrade = {
            workingDir: '',
            image: entry.image,
            name: entry.name,
            isCompose: true,
            recommendedMode: 'compose_pull',
            recommendedCommand: cmd,
          };
          this.setUpgradeModeDisplay('compose_pull', cmd, 'Docker Compose (项目更新)');
        } else {
          this.detectedUpgrade = {
            workingDir: '',
            image: entry.image,
            name: entry.name,
            isCompose: false,
            recommendedMode: 'image_pull',
            recommendedCommand: defaultCmd,
          };
          this.setUpgradeModeDisplay('image_pull', defaultCmd, '单容器 (镜像更新)');
        }
      }
    } catch {
      this.setUpgradeModeDisplay('image_pull', defaultCmd, '单容器 (镜像更新)');
    }
  }

  private setUpgradeModeDisplay(mode: string, command: string, badgeText: string): void {
    if (this.elements.upgradeTypeBadge) this.elements.upgradeTypeBadge.textContent = badgeText;
    if (this.elements.upgradeCommand) this.elements.upgradeCommand.value = command;
    if (this.elements.upgradeHint) this.elements.upgradeHint.textContent = `已自动匹配升级策略：${badgeText}`;
    const radio = this.elements.upgradeDialog?.querySelector<HTMLInputElement>(`input[name="containerUpgradeMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
  }

  private updateUpgradeCommandFromMode(mode: string): void {
    const entry = this.upgradeTarget;
    if (!entry) return;
    const detected = this.detectedUpgrade;
    const dir = detected?.workingDir ? `cd "${detected.workingDir}" && ` : '';

    if (mode === 'auto') {
      if (detected) {
        this.elements.upgradeCommand!.value = detected.recommendedCommand;
        if (this.elements.upgradeHint) {
          this.elements.upgradeHint.textContent = `已恢复推荐升级命令：${detected.recommendedMode === 'compose_pull' ? 'Docker Compose' : '单容器'}`;
        }
      }
    } else if (mode === 'compose_git') {
      this.elements.upgradeCommand!.value = `${dir}git pull && docker compose up -d --build`;
      if (this.elements.upgradeHint) this.elements.upgradeHint.textContent = '将拉取 Git 仓库最新代码并重新构建镜像启动';
    } else if (mode === 'compose_pull') {
      this.elements.upgradeCommand!.value = `${dir}docker compose pull && docker compose up -d`;
      if (this.elements.upgradeHint) this.elements.upgradeHint.textContent = '将拉取 Compose 服务的最新镜像并重启';
    } else if (mode === 'image_pull') {
      this.elements.upgradeCommand!.value = `docker pull ${entry.image} && docker restart ${entry.name}`;
      if (this.elements.upgradeHint) this.elements.upgradeHint.textContent = '拉取最新镜像并重启容器';
    }
  }

  private async handleUpgradeExec(): Promise<void> {
    const cmd = this.elements.upgradeCommand?.value.trim();
    if (!cmd) {
      alert('升级命令不能为空。');
      return;
    }
    this.elements.upgradeDialog?.close();
    this.logTarget = 'upgrade';
    if (this.elements.logDialog && !this.elements.logDialog.open) this.elements.logDialog.showModal();
    this.elements.logTitle.textContent = `正在执行容器升级: ${this.upgradeTarget?.name ?? ''}`;
    this.elements.logPath.textContent = cmd;
    this.elements.logText.textContent = `[开始执行升级命令: ${cmd}]\n正在执行中…\n`;
    await this.performAction('upgrade', cmd);
  }

  private handleUpgradeAddToCron(): void {
    const entry = this.upgradeTarget;
    const cmd = this.elements.upgradeCommand?.value.trim();
    if (!cmd) return;
    this.elements.upgradeDialog?.close();
    this.options.onAddToCron?.({
      name: `定时升级: ${entry?.name || '容器'}`,
      command: cmd,
      schedule: '0 3 * * 0', // 默认每周日凌晨 3 点
    });
  }

  private executeAction(action: ContainerAction, target: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('容器服务未就绪。'));
    }
    const requestId = `${this.generation}-${++this.requestSequence}`;
    return new Promise((resolve) => {
      this.actionResolvers.set(requestId, resolve);
      this.pendingActions.set(requestId, { requestId, action, target });
      this.send({ type: 'container_action', requestId, action, target });
    });
  }

  /** 危险动作（删除）先确认；其余直接执行。 */
  private async performAction(action: ContainerAction, target: string): Promise<void> {
    if (action === 'upgrade') {
      this.dispatch(action, target);
      return;
    }
    if (action === 'pull') {
      this.dispatch(action, target);
      return;
    }
    if (action === 'prune_images') {
      this.dispatch(action, 'all');
      return;
    }
    if (action === 'rmi') {
      const confirmed = await this.confirm({
        title: { zh: '删除镜像', en: 'Remove image' },
        description: {
          zh: `确定要执行 docker rmi ${target} 吗？如果镜像正被容器占用可能会报错。`,
          en: `Runs docker rmi ${target}. This cannot be undone.`,
        },
      });
      if (!confirmed) return;
      this.dispatch(action, target);
      return;
    }
    if (action === 'logs') {
      this.logTarget = target;
      if (this.elements.logDialog && !this.elements.logDialog.open) this.elements.logDialog.showModal();
      this.elements.logTitle.textContent = target;
      this.elements.logPath.textContent = target;
      this.elements.logText.textContent = this.localize({ zh: '正在读取日志…', en: 'Loading logs…' });
      this.elements.logTailSelect.value = String(this.logTail);
      this.dispatch(action, target);
      return;
    }
    if (action === 'rm') {
      const confirmed = await this.confirm({
        title: { zh: '删除容器', en: 'Remove container' },
        description: {
          zh: `将执行 docker rm ${target}。容器必须已停止，运行中的容器不会被删除。此操作无法撤销。`,
          en: `Runs docker rm ${target}. The container must be stopped; running containers are kept. This cannot be undone.`,
        },
      });
      if (!confirmed) return;
    }
    this.dispatch(action, target);
  }

  private dispatch(action: ContainerAction, target: string): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.showError(this.localize({ zh: '容器监控未就绪。', en: 'The container monitor is not ready.' }));
      return;
    }
    const requestId = `${this.generation}-${++this.requestSequence}`;
    this.pendingActions.set(requestId, { requestId, action, target });
    this.send({
      type: 'container_action', requestId, action, target,
      ...(action === 'logs' ? { tail: this.logTail } : {}),
    });
  }

  private showLog(target: string, content: string): void {
    const truncated = content.length > MAX_LOG_BYTES;
    this.elements.logText.textContent = truncated ? `${content.slice(-MAX_LOG_BYTES)}\n…` : content;
    this.elements.logTitle.textContent = target;
  }

  private closeLog(): void {
    this.logTarget = null;
    this.elements.logDialog?.close();
  }

  private confirm(copy: { title: LocalizedText; description: LocalizedText }): Promise<boolean> {
    const dialog = this.elements.confirmDialog;
    if (!dialog) return Promise.resolve(window.confirm(this.localize(copy.description)));
    this.elements.confirmTitle.textContent = this.localize(copy.title);
    this.elements.confirmDescription.textContent = this.localize(copy.description);
    if (!dialog.open) dialog.showModal();
    return new Promise((resolve) => {
      this.confirmResolve = resolve;
      requestAnimationFrame(() => this.elements.confirmReject?.focus());
    });
  }

  private resolveConfirm(confirmed: boolean): void {
    const resolve = this.confirmResolve;
    this.confirmResolve = null;
    this.elements.confirmDialog?.close();
    resolve?.(confirmed);
  }

  private scheduleReconnect(): void {
    if (!this.wantConnection || !this.url || this.reconnectTimer !== null) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      this.reconnectAttempts = 0;
      this.renderDisconnected(true);
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempts - 1, RECONNECT_DELAYS.length - 1)] ?? 4000;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantConnection || !this.url) return;
      try { this.attach(this.url); } catch { this.scheduleReconnect(); }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

function containerActionLabel(action: ContainerAction, localize: (copy: LocalizedText) => string): string {
  const labels: Record<ContainerAction, LocalizedText> = {
    start: { zh: '启动', en: 'Start' },
    stop: { zh: '停止', en: 'Stop' },
    restart: { zh: '重启', en: 'Restart' },
    pause: { zh: '暂停', en: 'Pause' },
    unpause: { zh: '恢复', en: 'Unpause' },
    rm: { zh: '删除', en: 'Remove' },
    rmi: { zh: '删除镜像', en: 'Remove image' },
    logs: { zh: '日志', en: 'Logs' },
    inspect: { zh: '查看详情', en: 'Inspect' },
    pull: { zh: '拉取镜像', en: 'Pull image' },
    prune_images: { zh: '清理未用镜像', en: 'Prune images' },
    upgrade: { zh: '升级容器', en: 'Upgrade' },
  };
  return localize(labels[action] ?? { zh: action, en: action });
}

export function containerStateLabel(state: ContainerState, localize: (copy: LocalizedText) => string): string {
  const labels: Record<ContainerState, LocalizedText> = {
    created: { zh: '已创建', en: 'Created' },
    running: { zh: '运行中', en: 'Running' },
    paused: { zh: '已暂停', en: 'Paused' },
    restarting: { zh: '重启中', en: 'Restarting' },
    removing: { zh: '删除中', en: 'Removing' },
    exited: { zh: '已退出', en: 'Exited' },
    dead: { zh: '已僵死', en: 'Dead' },
    unknown: { zh: '未知', en: 'Unknown' },
  };
  return localize(labels[state] ?? labels.unknown);
}
