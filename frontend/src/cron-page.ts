import type { CronManager } from './cron-manager';
import type { ContainerHost } from './container-page';
import './cron-page.css';

interface CronPageActions {
  connect(host: ContainerHost): Promise<void>;
  disconnect(): void;
}

const clockIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

export class CronPage {
  readonly root = document.createElement('main');
  private readonly select: HTMLSelectElement;
  private readonly connectButton: HTMLButtonElement;
  private hosts: ContainerHost[] = [];
  private state: 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error' = 'idle';
  private preparing = false;
  private mounted = false;

  constructor(
    private readonly panel: HTMLElement,
    private readonly actions: CronPageActions,
    public readonly manager: CronManager,
  ) {
    this.root.className = 'cron-page';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="cron-page-heading">
        <h1 id="cron-heading" tabindex="-1">计划任务</h1>
      </header>
      <section class="cron-connection" aria-label="计划任务连接">
        <span class="cron-host-icon">${clockIcon}</span>
        <label class="cron-host-field" for="cron-host"><span>目标主机</span>
          <select id="cron-host" aria-describedby="cron-host-hint"><option value="">请选择主机</option></select>
        </label>
        <button id="cron-connect" class="home-button primary" type="button" disabled>连接主机</button>
        <div class="cron-connection-meta"><span id="cron-connection-state" class="cron-state" data-state="idle" role="status">未连接</span>
          <span id="cron-host-hint">使用已保存的 SSH 凭据安全连接</span></div>
      </section>
      <p id="cron-notice" class="cron-notice" role="status" hidden></p>
      <section class="cron-browser" aria-label="远程计划任务">
        <div class="cron-panel-slot"></div>
      </section>
      <footer class="cron-footer">
        <span>支持执行自定义 Shell 命令与远程脚本文件 · 变更直接生效于系统 crontab</span>
        <span>标准 Cron 5 段格式 · 支持开机自启 (@reboot)</span>
      </footer>`;

    this.select = this.get<HTMLSelectElement>('#cron-host');
    this.connectButton = this.get<HTMLButtonElement>('#cron-connect');
    this.select.addEventListener('change', () => this.renderConnection());
    this.connectButton.addEventListener('click', () => void this.toggleConnection());
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }

  show(): void {
    this.mounted = true;
    this.root.hidden = false;
    if (this.panel.parentElement !== this.get('.cron-panel-slot')) {
      this.get('.cron-panel-slot').append(this.panel);
    }
    this.panel.hidden = false;
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-labelledby', 'cron-heading');
    this.get('#cron-heading').focus();
    void this.manager.refresh();
  }

  hide(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.root.hidden = true;
    this.panel.hidden = true;
  }

  setHosts(hosts: ContainerHost[]): void {
    const selected = this.select.value;
    this.hosts = hosts;
    this.select.replaceChildren(new Option(hosts.length ? '请选择主机' : '暂无主机，请先在总览添加', ''));
    for (const host of hosts) {
      this.select.add(new Option(`${host.name} · ${host.username}@${host.host}:${host.port}`, host.id));
    }
    this.select.value = hosts.some((host) => host.id === selected) ? selected : '';
    this.renderConnection();
  }

  setConnection(state: 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error', hostId?: string): void {
    this.state = state;
    if (hostId && this.hosts.some((h) => h.id === hostId)) {
      this.select.value = hostId;
    }
    this.renderConnection();
  }

  setMessage(message: string, error = false): void {
    const notice = this.get('#cron-notice');
    notice.textContent = message;
    notice.classList.toggle('error', error);
    notice.hidden = !message;
  }

  confirmLeave(): boolean {
    return true;
  }

  private renderConnection(): void {
    const active = this.state === 'connecting' || this.state === 'connected';
    const busy = this.preparing || this.state === 'disconnecting';
    this.select.disabled = active || busy || !this.hosts.length;
    this.connectButton.disabled = busy || (!active && !this.select.value);
    this.connectButton.classList.toggle('primary', !active);
    this.connectButton.textContent = this.preparing ? '读取凭据中…'
      : this.state === 'connecting' ? '取消连接'
        : this.state === 'connected' ? '断开连接'
          : this.state === 'disconnecting' ? '正在断开…' : '连接主机';
    const labels: Record<string, string> = {
      idle: '未连接', connecting: '正在连接', connected: 'SSH 已连接',
      disconnecting: '正在断开', error: '连接失败',
    };
    const badge = this.get('#cron-connection-state');
    badge.textContent = labels[this.state] || '未连接';
    badge.dataset.state = this.state;
    this.get('#cron-host-hint').textContent = active
      ? '与工作台共用会话 · 切换主机前请先断开'
      : '使用已保存的 SSH 凭据安全连接';
  }

  private async toggleConnection(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') {
      this.actions.disconnect();
      return;
    }
    const host = this.hosts.find((item) => item.id === this.select.value);
    if (!host || this.preparing || this.state === 'disconnecting') return;
    this.preparing = true;
    this.renderConnection();
    this.setMessage(`正在读取 ${host.name} 的连接凭据…`);
    try { await this.actions.connect(host); }
    catch (error) { this.setMessage(error instanceof Error ? error.message : '连接准备失败，请重试。', true); }
    finally { this.preparing = false; this.renderConnection(); }
  }
}
