import type {
  ContainerEntry, ContainerSnapshot, ContainerState,
} from './container-types';

interface LocalizedText { zh: string; en: string }

/** 单个容器动作的请求类型。 */
export type ContainerAction = 'start' | 'stop' | 'restart' | 'rm' | 'rmi' | 'logs' | 'pause' | 'unpause';

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
  return {
    containers,
    images: optionalCount(value.images),
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
  private imageCount: number | null = null;
  private lastTimestamp = 0;
  private pendingActions = new Map<string, PendingAction>();
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
      void this.performAction(action, id);
    }, { signal });
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
      this.imageCount = snapshot.images;
      this.lastTimestamp = snapshot.timestamp;
      this.ready = true;
      this.renderEntries();
      this.renderCounters();
      this.elements.error.hidden = true;
      const running = snapshot.containers.filter((entry) => entry.state === 'running').length;
      this.setStatus({
        zh: `${running} 个运行中 · 共 ${snapshot.containers.length} 个容器`,
        en: `${running} running · ${snapshot.containers.length} container${snapshot.containers.length === 1 ? '' : 's'}`,
      });
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
    if (pending.action === 'logs') {
      // 日志是唯一把输出渲染到对话框的动作。
      if (this.logTarget === pending.target) this.showLog(pending.target, ok ? stdout : `${stdout}${stderr}`);
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
    this.imageCount = null;
    this.renderEntries();
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
      buttons.push(['logs', '日志'], ['rm', '删除']);
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

  /** 危险动作（删除）先确认；其余直接执行。 */
  private async performAction(action: ContainerAction, target: string): Promise<void> {
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
  };
  return localize(labels[action]);
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
