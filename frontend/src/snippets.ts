import { SnippetStore, type Snippet } from './snippet-store';
import { SnippetEditor } from './snippet-editor';
import { SnippetList } from './snippet-list';
import { SnippetPanel } from './snippet-panel';
import './snippets.css';

export class Snippets {
  readonly page = document.createElement('section');
  private readonly store = new SnippetStore();

  constructor(container: HTMLElement, use: (snippet: Snippet) => void, openTerminal: () => void, openLibrary: () => void) {
    const editor = new SnippetEditor(this.store);
    this.page.id = 'snippets-page';
    this.page.className = 'snippet-page snippet-surface';
    this.page.hidden = true;
    this.page.setAttribute('aria-labelledby', 'snippets-heading');
    this.page.innerHTML = `<header class="snippet-page-heading"><span class="snippet-symbol" aria-hidden="true">{ }</span>
      <h1 id="snippets-heading" tabindex="-1">代码片段</h1>
      <button type="button" class="snippet-open-terminal">打开 SSH 终端 ↗</button></header>`;
    this.page.querySelector('.snippet-open-terminal')!.addEventListener('click', openTerminal);
    this.page.append(new SnippetList(this.store, editor).root);
    new SnippetPanel(container, this.store, editor, use, openLibrary);
  }

  show(): void {
    this.page.hidden = false; void this.store.load(true);
    this.page.querySelector<HTMLElement>('h1')!.focus();
  }

  hide(): void { this.page.hidden = true; }
  load(): void { void this.store.load(true); }

  /** 进入工作台时刷新：浮窗挂在终局面板内，用户切过去就要看到最新片段。 */
  refresh(): void { console.log('DBG snippets.refresh'); void this.store.load(true); }
  clear(): void { this.store.clear(); }
}
