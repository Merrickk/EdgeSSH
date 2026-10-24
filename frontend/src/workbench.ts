import type { FilePage } from './file-page';
import type { ContainerPage } from './container-page';
import './workbench.css';

export type WorkbenchTab = 'files' | 'containers' | 'terminal';

interface WorkbenchActions {
  openFiles(): void;
  openContainers(): void;
  openTerminal(): void;
}

const TABS: Array<{ id: WorkbenchTab; label: string; icon: string }> = [
  { id: 'files', label: '文件', icon: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/>' },
  { id: 'containers', label: '容器', icon: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>' },
  { id: 'terminal', label: '终端', icon: '<path d="m5 6 6 6-6 6m8 0h6"/>' },
];

/**
 * 统一工作台：文件 / 容器 / 终端三个面板共用一层页面外壳，
 * 右上角标签切换。终端常驻 DOM，切换面板不会打断 SSH 会话。
 */
export class Workbench {
  readonly root = document.createElement('main');
  private readonly tabButtons = new Map<WorkbenchTab, HTMLButtonElement>();
  private active: WorkbenchTab = 'files';

  constructor(
    private readonly files: FilePage,
    private readonly containers: ContainerPage,
    private readonly terminalPanel: HTMLElement,
    private readonly actions: WorkbenchActions,
  ) {
    this.root.className = 'workbench';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="workbench-heading">
        <h1 id="workbench-title" tabindex="-1">文件</h1>
        <nav class="workbench-tabs" role="tablist" aria-label="工作区面板">
          ${TABS.map((tab) => `
            <button id="workbench-tab-${tab.id}" class="workbench-tab" type="button" role="tab"
              aria-selected="${tab.id === 'files'}" aria-controls="workbench-panel-${tab.id}" tabindex="${tab.id === 'files' ? 0 : -1}">
              <svg viewBox="0 0 24 24" aria-hidden="true">${tab.icon}</svg><span>${tab.label}</span>
            </button>`).join('')}
        </nav>
      </header>
      <div class="workbench-body">
        <section id="workbench-panel-files" class="workbench-panel" role="tabpanel" aria-labelledby="workbench-tab-files"></section>
        <section id="workbench-panel-containers" class="workbench-panel" role="tabpanel" aria-labelledby="workbench-tab-containers" hidden></section>
        <section id="workbench-panel-terminal" class="workbench-panel" role="tabpanel" aria-labelledby="workbench-tab-terminal" hidden></section>
      </div>`;
    for (const tab of TABS) {
      const button = this.root.querySelector<HTMLButtonElement>(`#workbench-tab-${tab.id}`)!;
      this.tabButtons.set(tab.id, button);
      button.addEventListener('click', () => this.show(tab.id));
      button.addEventListener('keydown', (event) => this.handleKey(event, tab.id));
    }
  }

  /** 挂载三个面板；终局面板只移动一次，之后靠 hidden 切换。 */
  mount(): void {
    const filesSlot = this.root.querySelector('#workbench-panel-files')!;
    const containersSlot = this.root.querySelector('#workbench-panel-containers')!;
    const terminalSlot = this.root.querySelector('#workbench-panel-terminal')!;
    filesSlot.append(this.files.root);
    containersSlot.append(this.containers.root);
    terminalSlot.append(this.terminalPanel);
  }

  show(tab: WorkbenchTab): void {
    // 首次显示或切换面板时才执行；重复 show 同一面板会让内容反复 hidden/unhidden。
    const firstPaint = this.root.hidden;
    this.root.hidden = false;
    if (!firstPaint && this.active === tab) return;
    this.active = tab;
    for (const [id, button] of this.tabButtons) {
      const selected = id === tab;
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('aria-expanded', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const id of ['files', 'containers', 'terminal'] as WorkbenchTab[]) {
      const panel = this.root.querySelector<HTMLElement>(`#workbench-panel-${id}`)!;
      panel.hidden = id !== tab;
    }
    const title = this.root.querySelector<HTMLElement>('#workbench-title')!;
    title.textContent = TABS.find((item) => item.id === tab)!.label;
    title.dataset.i18nZh = title.textContent;
    title.dataset.i18nEn = TABS.find((item) => item.id === tab)!.label;
    // 文件/容器页各自管理连接态；终局面板不需要额外动作。
    if (tab === 'files') this.files.show();
    else this.files.hide();
    if (tab === 'containers') this.containers.show();
    else this.containers.hide();
    // 虚拟列表与终端都依赖容器尺寸：切回这两个面板时重新测量，
    // 否则 Arborist 的 ResizeObserver 拿到的是挂载时的 0 高度。
    if (tab === 'terminal' || tab === 'files') {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }
    title.focus();
  }

  private handleKey(event: KeyboardEvent, id: WorkbenchTab): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = TABS.map((tab) => tab.id);
    const current = ids.indexOf(id);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? ids.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    this.show(ids[next]);
    this.tabButtons.get(ids[next])!.focus();
  }
}
