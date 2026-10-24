import type { CloudHost } from './cloud-api';
import './terminal-page.css';

export interface TerminalConnectParams {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey';
  password?: string;
  privateKey?: string;
  cfTunnel?: boolean;
}

interface TerminalPageActions {
  connectHost(host: CloudHost): Promise<void>;
  connectCustom(params: TerminalConnectParams): Promise<void>;
  disconnect(): void;
}

const terminalIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 6 6 6-6 6m8 0h6"/></svg>';

export class TerminalPage {
  readonly root = document.createElement('main');
  private readonly select: HTMLSelectElement;
  private readonly connectButton: HTMLButtonElement;
  private readonly customToggle: HTMLButtonElement;
  private readonly customForm: HTMLFormElement;
  private hosts: CloudHost[] = [];
  private state: 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error' = 'idle';
  private preparing = false;
  private mounted = false;

  constructor(
    private readonly panel: HTMLElement,
    private readonly actions: TerminalPageActions,
  ) {
    this.root.className = 'terminal-page';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="terminal-page-heading">
        <h1 id="terminal-page-heading" tabindex="-1">终端</h1>
      </header>
      <section class="terminal-connection" aria-label="终端连接">
        <span class="terminal-host-icon">${terminalIcon}</span>
        <label class="terminal-host-field" for="terminal-host"><span>目标主机</span>
          <select id="terminal-host" aria-describedby="terminal-host-hint"><option value="">请选择主机</option></select>
        </label>
        <button id="terminal-connect" class="home-button primary" type="button" disabled>连接主机</button>
        <button id="terminal-custom-toggle" class="home-button" type="button">快速填写参数 ▾</button>
        <div class="terminal-connection-meta">
          <span id="terminal-connection-state" class="terminal-state" data-state="idle" role="status">未连接</span>
          <span id="terminal-host-hint">选择保存的主机或快速自定义参数</span>
        </div>
      </section>

      <!-- 快速填写参数展开区 -->
      <form id="terminal-quick-form" class="terminal-quick-form" autocomplete="off" hidden>
        <div class="terminal-quick-grid">
          <label><span>主机地址 *</span><input name="host" placeholder="例如 192.0.2.1 或 example.com" required /></label>
          <label><span>端口 *</span><input name="port" type="number" value="22" min="1" max="65535" required /></label>
          <label><span>用户名 *</span><input name="username" value="root" required /></label>
          <label><span>认证方式</span>
            <select name="authMethod">
              <option value="password">密码认证</option>
              <option value="publickey">私钥认证</option>
            </select>
          </label>
          <label id="quick-pwd-field"><span>密码</span><input name="password" type="password" autocomplete="new-password" placeholder="主机 SSH 密码" /></label>
          <label id="quick-key-field" hidden><span>OpenSSH 私钥</span><textarea name="privateKey" rows="2" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>
          <label class="quick-tunnel-label">
            <input name="cfTunnel" type="checkbox" />
            <span>使用 Cloudflare Tunnel (WebSocket 隧道)</span>
          </label>
        </div>
        <div class="terminal-quick-actions">
          <button class="home-button primary" type="submit">一键连接</button>
          <button id="terminal-quick-cancel" class="home-button" type="button">收起</button>
        </div>
      </form>

      <p id="terminal-notice" class="terminal-notice" role="status" hidden></p>
      <section class="terminal-browser" aria-label="SSH 终端">
        <div class="terminal-panel-slot"></div>
      </section>
      <footer class="terminal-footer">
        <span>支持快捷键工具栏 · 命令编辑器 · 会话事件日志 · 保持后台长连不中断</span>
        <span>自适应终端分辨率 · 支持 UTF-8、GBK 编码</span>
      </footer>`;

    this.select = this.get<HTMLSelectElement>('#terminal-host');
    this.connectButton = this.get<HTMLButtonElement>('#terminal-connect');
    this.customToggle = this.get<HTMLButtonElement>('#terminal-custom-toggle');
    this.customForm = this.get<HTMLFormElement>('#terminal-quick-form');

    this.select.addEventListener('change', () => this.renderConnection());
    this.connectButton.addEventListener('click', () => void this.toggleConnection());
    this.customToggle.addEventListener('click', () => this.toggleCustomForm());
    this.get('#terminal-quick-cancel').addEventListener('click', () => this.toggleCustomForm(false));

    const authSelect = this.customForm.querySelector<HTMLSelectElement>('[name="authMethod"]')!;
    authSelect.addEventListener('change', () => {
      const isKey = authSelect.value === 'publickey';
      this.get('#quick-pwd-field').hidden = isKey;
      this.get('#quick-key-field').hidden = !isKey;
    });

    this.customForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.handleCustomConnect();
    });
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }

  show(): void {
    this.mounted = true;
    this.root.hidden = false;
    if (this.panel.parentElement !== this.get('.terminal-panel-slot')) {
      this.get('.terminal-panel-slot').append(this.panel);
    }
    this.panel.hidden = false;
    this.get('#terminal-page-heading').focus();
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  hide(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.root.hidden = true;
    // 不隐藏 panel，保持终端在后台持续运行接收数据
  }

  setHosts(hosts: CloudHost[]): void {
    const selected = this.select.value;
    this.hosts = hosts;
    this.select.replaceChildren(new Option(hosts.length ? '请选择主机' : '暂无主机，请先在总览添加', ''));
    for (const host of hosts) {
      this.select.add(new Option(`${host.name} · ${host.username}@${host.host}:${host.port}`, host.id));
    }
    this.select.value = hosts.some((h) => h.id === selected) ? selected : '';
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
    const notice = this.get('#terminal-notice');
    notice.textContent = message;
    notice.classList.toggle('error', error);
    notice.hidden = !message;
  }

  private toggleCustomForm(expand?: boolean): void {
    const toExpand = expand !== undefined ? expand : this.customForm.hidden;
    this.customForm.hidden = !toExpand;
    this.customToggle.textContent = toExpand ? '收起自定义参数 ▴' : '快速填写参数 ▾';
    if (toExpand) {
      (this.customForm.elements.namedItem('host') as HTMLElement)?.focus();
    }
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
    const badge = this.get('#terminal-connection-state');
    badge.textContent = labels[this.state] || '未连接';
    badge.dataset.state = this.state;
    this.get('#terminal-host-hint').textContent = active
      ? '终端正在运行 · 切换主机前请先断开'
      : '选择保存的主机或快速填写参数';
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
    this.setMessage(`正在连接 ${host.name}…`);
    try { await this.actions.connectHost(host); }
    catch (error) { this.setMessage(error instanceof Error ? error.message : '连接准备失败，请重试。', true); }
    finally { this.preparing = false; this.renderConnection(); }
  }

  private async handleCustomConnect(): Promise<void> {
    const data = new FormData(this.customForm);
    const host = (data.get('host') as string).trim();
    const port = Number(data.get('port')) || 22;
    const username = (data.get('username') as string).trim() || 'root';
    const authMethod = (data.get('authMethod') as 'password' | 'publickey') || 'password';
    const password = (data.get('password') as string) || '';
    const privateKey = (data.get('privateKey') as string) || '';
    const cfTunnel = data.get('cfTunnel') === 'on';

    if (!host) {
      alert('请输入目标主机地址。');
      return;
    }

    this.toggleCustomForm(false);
    this.preparing = true;
    this.renderConnection();
    this.setMessage(`正在连接 ${username}@${host}:${port}…`);
    try {
      await this.actions.connectCustom({
        host, port, username, authMethod, password, privateKey, cfTunnel,
      });
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : '自定义连接失败。', true);
    } finally {
      this.preparing = false;
      this.renderConnection();
    }
  }
}
