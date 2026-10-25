import type { ContainerManager } from './container-manager';
import './container-page.css';

interface ContainerPageActions {
  connect(host: ContainerHost): Promise<void>;
  disconnect(): void;
}

/** 只取容器页需要的字段，避免和 cloud-api 的 CloudHost 形成循环依赖。 */
export interface ContainerHost {
  id: string;
  name: string;
  username: string;
  host: string;
  port: number;
}

const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" /></svg>';

/**
 * 独立容器页：与文件页同构，负责主机选择与页面外壳，
 * 具体的 docker 交互全部交给 ContainerManager。
 */
export class ContainerPage {
  readonly root = document.createElement('main');
  private readonly select: HTMLSelectElement;
  private readonly connectButton: HTMLButtonElement;
  private hosts: ContainerHost[] = [];
  private state: 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error' = 'idle';
  private preparing = false;
  private mounted = false;

  constructor(
    private readonly panel: HTMLElement,
    private readonly actions: ContainerPageActions,
    private readonly manager: ContainerManager,
  ) {
    this.root.className = 'containers-page';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="containers-heading">
        <h1 id="containers-heading" tabindex="-1">容器</h1>
      </header>
      <section class="containers-connection" aria-label="容器管理连接">
        <span class="containers-host-icon">${folderIcon}</span>
        <label class="containers-host-field" for="containers-host"><span>目标主机</span>
          <select id="containers-host" aria-describedby="containers-host-hint"><option value="">请选择主机</option></select>
        </label>
        <button id="containers-connect" class="home-button primary" type="button" disabled>连接主机</button>
        <div class="containers-connection-meta"><span id="containers-connection-state" class="containers-state" data-state="idle" role="status">未连接</span>
          <span id="containers-host-hint">使用已保存的 SSH 凭据安全连接</span></div>
      </section>
      <p id="containers-notice" class="containers-notice" role="status" hidden></p>
      <section class="containers-browser" aria-label="远程容器">
        <div class="containers-panel-slot"></div>
      </section>
      <footer class="containers-footer"><span>启停 / 重启 / 暂停直接生效 · 删除需确认（运行中容器将自动停止并强制删除）</span>
        <span>采样周期 5 秒 · 日志默认 200 行</span></footer>`;
    this.select = this.get<HTMLSelectElement>('#containers-host');
    this.connectButton = this.get<HTMLButtonElement>('#containers-connect');
    this.select.addEventListener('change', () => this.renderConnection());
    this.connectButton.addEventListener('click', () => void this.toggleConnection());
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }

  show(): void {
    this.mounted = true;
    this.root.hidden = false;
    // 面板只搬一次：终局与文件面板同理，避免重复移动破坏 SSH 附属通道。
    if (this.panel.parentElement !== this.get('.containers-panel-slot')) {
      this.get('.containers-panel-slot').append(this.panel);
    }
    this.panel.hidden = false;
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-labelledby', 'workbench-title');
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

  setConnection(state: ContainerPage['state'], hostId?: string): void {
    this.state = state;
    if (hostId && this.hosts.some((h) => h.id === hostId)) {
      this.select.value = hostId;
    }
    this.renderConnection();
  }

  setMessage(message: string, error = false): void {
    const notice = this.get('#containers-notice');
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
    const labels: Record<ContainerPage['state'], string> = {
      idle: '未连接', connecting: '正在连接', connected: 'SSH 已连接',
      disconnecting: '正在断开', error: '连接失败',
    };
    const badge = this.get('#containers-connection-state');
    badge.textContent = labels[this.state];
    badge.dataset.state = this.state;
    this.get('#containers-host-hint').textContent = active
      ? '与终端共用会话 · 切换主机前请先断开'
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
