import {
  parseCrontab, formatCrontab, toBase64, fromBase64,
  type CronTask, type CronTaskType,
} from '../../src/backend/cron-command';
import { explainCron, CRON_PRESETS } from './cron-types';

export interface CronManagerElements {
  panel: HTMLElement;
  tableBody: HTMLTableSectionElement;
  status: HTMLElement;
  empty: HTMLElement;
  error: HTMLElement;
  totalCount: HTMLElement;
  enabledCount: HTMLElement;
  disabledCount: HTMLElement;
  newButton: HTMLButtonElement;
  refreshButton: HTMLButtonElement;
  // 任务编辑/新建弹窗
  dialog: HTMLDialogElement;
  dialogTitle: HTMLElement;
  nameInput: HTMLInputElement;
  presetSelect: HTMLSelectElement;
  scheduleInput: HTMLInputElement;
  scheduleHint: HTMLElement;
  typeCommandRadio: HTMLInputElement;
  typeScriptRadio: HTMLInputElement;
  commandGroup: HTMLElement;
  commandInput: HTMLTextAreaElement;
  scriptGroup: HTMLElement;
  scriptPathInput: HTMLInputElement;
  scriptArea: HTMLTextAreaElement;
  dialogSave: HTMLButtonElement;
  dialogCancel: HTMLButtonElement;
  dialogClose: HTMLButtonElement;
  // 执行结果弹窗
  runDialog: HTMLDialogElement;
  runTitle: HTMLElement;
  runText: HTMLElement;
  runClose: HTMLButtonElement;
  runDismiss: HTMLButtonElement;
  // 确认弹窗
  confirmDialog: HTMLDialogElement;
  confirmTitle: HTMLElement;
  confirmDescription: HTMLElement;
  confirmAccept: HTMLButtonElement;
  confirmReject: HTMLButtonElement;
}

export interface CronManagerOptions {
  elements: CronManagerElements;
  getLanguage: () => string;
  onError?: (message: string) => void;
  onStatus?: (message: string) => void;
  onToast?: (zh: string, en: string, kind: 'info' | 'error') => void;
}

interface PendingAction {
  requestId: string;
  action: string;
  resolve: (res: { ok: boolean; stdout: string; stderr: string; exitStatus?: number | null }) => void;
  reject: (err: Error) => void;
}

export class CronManager {
  private socket: WebSocket | null = null;
  private generation = 0;
  private requestSequence = 0;
  private ready = false;
  private wantConnection = false;
  private url: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private tasks: CronTask[] = [];
  private pendingActions = new Map<string, PendingAction>();
  private editingTaskId: string | null = null;
  private confirmResolve: ((confirmed: boolean) => void) | null = null;
  private readonly bindings = new AbortController();

  constructor(private readonly options: CronManagerOptions) {
    this.bindControls();
    this.renderDisconnected();
  }

  private get elements(): CronManagerElements {
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
      target.hash = '';
    } catch (error) {
      this.showError('计划任务连接地址无效。');
      throw error;
    }
    const generation = this.generation;
    const socket = new WebSocket(target);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setStatus('正在连接计划任务服务…');

    socket.addEventListener('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.reconnectAttempts = 0;
      this.ready = true;
      void this.refresh();
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      if (typeof event.data !== 'string') return;
      this.handleMessage(event.data, generation);
    });

    socket.addEventListener('error', () => {
      if (this.isCurrent(socket, generation)) {
        this.showError('计划任务服务连接失败。');
      }
    });

    socket.addEventListener('close', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.ready = false;
      this.renderDisconnected(true);
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
      if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Cron client reset');
    }
    this.renderDisconnected();
  }

  destroy(): void {
    this.reset();
    this.bindings.abort();
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setStatus(text: string): void {
    this.elements.status.textContent = text;
    this.options.onStatus?.(text);
  }

  private showError(text: string): void {
    this.elements.error.textContent = text;
    this.elements.error.hidden = false;
    this.elements.empty.hidden = true;
    this.options.onError?.(text);
  }

  private renderDisconnected(lost = false): void {
    this.tasks = [];
    this.renderEntries();
    this.renderCounters();
    this.elements.error.hidden = true;
    this.elements.empty.hidden = true;
    this.setStatus(lost ? '计划任务服务已断开' : '连接 SSH 后即可管理计划任务');
  }

  private bindControls(): void {
    const signal = this.bindings.signal;
    this.elements.newButton?.addEventListener('click', () => this.openCreateModal(), { signal });
    this.elements.refreshButton?.addEventListener('click', () => void this.refresh(), { signal });

    // 周期预设联动
    this.elements.presetSelect?.addEventListener('change', () => {
      const val = this.elements.presetSelect.value;
      if (val) {
        this.elements.scheduleInput.value = val;
        this.updateScheduleHint();
      }
    }, { signal });

    this.elements.scheduleInput?.addEventListener('input', () => {
      this.updateScheduleHint();
    }, { signal });

    // 任务类型联动：命令 vs 脚本
    const syncType = () => {
      const isScript = this.elements.typeScriptRadio.checked;
      this.elements.commandGroup.hidden = isScript;
      this.elements.scriptGroup.hidden = !isScript;
    };
    this.elements.typeCommandRadio?.addEventListener('change', syncType, { signal });
    this.elements.typeScriptRadio?.addEventListener('change', syncType, { signal });

    // 弹窗关闭与取消
    this.elements.dialogClose?.addEventListener('click', () => this.elements.dialog.close(), { signal });
    this.elements.dialogCancel?.addEventListener('click', () => this.elements.dialog.close(), { signal });

    // 保存任务
    this.elements.dialogSave?.addEventListener('click', () => void this.handleSaveTask(), { signal });

    // 执行结果弹窗
    this.elements.runClose?.addEventListener('click', () => this.elements.runDialog.close(), { signal });
    this.elements.runDismiss?.addEventListener('click', () => this.elements.runDialog.close(), { signal });

    // 确认弹窗
    this.elements.confirmReject?.addEventListener('click', () => this.resolveConfirm(false), { signal });
    this.elements.confirmAccept?.addEventListener('click', () => this.resolveConfirm(true), { signal });

    // 列表事件委托
    this.elements.tableBody?.addEventListener('click', (event) => {
      const btn = (event.target as HTMLElement)?.closest<HTMLButtonElement>('[data-cron-action]');
      if (!btn) return;
      const id = btn.dataset.cronId;
      const action = btn.dataset.cronAction;
      if (!id || !action) return;
      const task = this.tasks.find((t) => t.id === id);
      if (!task) return;

      if (action === 'run') void this.runTask(task);
      else if (action === 'edit') void this.openEditModal(task);
      else if (action === 'toggle') void this.toggleTask(task);
      else if (action === 'delete') void this.deleteTask(task);
    }, { signal });
  }

  private updateScheduleHint(): void {
    const val = this.elements.scheduleInput.value.trim();
    this.elements.scheduleHint.textContent = val ? explainCron(val) : '请输入 Cron 5 段表达式';
  }

  private handleMessage(serialized: string, generation: number): void {
    if (generation !== this.generation) return;
    let message: unknown;
    try { message = JSON.parse(serialized); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;

    if (value.type === 'cron_ready') {
      this.ready = true;
      void this.refresh();
      return;
    }

    if (value.type === 'cron_action_result') {
      const requestId = typeof value.requestId === 'string' ? value.requestId : '';
      const pending = this.pendingActions.get(requestId);
      if (!pending) return;
      this.pendingActions.delete(requestId);
      pending.resolve({
        ok: value.ok === true,
        stdout: typeof value.stdout === 'string' ? value.stdout : '',
        stderr: typeof value.stderr === 'string' ? value.stderr : '',
        exitStatus: typeof value.exitStatus === 'number' ? value.exitStatus : (value.ok ? 0 : 1),
      });
      return;
    }

    if (value.type === 'cron_error') {
      const text = typeof value.message === 'string' ? value.message : '计划任务出错';
      this.showError(text);
    }
  }

  private executeAction(action: string, payload: Record<string, unknown> = {}): Promise<{ ok: boolean; stdout: string; stderr: string; exitStatus?: number | null }> {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('计划任务服务尚未就绪。'));
    }
    const requestId = `${this.generation}-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      this.pendingActions.set(requestId, { requestId, action, resolve, reject });
      this.send({ type: 'cron_action', requestId, action, payload });
    });
  }

  async refresh(): Promise<void> {
    if (!this.ready) return;
    this.setStatus('正在读取计划任务列表…');
    try {
      const res = await this.executeAction('list');
      if (res.ok) {
        this.tasks = parseCrontab(res.stdout);
        this.renderEntries();
        this.renderCounters();
        this.elements.error.hidden = true;
        this.setStatus(`共 ${this.tasks.length} 个任务`);
      } else {
        this.showError(`读取计划任务失败：${res.stderr || res.stdout}`);
      }
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderCounters(): void {
    const total = this.tasks.length;
    const enabled = this.tasks.filter((t) => t.enabled).length;
    const disabled = total - enabled;
    this.elements.totalCount.textContent = String(total);
    this.elements.enabledCount.textContent = String(enabled);
    this.elements.disabledCount.textContent = String(disabled);
  }

  private renderEntries(): void {
    const body = this.elements.tableBody;
    body.replaceChildren();
    this.elements.empty.hidden = this.tasks.length > 0 || !this.ready;

    for (const task of this.tasks) {
      const row = document.createElement('tr');
      row.dataset.cronId = task.id;

      // 1. 任务名称
      const nameTd = document.createElement('td');
      nameTd.className = 'cron-name-cell';
      const nameTitle = document.createElement('strong');
      nameTitle.textContent = task.name;
      const nameSub = document.createElement('code');
      nameSub.textContent = task.schedule;
      nameTd.append(nameTitle, nameSub);

      // 2. 执行周期
      const schedTd = document.createElement('td');
      schedTd.textContent = explainCron(task.schedule);
      schedTd.title = task.schedule;

      // 3. 任务类型
      const typeTd = document.createElement('td');
      const typeBadge = document.createElement('span');
      typeBadge.className = `cron-type-badge is-${task.type}`;
      typeBadge.textContent = task.type === 'script' ? '脚本文件' : 'Shell 命令';
      typeTd.append(typeBadge);

      // 4. 执行内容
      const cmdTd = document.createElement('td');
      cmdTd.className = 'cron-cmd-cell';
      cmdTd.textContent = task.type === 'script' && task.scriptPath ? task.scriptPath : task.command;
      cmdTd.title = task.command;

      // 5. 状态
      const statusTd = document.createElement('td');
      statusTd.className = 'cron-status-cell';
      const dot = document.createElement('i');
      dot.className = `cron-dot is-${task.enabled ? 'enabled' : 'disabled'}`;
      const statusText = document.createElement('span');
      statusText.textContent = task.enabled ? '已启用' : '已停用';
      statusTd.append(dot, statusText);

      // 6. 操作按钮
      const actionsTd = document.createElement('td');
      actionsTd.className = 'cron-actions-cell';

      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'cron-action';
      runBtn.dataset.cronAction = 'run';
      runBtn.dataset.cronId = task.id;
      runBtn.textContent = '执行';
      runBtn.title = '立即执行一次';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'cron-action';
      editBtn.dataset.cronAction = 'edit';
      editBtn.dataset.cronId = task.id;
      editBtn.textContent = '编辑';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'cron-action';
      toggleBtn.dataset.cronAction = 'toggle';
      toggleBtn.dataset.cronId = task.id;
      toggleBtn.textContent = task.enabled ? '停用' : '启用';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'cron-action danger';
      delBtn.dataset.cronAction = 'delete';
      delBtn.dataset.cronId = task.id;
      delBtn.textContent = '删除';

      actionsTd.append(runBtn, editBtn, toggleBtn, delBtn);
      row.append(nameTd, schedTd, typeTd, cmdTd, statusTd, actionsTd);
      body.append(row);
    }
  }

  /**
   * 打开新建任务弹窗，支持外部传入初始数据（如从容器升级一键添加）。
   */
  openCreateModal(initial: { name?: string; schedule?: string; command?: string; type?: CronTaskType; scriptPath?: string } = {}): void {
    this.editingTaskId = null;
    this.elements.dialogTitle.textContent = '新建计划任务';
    this.elements.nameInput.value = initial.name ?? '';
    this.elements.scheduleInput.value = initial.schedule ?? '0 3 * * *';
    this.elements.presetSelect.value = initial.schedule ?? '0 3 * * *';
    this.updateScheduleHint();

    const isScript = initial.type === 'script';
    this.elements.typeCommandRadio.checked = !isScript;
    this.elements.typeScriptRadio.checked = isScript;
    this.elements.commandGroup.hidden = isScript;
    this.elements.scriptGroup.hidden = !isScript;

    this.elements.commandInput.value = initial.command ?? '';
    this.elements.scriptPathInput.value = initial.scriptPath ?? '/root/scripts/task.sh';
    this.elements.scriptArea.value = '#!/bin/bash\nset -e\n\necho "Running scheduled task..."\n';

    if (!this.elements.dialog.open) this.elements.dialog.showModal();
    this.elements.nameInput.focus();
  }

  /**
   * 打开编辑任务弹窗。如果是脚本文件任务，自动读取远程脚本文件内容。
   */
  async openEditModal(task: CronTask): Promise<void> {
    this.editingTaskId = task.id;
    this.elements.dialogTitle.textContent = '编辑计划任务';
    this.elements.nameInput.value = task.name;
    this.elements.scheduleInput.value = task.schedule;
    this.elements.presetSelect.value = task.schedule;
    this.updateScheduleHint();

    const isScript = task.type === 'script';
    this.elements.typeCommandRadio.checked = !isScript;
    this.elements.typeScriptRadio.checked = isScript;
    this.elements.commandGroup.hidden = isScript;
    this.elements.scriptGroup.hidden = !isScript;

    this.elements.commandInput.value = task.command;
    this.elements.scriptPathInput.value = task.scriptPath ?? '';
    this.elements.scriptArea.value = '正在从服务器读取脚本文件…';

    if (!this.elements.dialog.open) this.elements.dialog.showModal();

    if (isScript && task.scriptPath) {
      try {
        const res = await this.executeAction('read_script', { path: task.scriptPath });
        this.elements.scriptArea.value = res.ok ? res.stdout : `无法读取脚本文件：${res.stderr || res.stdout}`;
      } catch {
        this.elements.scriptArea.value = '读取脚本失败';
      }
    }
  }

  private async handleSaveTask(): Promise<void> {
    const name = this.elements.nameInput.value.trim();
    const schedule = this.elements.scheduleInput.value.trim();
    if (!name) {
      alert('请输入任务名称。');
      return;
    }
    if (!schedule) {
      alert('请输入有效的 Cron 执行周期。');
      return;
    }

    const isScript = this.elements.typeScriptRadio.checked;
    let command = this.elements.commandInput.value.trim();
    let scriptPath: string | undefined;

    if (isScript) {
      scriptPath = this.elements.scriptPathInput.value.trim();
      if (!scriptPath || !scriptPath.startsWith('/')) {
        alert('请输入合法的绝对路径脚本文件地址（如 /root/scripts/test.sh）。');
        return;
      }
      const scriptCode = this.elements.scriptArea.value;
      this.setStatus('正在向服务器保存脚本文件并赋予执行权限…');
      try {
        const scriptRes = await this.executeAction('save_script', {
          path: scriptPath,
          base64Data: toBase64(scriptCode),
        });
        if (!scriptRes.ok) {
          alert(`保存脚本文件失败：${scriptRes.stderr || scriptRes.stdout}`);
          return;
        }
      } catch (err) {
        alert(`保存脚本失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      command = `/bin/bash ${scriptPath}`;
    } else {
      if (!command) {
        alert('请输入要执行的 Shell 命令。');
        return;
      }
    }

    const nextTasks = [...this.tasks];
    if (this.editingTaskId) {
      const idx = nextTasks.findIndex((t) => t.id === this.editingTaskId);
      if (idx >= 0) {
        nextTasks[idx] = {
          ...nextTasks[idx],
          name,
          schedule,
          command,
          type: isScript ? 'script' : 'command',
          scriptPath,
        };
      }
    } else {
      nextTasks.push({
        id: `task-${Date.now()}`,
        name,
        schedule,
        command,
        enabled: true,
        type: isScript ? 'script' : 'command',
        scriptPath,
      });
    }

    this.setStatus('正在更新远程服务器 crontab…');
    try {
      const formatted = formatCrontab(nextTasks);
      const res = await this.executeAction('save', { base64Data: toBase64(formatted) });
      if (res.ok) {
        this.elements.dialog.close();
        this.options.onToast?.('计划任务已成功保存到服务器。', 'Cron task saved successfully.', 'info');
        await this.refresh();
      } else {
        alert(`更新 crontab 失败：${res.stderr || res.stdout}`);
      }
    } catch (err) {
      alert(`更新 crontab 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async toggleTask(task: CronTask): Promise<void> {
    const nextTasks = this.tasks.map((t) => t.id === task.id ? { ...t, enabled: !t.enabled } : t);
    this.setStatus('正在更新任务状态…');
    try {
      const formatted = formatCrontab(nextTasks);
      const res = await this.executeAction('save', { base64Data: toBase64(formatted) });
      if (res.ok) {
        this.options.onToast?.(`已${task.enabled ? '停用' : '启用'}任务：${task.name}`, `${task.enabled ? 'Disabled' : 'Enabled'}: ${task.name}`, 'info');
        await this.refresh();
      } else {
        this.showError(`状态切换失败：${res.stderr || res.stdout}`);
      }
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private async deleteTask(task: CronTask): Promise<void> {
    const confirmed = await this.confirm({
      title: '删除计划任务',
      description: `确定要从服务器 crontab 中删除「${task.name}」吗？此操作不可撤销。`,
    });
    if (!confirmed) return;

    const nextTasks = this.tasks.filter((t) => t.id !== task.id);
    this.setStatus('正在从 crontab 中移除任务…');
    try {
      const formatted = formatCrontab(nextTasks);
      const res = await this.executeAction('save', { base64Data: toBase64(formatted) });
      if (res.ok) {
        this.options.onToast?.(`已删除计划任务：${task.name}`, `Deleted task: ${task.name}`, 'info');
        await this.refresh();
      } else {
        this.showError(`删除任务失败：${res.stderr || res.stdout}`);
      }
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private async runTask(task: CronTask): Promise<void> {
    this.setStatus(`正在执行任务：${task.name}…`);
    this.elements.runTitle.textContent = `执行结果 · ${task.name}`;
    this.elements.runText.textContent = `[启动时间: ${new Date().toLocaleTimeString()}]\n$ ${task.command}\n\n正在执行中…\n`;
    if (!this.elements.runDialog.open) this.elements.runDialog.showModal();

    try {
      const res = await this.executeAction('run', { base64Data: toBase64(task.command) });
      const out = [
        `[执行完成 - 退出状态码: ${res.exitStatus ?? (res.ok ? 0 : 1)}]`,
        `$ ${task.command}`,
        '',
        res.stdout ? `=== STDOUT ===\n${res.stdout}` : '',
        res.stderr ? `=== STDERR ===\n${res.stderr}` : '',
        !res.stdout && !res.stderr ? '(该命令执行成功，未产生任何输出)' : '',
      ].filter(Boolean).join('\n');
      this.elements.runText.textContent = out;
      this.setStatus(`任务执行完成：${task.name}`);
    } catch (err) {
      this.elements.runText.textContent = `执行出错：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private confirm(copy: { title: string; description: string }): Promise<boolean> {
    const dialog = this.elements.confirmDialog;
    if (!dialog) return Promise.resolve(window.confirm(copy.description));
    this.elements.confirmTitle.textContent = copy.title;
    this.elements.confirmDescription.textContent = copy.description;
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

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function requiredElement<T extends Element>(root: ParentNode, id: string): T {
  const node = root.querySelector<T>(`#${id}`);
  if (!node) throw new Error(`Missing cron element #${id}`);
  return node;
}

export function collectCronManagerElements(root: ParentNode = document): CronManagerElements {
  return {
    panel: requiredElement(root, 'cron-manager-panel'),
    tableBody: requiredElement(root, 'cron-table-body'),
    status: requiredElement(root, 'cron-manager-status'),
    empty: requiredElement(root, 'cron-manager-empty'),
    error: requiredElement(root, 'cron-manager-error'),
    totalCount: requiredElement(root, 'cron-total-count'),
    enabledCount: requiredElement(root, 'cron-enabled-count'),
    disabledCount: requiredElement(root, 'cron-disabled-count'),
    newButton: requiredElement(root, 'cron-btn-new'),
    refreshButton: requiredElement(root, 'cron-btn-refresh'),
    dialog: requiredElement(root, 'cron-task-dialog'),
    dialogTitle: requiredElement(root, 'cron-task-title'),
    nameInput: requiredElement(root, 'cron-task-name'),
    presetSelect: requiredElement(root, 'cron-preset-select'),
    scheduleInput: requiredElement(root, 'cron-task-schedule'),
    scheduleHint: requiredElement(root, 'cron-schedule-hint'),
    typeCommandRadio: requiredElement(root, 'cron-type-command'),
    typeScriptRadio: requiredElement(root, 'cron-type-script'),
    commandGroup: requiredElement(root, 'cron-command-group'),
    commandInput: requiredElement(root, 'cron-command-input'),
    scriptGroup: requiredElement(root, 'cron-script-group'),
    scriptPathInput: requiredElement(root, 'cron-script-path'),
    scriptArea: requiredElement(root, 'cron-script-area'),
    dialogSave: requiredElement(root, 'cron-dialog-save'),
    dialogCancel: requiredElement(root, 'cron-dialog-cancel'),
    dialogClose: requiredElement(root, 'cron-dialog-close'),
    runDialog: requiredElement(root, 'cron-run-dialog'),
    runTitle: requiredElement(root, 'cron-run-title'),
    runText: requiredElement(root, 'cron-run-text'),
    runClose: requiredElement(root, 'cron-run-close'),
    runDismiss: requiredElement(root, 'cron-run-dismiss'),
    confirmDialog: requiredElement(root, 'cron-confirm-dialog'),
    confirmTitle: requiredElement(root, 'cron-confirm-title'),
    confirmDescription: requiredElement(root, 'cron-confirm-description'),
    confirmAccept: requiredElement(root, 'cron-confirm-accept'),
    confirmReject: requiredElement(root, 'cron-confirm-reject'),
  };
}
