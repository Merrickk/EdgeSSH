import type { FileListView } from './file-list-view';
import { fileKind, isEditableText } from './file-kind';

export const MAX_SFTP_FILE_SIZE = 64 * 1024 * 1024;
/** Preview downloads are capped lower to keep phone memory and Worker JSON small. */
const MAX_PREVIEW_TEXT_SIZE = 1024 * 1024;
const MAX_PREVIEW_IMAGE_SIZE = 8 * 1024 * 1024;
const PREVIEWABLE_KINDS = new Set(['image', 'document', 'script', 'config']);
export const SFTP_UPLOAD_CHUNK_SIZE = 64 * 1024;

/** 文本编辑器一次可读入 / 写回的最大体积，超过就只能下载。 */
export const MAX_EDIT_TEXT_SIZE = 2 * 1024 * 1024;

export interface FileManagerElements {
  panel: HTMLElement;
  path: HTMLInputElement;
  back: HTMLButtonElement;
  up: HTMLButtonElement;
  home: HTMLButtonElement;
  refresh: HTMLButtonElement;
  upload: HTMLButtonElement;
  download: HTMLButtonElement;
  mkdir: HTMLButtonElement;
  rename: HTMLButtonElement;
  delete: HTMLButtonElement;
  newFile?: HTMLButtonElement | null;
  breadcrumbs?: HTMLElement | null;
  pathToggle?: HTMLButtonElement | null;
  toggleHidden?: HTMLButtonElement | null;
  uploadInput: HTMLInputElement;
  tableBody: HTMLTableSectionElement;
  loading: HTMLElement;
  empty: HTMLElement;
  error: HTMLElement;
  status: HTMLElement;
  progress: HTMLElement;
  progressLabel: HTMLElement;
  progressBar: HTMLProgressElement;
  progressCancel: HTMLButtonElement;
  /** Optional mobile affordances; absent in older fixtures. */
  treeToggle?: HTMLButtonElement | null;
  filterBar?: HTMLElement | null;
  filterInput?: HTMLInputElement | null;
  filterToggle?: HTMLButtonElement | null;
  filterClear?: HTMLButtonElement | null;
  filterCount?: HTMLElement | null;
  sortKeySelect?: HTMLSelectElement | null;
  sortDirButton?: HTMLButtonElement | null;
  previewDialog?: HTMLDialogElement | null;
  previewTitle?: HTMLElement | null;
  previewImage?: HTMLImageElement | null;
  previewText?: HTMLElement | null;
  previewClose?: HTMLButtonElement | null;
  previewDismiss?: HTMLButtonElement | null;
  previewDownload?: HTMLButtonElement | null;
  propertiesDialog?: HTMLDialogElement | null;
  propertiesTitle?: HTMLElement | null;
  propertiesList?: HTMLElement | null;
  propertiesClose?: HTMLButtonElement | null;
  propertiesDismiss?: HTMLButtonElement | null;
  sheet?: HTMLElement | null;
  sheetTitle?: HTMLElement | null;
  sheetSubtitle?: HTMLElement | null;
  sheetClose?: HTMLButtonElement | null;
  sheetActions?: HTMLElement | null;
  editorDialog?: HTMLDialogElement | null;
  editorTitle?: HTMLElement | null;
  editorPath?: HTMLElement | null;
  editorArea?: HTMLTextAreaElement | null;
  editorStatus?: HTMLElement | null;
  editorSave?: HTMLButtonElement | null;
  editorClose?: HTMLButtonElement | null;
  editorDismiss?: HTMLButtonElement | null;
  editorCancel?: HTMLButtonElement | null;
}

export interface FileManagerOptions {
  elements: FileManagerElements;
  getLanguage?: () => string;
  confirm?: (message: string) => boolean | Promise<boolean>;
  prompt?: (message: string, defaultValue?: string) => string | null | Promise<string | null>;
  onError?: (message: string) => void;
  onStatus?: (message: string) => void;
  /** 只读模式下隐藏“编辑”入口；缺省表示可用。 */
  canEdit?: () => boolean;
}

export interface SFTPEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number | string;
  mtime: string | number;
  permissions: string | number;
  uid?: string | number;
  gid?: string | number;
  owner?: string;
  group?: string;
}

export type FileSortKey = 'name' | 'size' | 'mtime' | 'type' | 'owner';

/** Listener invoked whenever the FileManager's current working directory changes. */
export type CwdChangeListener = (cwd: string) => void;

const SORT_STORAGE_KEY = 'cf-webssh.file-sort';
const SORT_KEYS: FileSortKey[] = ['name', 'size', 'mtime', 'type', 'owner'];

function isFileSortKey(value: unknown): value is FileSortKey {
  return typeof value === 'string' && (SORT_KEYS as string[]).includes(value);
}

interface LocalizedText {
  zh: string;
  en: string;
}

interface PendingRequest {
  generation: number;
  operation: string;
  path: string;
  historyMode?: 'push' | 'none' | 'index';
  historyIndex?: number;
  resolve?: () => void;
  reject?: (error: Error) => void;
  suppressRefresh?: boolean;
}

interface UploadState {
  generation: number;
  requestId: string;
  file: File;
  path: string;
  sent: number;
  acknowledged: number;
  awaitingAck: boolean;
  endSent: boolean;
  readyForData: boolean;
  cancelling: boolean;
  cancelSent: boolean;
}

interface DownloadState {
  generation: number;
  requestId: string;
  path: string;
  name: string;
  expectedSize: number | null;
  received: number;
  chunks: ArrayBuffer[];
  started: boolean;
  cancelling: boolean;
  cancelSent: boolean;
  /** When true, the bytes are shown in the preview dialog instead of saved. */
  preview: boolean;
}

type SocketData = string | ArrayBuffer | ArrayBufferView | Blob;
type JsonRecord = Record<string, unknown>;

const DISCONNECTED: LocalizedText = {
  zh: '连接 SSH 后即可管理文件',
  en: 'Connect to SSH to manage files',
};

const DISCONNECTED_CHANNEL: LocalizedText = {
  zh: '文件管理连接已断开',
  en: 'File management connection lost',
};

// Auto-reconnect for the file manager after an unexpected drop.
const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_DELAYS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000];

function requiredElement<T extends Element>(root: ParentNode, id: string): T {
  const node = root.querySelector<T>(`#${id}`);
  if (!node) throw new Error(`Missing file manager element #${id}`);
  return node;
}

export function collectFileManagerElements(root: ParentNode = document): FileManagerElements {
  return {
    panel: requiredElement(root, 'file-manager-panel'),
    path: requiredElement(root, 'file-manager-path'),
    back: requiredElement(root, 'file-back'),
    up: requiredElement(root, 'file-up'),
    home: requiredElement(root, 'file-home'),
    refresh: requiredElement(root, 'file-refresh'),
    upload: requiredElement(root, 'file-upload'),
    download: requiredElement(root, 'file-download'),
    mkdir: requiredElement(root, 'file-mkdir'),
    rename: requiredElement(root, 'file-rename'),
    delete: requiredElement(root, 'file-delete'),
    newFile: root.querySelector<HTMLButtonElement>('#file-new-file'),
    breadcrumbs: root.querySelector<HTMLElement>('#file-breadcrumbs'),
    pathToggle: root.querySelector<HTMLButtonElement>('#file-path-edit-toggle'),
    toggleHidden: root.querySelector<HTMLButtonElement>('#file-toggle-hidden'),
    uploadInput: requiredElement(root, 'file-upload-input'),
    tableBody: requiredElement(root, 'file-table-body'),
    loading: requiredElement(root, 'file-manager-loading'),
    empty: requiredElement(root, 'file-manager-empty'),
    error: requiredElement(root, 'file-manager-error'),
    status: requiredElement(root, 'file-manager-status'),
    progress: requiredElement(root, 'file-manager-progress'),
    progressLabel: requiredElement(root, 'file-manager-progress-label'),
    progressBar: requiredElement(root, 'file-manager-progress-bar'),
    progressCancel: requiredElement(root, 'file-manager-progress-cancel'),
    treeToggle: root.querySelector<HTMLButtonElement>('#file-tree-toggle'),
    filterBar: root.querySelector<HTMLElement>('#file-filter-bar'),
    filterInput: root.querySelector<HTMLInputElement>('#file-filter'),
    filterToggle: root.querySelector<HTMLButtonElement>('#file-filter-toggle'),
    filterClear: root.querySelector<HTMLButtonElement>('#file-filter-clear'),
    filterCount: root.querySelector<HTMLElement>('#file-filter-count'),
    sortKeySelect: root.querySelector<HTMLSelectElement>('#file-sort-key'),
    sortDirButton: root.querySelector<HTMLButtonElement>('#file-sort-dir'),
    previewDialog: root.querySelector<HTMLDialogElement>('#file-preview-dialog'),
    previewTitle: root.querySelector<HTMLElement>('#file-preview-title'),
    previewImage: root.querySelector<HTMLImageElement>('#file-preview-image'),
    previewText: root.querySelector<HTMLElement>('#file-preview-text'),
    previewClose: root.querySelector<HTMLButtonElement>('#file-preview-close'),
    previewDismiss: root.querySelector<HTMLButtonElement>('#file-preview-dismiss'),
    previewDownload: root.querySelector<HTMLButtonElement>('#file-preview-download'),
    propertiesDialog: root.querySelector<HTMLDialogElement>('#file-properties-dialog'),
    propertiesTitle: root.querySelector<HTMLElement>('#file-properties-title'),
    propertiesList: root.querySelector<HTMLElement>('#file-properties-list'),
    propertiesClose: root.querySelector<HTMLButtonElement>('#file-properties-close'),
    propertiesDismiss: root.querySelector<HTMLButtonElement>('#file-properties-dismiss'),
    sheet: root.querySelector<HTMLElement>('#file-action-sheet'),
    sheetTitle: root.querySelector<HTMLElement>('#file-action-sheet-title'),
    sheetSubtitle: root.querySelector<HTMLElement>('#file-action-sheet-subtitle'),
    sheetClose: root.querySelector<HTMLButtonElement>('#file-action-sheet-close'),
    sheetActions: root.querySelector<HTMLElement>('.file-action-sheet-grid'),
    editorDialog: root.querySelector<HTMLDialogElement>('#file-editor-dialog'),
    editorTitle: root.querySelector<HTMLElement>('#file-editor-title'),
    editorPath: root.querySelector<HTMLElement>('#file-editor-path'),
    editorArea: root.querySelector<HTMLTextAreaElement>('#file-editor-area'),
    editorStatus: root.querySelector<HTMLElement>('#file-editor-status'),
    editorSave: root.querySelector<HTMLButtonElement>('#file-editor-save'),
    editorClose: root.querySelector<HTMLButtonElement>('#file-editor-close'),
    editorDismiss: root.querySelector<HTMLButtonElement>('#file-editor-dismiss'),
    editorCancel: root.querySelector<HTMLButtonElement>('#file-editor-cancel'),
  };
}

function normalizePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || new TextEncoder().encode(input).length > 4096) throw new Error('Invalid path');
  if (!input.startsWith('/') || /[\0-\x1f\x7f]/.test(input)) throw new Error('Invalid path');
  return input;
}

function validateName(input: string): string {
  const name = input;
  if (!name || name === '.' || name === '..' || name.length > 255 || name.includes('/') || /[\0-\x1f\x7f]/.test(name)) {
    throw new Error('Invalid file name');
  }
  return name;
}

function joinPath(parent: string, name: string): string {
  return normalizePath(`${parent.endsWith('/') ? parent : `${parent}/`}${validateName(name)}`);
}

function parentPath(path: string): string {
  let normalized = normalizePath(path);
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized === '/') return '/';
  return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fileSizeValue(value: unknown): number | string | null {
  const numeric = numberValue(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return value.replace(/^0+(?=\d)/, '');
}

function sizeExceedsLimit(value: number | string): boolean {
  if (typeof value === 'number') return value > MAX_SFTP_FILE_SIZE;
  const limit = String(MAX_SFTP_FILE_SIZE);
  return value.length > limit.length || (value.length === limit.length && value > limit);
}

function transferSize(value: unknown): number | null {
  const size = fileSizeValue(value);
  if (size === null || sizeExceedsLimit(size)) return null;
  return typeof size === 'number' ? size : Number(size);
}

export class FileManager {
  private readonly elements: FileManagerElements;
  private readonly getLanguage: () => string;
  private readonly confirmAction: NonNullable<FileManagerOptions['confirm']>;
  private readonly promptAction: NonNullable<FileManagerOptions['prompt']>;
  private readonly onError?: FileManagerOptions['onError'];
  private readonly onStatus?: FileManagerOptions['onStatus'];
  private readonly bindings = new AbortController();

  private socket: WebSocket | null = null;
  private generation = 0;
  private requestSequence = 0;
  private ready = false;
  private cwd = '/';
  private homePath = '/';
  private history = ['/'];
  private historyIndex = 0;
  private entries: SFTPEntry[] = [];
  private selectedIndex = -1;
  private listView: FileListView | null = null;
  private pending = new Map<string, PendingRequest>();
  private activeListRequest: string | null = null;
  private uploadState: UploadState | null = null;
  private downloadState: DownloadState | null = null;
  private uploadConfirmationPending = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private statusCopy: LocalizedText = DISCONNECTED;
  /** Auto-reconnect state: true while the SSH session is alive and we want a file channel. */
  private wantConnection = false;
  /** Last attach URL, saved for reconnection. */
  private url: string | null = null;
  /** Pending reconnect timer id, null when idle. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current reconnect attempt count (0 = no attempt). */
  private reconnectAttempts = 0;
  private reconnectGaveUp = false;
  /** Pending tree-view directory fetch promises, keyed by `tree-` prefixed requestId. */
  private treeLists = new Map<string, {
    resolve: (value: { path: string; entries: SFTPEntry[]; isTruncated: boolean }) => void;
    reject: (error: Error) => void;
    generation: number;
  }>();
  /** Registered cwd-change listeners, notified on every successful cwd mutation. */
  private cwdListeners = new Set<CwdChangeListener>();
  /** Element to focus when the action sheet closes. */
  private sheetReturnFocus: HTMLElement | null = null;
  /** Touch long-press bookkeeping for the native table. */
  private longPress: { timer: number; x: number; y: number; row: HTMLTableRowElement } | null = null;
  /** Raw listing of the current directory; `entries` is the filtered+sorted view. */
  private sourceEntries: SFTPEntry[] = [];
  private sortKey: FileSortKey = 'name';
  private sortAscending = true;
  private filterText = '';
  private showHiddenFiles = true;
  /** Files waiting for the single SFTP upload slot. */
  private uploadQueue: File[] = [];
  private queuePumping = false;
  private dragDepth = 0;
  private previewUrl: string | null = null;

  /** 当前编辑器会话；null 表示编辑器关闭。 */
  private editorState: { path: string; name: string; dirty: boolean; saving: boolean } | null = null;
  /** 单次下载的原始文本；编辑保存按字节原样回传，避免编辑器改动行尾。 */
  private editorText = '';
  private readonly getEditorLanguage: () => boolean;

  constructor(options: FileManagerOptions) {
    this.elements = options.elements;
    this.getLanguage = options.getLanguage ?? (() => document.documentElement.lang || 'zh-CN');
    this.getEditorLanguage = options.canEdit ?? (() => true);
    this.confirmAction = options.confirm ?? ((message) => window.confirm(message));
    this.promptAction = options.prompt ?? ((message, value) => window.prompt(message, value));
    this.onError = options.onError;
    this.onStatus = options.onStatus;
    this.bindControls();
    this.loadSortPreference();
    this.syncSortControls();
    this.renderDisconnected();
    // 移动端切后台（文件选择器等）会冻结重连计时器并可能耗尽重试额度；
    // 回前台时若仍想要连接则立即恢复重连。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.wantConnection) return;
      if (this.isSocketOpen()) return;
      if (this.reconnectGaveUp) {
        this.reconnectGaveUp = false;
        this.reconnectAttempts = 0;
        this.scheduleReconnect();
        return;
      }
      if (this.reconnectTimer !== null) {
        this.clearReconnectTimer();
        this.scheduleReconnect();
      }
    });
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
        throw new Error('SFTP WebSocket must use the current origin');
      }
      target.hash = '';
    } catch (error) {
      this.showError(this.localize({ zh: '文件传输地址无效。', en: 'The file transfer address is invalid.' }));
      throw error;
    }

    const generation = this.generation;
    const socket = new WebSocket(target);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setStatus({ zh: '正在连接文件服务…', en: 'Connecting to file service…' });

    socket.addEventListener('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      if (this.reconnectAttempts > 0) {
        console.log(
          `[WS-Reconnect] ${new Date().toISOString()} | SFTP | reconnect_success | attempt=${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}`,
        );
      }
      this.reconnectAttempts = 0;
      this.init();
    });
    socket.addEventListener('message', (event: MessageEvent<SocketData>) => {
      this.messageQueue = this.messageQueue
        .then(() => this.handleSocketData(event.data, generation))
        .catch((error: unknown) => this.showError(error instanceof Error ? error.message : String(error)));
    });
    socket.addEventListener('error', () => {
      if (this.isCurrent(socket, generation)) {
        this.showError(this.localize({ zh: '文件服务连接失败。', en: 'The file service connection failed.' }));
      }
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (!this.isCurrent(socket, generation)) return;
      console.log(
        `[WS-Reconnect] ${new Date().toISOString()} | SFTP | disconnect | code=${event.code} | reason="${event.reason}"`,
      );
      this.socket = null;
      this.ready = false;
      this.abortTransfers(false);
      this.pending.clear();
      this.activeListRequest = null;
      this.rejectTreeLists(new Error('SFTP connection closed'));
      if (event.code !== 1000 && event.code !== 1005) {
        // Unexpected drop. Auto-reconnect unless the user intentionally tore the session down.
        if (this.wantConnection) {
          this.scheduleReconnect();
        } else {
          this.renderDisconnected(true, this.describeClose(event));
        }
      } else {
        this.renderDisconnected(true, this.describeClose(event));
      }
    });
  }

  init(): void {
    if (!this.isSocketOpen()) return;
    this.send({ type: 'sftp_init' });
    this.setStatus({ zh: '正在初始化 SFTP…', en: 'Initializing SFTP…' });
  }

  reset(): void {
    this.wantConnection = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.reconnectGaveUp = false;
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.uploadConfirmationPending = false;
    this.pending.clear();
    this.activeListRequest = null;
    this.rejectTreeLists(new Error('SFTP session reset'));
    this.abortTransfers(false);
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'sftp_close' })); } catch { /* Socket is already unusable. */ }
      }
      if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'SFTP client reset');
    }
    this.cwd = '/';
    this.homePath = '/';
    this.history = ['/'];
    this.historyIndex = 0;
    this.entries = [];
    this.selectedIndex = -1;
    this.renderDisconnected();
  }

  destroy(): void {
    this.reset();
    this.cwdListeners.clear();
    this.bindings.abort();
  }

  list(path = this.cwd): string | null {
    return this.requestList(path, 'push');
  }

  navigate(path: string): void {
    try {
      this.requestList(normalizePath(path), 'push');
    } catch {
      this.showError(this.localize({ zh: '请输入有效的绝对路径。', en: 'Enter a valid absolute path.' }));
    }
  }

  back(): void {
    if (!this.ready || this.historyIndex <= 0) return;
    this.requestList(this.history[this.historyIndex - 1], 'index', this.historyIndex - 1);
  }

  up(): void {
    if (this.ready) this.requestList(parentPath(this.cwd), 'push');
  }

  home(): void {
    if (this.ready) this.requestList(this.homePath, 'push');
  }

  refresh(): void {
    if (this.ready) this.requestList(this.cwd, 'none');
  }

  setLanguage(): void {
    this.updateStatusText(this.statusCopy);
    this.renderEntries();
    this.updateProgressLanguage();
    this.updateDropHint();
    this.syncSortControls();
    this.updateFilterCount();
  }

  private updateDropHint(): void {
    this.elements.panel.dataset.dropHint = this.localize({
      zh: '松手即上传到当前目录',
      en: 'Drop to upload into this folder',
    });
  }

  setListView(view: FileListView | null): void {
    this.listView = view;
    this.renderEntries();
  }

  selectEntry(index: number): void {
    this.selectedIndex = this.entries[index] ? index : -1;
    this.updateControls();
  }

  activateIndex(index: number): void {
    this.selectEntry(index);
    this.activateEntry(this.selectedEntry());
  }

  /** Open the per-entry action sheet (used by the Arborist list and long-press). */
  openMenu(index: number): void {
    this.openActionSheet(index);
  }

  openActionSheet(index: number): void {
    const entry = this.entries[index];
    const sheet = this.elements.sheet;
    if (!entry || !sheet) return;
    this.sheetReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.selectedIndex = index;
    for (const row of this.elements.tableBody.rows) {
      const rowIndex = Number(row.dataset.index);
      const selected = rowIndex === index;
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = selected ? 0 : -1;
    }
    if (this.elements.sheetTitle) this.elements.sheetTitle.textContent = entry.name;
    if (this.elements.sheetSubtitle) {
      this.elements.sheetSubtitle.textContent = entry.type === 'directory'
        ? this.localize({ zh: '文件夹', en: 'Folder' })
        : `${this.localize(this.typeLabel(entry.type))} · ${this.formatSize(entry.size)}`;
    }
    sheet.hidden = false;
    this.updateControls();
    requestAnimationFrame(() => {
      this.elements.sheetActions
        ?.querySelector<HTMLButtonElement>('[data-file-sheet]:not(:disabled)')
        ?.focus();
    });
  }

  closeActionSheet(restoreFocus = true): void {
    const sheet = this.elements.sheet;
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    if (restoreFocus) this.sheetReturnFocus?.focus();
    this.sheetReturnFocus = null;
  }

  // ── View: filter + sort (no refetch) ────────────────────────────────

  private loadSortPreference(): void {
    try {
      const raw = localStorage.getItem(SORT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { key?: unknown; ascending?: unknown };
      if (isFileSortKey(parsed.key)) this.sortKey = parsed.key;
      if (typeof parsed.ascending === 'boolean') this.sortAscending = parsed.ascending;
    } catch { /* A broken preference falls back to the default ordering. */ }
  }

  private saveSortPreference(): void {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ key: this.sortKey, ascending: this.sortAscending }));
    } catch { /* Storage may be unavailable. */ }
  }

  private syncSortControls(): void {
    if (this.elements.sortKeySelect) this.elements.sortKeySelect.value = this.sortKey;
    if (!this.elements.sortDirButton) return;
    this.elements.sortDirButton.textContent = this.sortAscending ? '\u2191' : '\u2193';
    this.elements.sortDirButton.setAttribute('aria-label', this.localize(this.sortAscending
      ? { zh: '当前升序，点击改为降序', en: 'Ascending order; activate for descending' }
      : { zh: '当前降序，点击改为升序', en: 'Descending order; activate for ascending' }));
  }

  /** Apply the filter and sort to the cached listing and repaint both views. */
  private applyView(): void {
    const query = this.filterText.trim().toLocaleLowerCase();
    let filtered = query
      ? this.sourceEntries.filter((entry) => entry.name.toLocaleLowerCase().includes(query))
      : this.sourceEntries;
    if (!this.showHiddenFiles) {
      filtered = filtered.filter((entry) => !entry.name.startsWith('.'));
    }
    const direction = this.sortAscending ? 1 : -1;
    const key = this.sortKey;
    const collation = this.isChinese() ? 'zh-CN' : 'en';
    this.entries = [...filtered].sort((left, right) => {
      // Directories stay on top in name order for every sort key, like the previous behaviour.
      const leftIsDir = left.type === 'directory';
      if (leftIsDir !== (right.type === 'directory')) return leftIsDir ? -1 : 1;
      if (leftIsDir) return left.name.localeCompare(right.name, collation, { numeric: true, sensitivity: 'base' });
      let result = 0;
      if (key === 'size') result = Number(left.size) - Number(right.size);
      else if (key === 'mtime') result = Number(left.mtime) - Number(right.mtime);
      else if (key === 'type') result = left.type.localeCompare(right.type);
      else if (key === 'owner') result = String(left.owner ?? left.uid ?? '').localeCompare(String(right.owner ?? right.uid ?? ''), undefined, { numeric: true });
      if (result === 0) result = left.name.localeCompare(right.name, collation, { numeric: true, sensitivity: 'base' });
      return result * direction;
    });
    this.selectedIndex = -1;
    this.elements.empty.hidden = this.entries.length !== 0;
    this.updateFilterCount();
    this.renderEntries();
    this.updateControls();
  }

  private updateFilterCount(): void {
    if (this.elements.filterCount) {
      const total = this.sourceEntries.length;
      const shown = this.entries.length;
      this.elements.filterCount.textContent = this.filterText.trim() && total > 0
        ? `${shown} / ${total}`
        : total > 0 ? String(total) : '';
    }
    if (this.elements.filterClear) this.elements.filterClear.hidden = !this.filterText;
  }

  private revokePreviewUrl(): void {
    if (!this.previewUrl) return;
    URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  private async showPreview(name: string, blob: Blob): Promise<void> {
    const dialog = this.elements.previewDialog;
    if (!dialog) return;
    if (this.elements.previewTitle) this.elements.previewTitle.textContent = name;
    this.revokePreviewUrl();
    const image = this.elements.previewImage;
    const text = this.elements.previewText;
    if (fileKind({ name, type: 'file' }) === 'image' && image) {
      this.previewUrl = URL.createObjectURL(blob);
      image.src = this.previewUrl;
      image.alt = name;
      image.hidden = false;
      if (text) text.hidden = true;
    } else if (text) {
      if (image) image.hidden = true;
      const buffer = await blob.arrayBuffer();
      const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192));
      text.textContent = head.includes(0)
        ? this.localize({ zh: '二进制文件，无法以文本预览。', en: 'Binary file: cannot preview as text.' })
        : new TextDecoder('utf-8').decode(buffer);
      text.hidden = false;
    }
    if (!dialog.open) dialog.showModal();
  }

  private describeSize(size: number | string): string {
    const formatted = this.formatSize(size);
    const raw = `${size} B`;
    return formatted === raw ? formatted : `${formatted} (${raw})`;
  }

  private showProperties(entry: SFTPEntry): void {
    const dialog = this.elements.propertiesDialog;
    const list = this.elements.propertiesList;
    if (!dialog || !list) return;
    if (this.elements.propertiesTitle) this.elements.propertiesTitle.textContent = entry.name;
    const rows: Array<[string, string]> = [
      [this.localize({ zh: '名称', en: 'Name' }), entry.name],
      [this.localize({ zh: '路径', en: 'Path' }), joinPath(this.cwd, entry.name)],
      [this.localize({ zh: '类型', en: 'Type' }), this.localize(this.typeLabel(entry.type))],
      [this.localize({ zh: '大小', en: 'Size' }), entry.type === 'directory' ? '\u2014' : this.describeSize(entry.size)],
      [this.localize({ zh: '修改时间', en: 'Modified' }), this.formatDate(entry.mtime)],
      [this.localize({ zh: '权限', en: 'Permissions' }), String(entry.permissions || '\u2014')],
      [this.localize({ zh: '用户', en: 'Owner' }), String(entry.owner ?? entry.uid ?? '\u2014')],
      [this.localize({ zh: '组', en: 'Group' }), String(entry.group ?? entry.gid ?? '\u2014')],
    ];
    list.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      row.append(term, detail);
      return row;
    }));
    if (!dialog.open) dialog.showModal();
  }

  private handleSheetAction(action: string): void {
    const entry = this.selectedEntry();
    this.closeActionSheet(false);
    switch (action) {
      case 'open': this.activateEntry(entry); break;
      case 'download': this.downloadSelected(); break;
      case 'preview': this.previewSelected(); break;
      case 'edit': if (entry) this.editPath(joinPath(this.cwd, entry.name)); break;
      case 'properties': if (entry) this.showProperties(entry); break;
      case 'rename': void this.renameSelected(); break;
      case 'delete': void this.deleteSelected(); break;
      case 'new-folder': void this.createDirectory(); break;
      case 'upload': this.elements.uploadInput.click(); break;
      case 'refresh': this.refresh(); break;
    }
  }

  private updateSheetControls(): void {
    const actions = this.elements.sheetActions;
    if (!actions) return;
    const selected = this.selectedEntry();
    const idle = this.ready && !this.hasTransfer() && !this.uploadConfirmationPending;
    for (const button of actions.querySelectorAll<HTMLButtonElement>('[data-file-sheet]')) {
      const action = button.dataset.fileSheet;
      if (action === 'open') button.disabled = !selected;
      else if (action === 'download') button.disabled = !idle || !selected || selected.type !== 'file' || sizeExceedsLimit(selected.size);
      else if (action === 'preview') button.disabled = !idle || !selected || selected.type !== 'file' || !PREVIEWABLE_KINDS.has(fileKind(selected));
      else if (action === 'rename' || action === 'delete') button.disabled = !idle || !selected;
      else if (action === 'edit') button.disabled = !idle || !selected || !isEditableText(selected)
        || sizeExceedsLimit(selected.size) || !this.getEditorLanguage();
      else button.disabled = !idle;
    }
  }

  /**
   * Fetch directory entries for the tree view **without** disturbing the
   * right-side panel (cwd, history, activeListRequest, or rendered entries).
   * Uses a `tree-` prefixed requestId so handleListResult / handleServerError
   * route the response to the tree channel instead of the normal list flow.
   */
  fetchDirectoryEntries(path: string): Promise<{ path: string; entries: SFTPEntry[]; isTruncated: boolean }> {
    if (!this.ready || !this.isSocketOpen()) {
      return Promise.reject(new Error(this.localize({ zh: 'SFTP 尚未就绪。', en: 'SFTP is not ready.' })));
    }
    let normalized: string;
    try {
      normalized = normalizePath(path);
    } catch {
      return Promise.reject(new Error(this.localize({ zh: '路径无效。', en: 'Invalid path.' })));
    }
    const requestId = `tree-${this.generation}-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      this.treeLists.set(requestId, { resolve, reject, generation: this.generation });
      this.send({ type: 'sftp_list', requestId, path: normalized });
    });
  }

  /**
   * Register a listener that fires whenever the current working directory
   * changes (after a successful list navigation or sftp_ready). Returns an
   * unsubscribe function.
   */
  onCwdChange(listener: CwdChangeListener): () => void {
    this.cwdListeners.add(listener);
    return () => { this.cwdListeners.delete(listener); };
  }

  /** Queue a single file. Kept for callers that upload one file at a time. */
  upload(file: File, destination?: string): Promise<void> {
    return this.uploadFiles([file], destination);
  }

  /**
   * Queue files for upload. The SFTP channel supports one upload at a time, so
   * the queue drains sequentially and each file reports its own progress.
   */
  async uploadFiles(files: Iterable<File>, destination?: string, overwrite = false): Promise<void> {
    if (!this.ready) {
      this.showError(this.localize({ zh: 'SFTP 尚未就绪。', en: 'SFTP is not ready.' }));
      return;
    }
    const accepted: File[] = [];
    let oversized = 0;
    for (const file of files) {
      if (file.size > MAX_SFTP_FILE_SIZE) oversized++;
      else accepted.push(file);
    }
    if (oversized > 0) {
      this.showError(this.localize({
        zh: `已跳过 ${oversized} 个超过 64 MiB 的文件。`,
        en: `Skipped ${oversized} file${oversized === 1 ? '' : 's'} over 64 MiB.`,
      }));
    }
    if (accepted.length === 0) return;
    this.uploadQueue.push(...accepted);
    if (accepted.length > 1) {
      this.setStatus({
        zh: `已加入 ${accepted.length} 个文件，正在排队上传…`,
        en: `Queued ${accepted.length} files for upload…`,
      });
    }
    await this.pumpUploadQueue(destination, overwrite);
  }

  private async pumpUploadQueue(destination?: string, overwrite = false): Promise<void> {
    if (this.queuePumping) return;
    this.queuePumping = true;
    try {
      while (this.uploadQueue.length > 0) {
        if (!this.ready || !this.isSocketOpen()) {
          this.clearUploadQueue();
          return;
        }
        if (this.hasTransfer() || this.uploadConfirmationPending) return;
        const file = this.uploadQueue.shift()!;
        await this.startUpload(file, destination, overwrite);
        // The completion/cancel/error handlers call pump again once the slot frees.
        if (this.uploadState) return;
      }
    } finally {
      this.queuePumping = false;
    }
  }

  private clearUploadQueue(): void {
    if (this.uploadQueue.length === 0) return;
    this.uploadQueue = [];
    this.updateControls();
  }

  private async startUpload(file: File, destination?: string, forceOverwrite = false): Promise<void> {
    if (!this.ready || this.hasTransfer() || this.uploadConfirmationPending) return;
    if (file.size > MAX_SFTP_FILE_SIZE) {
      this.showError(this.localize({ zh: '文件不能超过 64 MiB。', en: 'Files cannot exceed 64 MiB.' }));
      return;
    }
    let path: string;
    try { path = normalizePath(destination ?? joinPath(this.cwd, file.name)); } catch {
      this.showError(this.localize({ zh: '上传文件名无效。', en: 'The upload file name is invalid.' }));
      return;
    }
    const existing = this.entries.find((entry) => joinPath(this.cwd, entry.name) === path);
    const generation = this.generation;
    let overwrite = forceOverwrite;
    if (existing && !forceOverwrite) {
      this.uploadConfirmationPending = true;
      this.updateControls();
      try {
        overwrite = await this.confirmAction(this.localize({
          zh: `“${existing.name}”已存在。是否覆盖？此操作无法撤销。`,
          en: `“${existing.name}” already exists. Overwrite it? This cannot be undone.`,
        }));
      } catch {
        if (generation === this.generation) {
          this.showError(this.localize({ zh: '无法确认是否覆盖文件。', en: 'Could not confirm whether to overwrite the file.' }));
        }
        return;
      } finally {
        if (generation === this.generation) {
          this.uploadConfirmationPending = false;
          this.updateControls();
        }
      }
      if (!overwrite) return;
    }
    if (generation !== this.generation || !this.ready || this.hasTransfer() || !this.isSocketOpen()) return;
    const requestId = this.createRequest('upload', path);
    this.uploadState = {
      generation: this.generation,
      requestId,
      file,
      path,
      sent: 0,
      acknowledged: 0,
      awaitingAck: false,
      endSent: false,
      readyForData: false,
      cancelling: false,
      cancelSent: false,
    };
    this.showProgress('upload', file.name, 0);
    this.send({ type: 'sftp_upload_start', requestId, path, size: file.size, overwrite });
    this.updateControls();
  }

  downloadSelected(): void {
    const entry = this.selectedEntry();
    if (entry) this.startDownload(entry, false);
  }

  /** Public path-based action used by alternative file-manager views. */
  downloadPath(path: string): void {
    const normalized = normalizePath(path);
    const name = normalized.split('/').filter(Boolean).pop() || 'download';
    const entry = this.sourceEntries.find((item) => joinPath(this.cwd, item.name) === normalized)
      ?? { name, type: 'file' as const, size: '', mtime: '', permissions: '' };
    this.startDownload(entry, false, normalized);
  }

  previewPath(path: string): void {
    const normalized = normalizePath(path);
    const name = normalized.split('/').filter(Boolean).pop() || 'file';
    const entry = this.sourceEntries.find((item) => joinPath(this.cwd, item.name) === normalized)
      ?? { name, type: 'file' as const, size: '', mtime: '', permissions: '' };
    if (!PREVIEWABLE_KINDS.has(fileKind(entry))) {
      this.downloadPath(normalized);
      return;
    }
    this.startDownload(entry, true, normalized);
  }

  // ── Text editor ──────────────────────────────────────────────────

  /** 打开文本编辑器读取 `path`；非白名单类型直接退回下载。 */
  editPath(path: string): void {
    const normalized = normalizePath(path);
    const name = normalized.split('/').filter(Boolean).pop() || 'file';
    const entry = this.sourceEntries.find((item) => joinPath(this.cwd, item.name) === normalized)
      ?? { name, type: 'file' as const, size: '', mtime: '', permissions: '' };
    if (!isEditableText(entry)) {
      this.downloadPath(normalized);
      return;
    }
    const size = transferSize(entry.size);
    if (size !== null && size > MAX_EDIT_TEXT_SIZE) {
      this.showError(this.localize({
        zh: '文件超过 2 MiB，无法在线编辑，请下载后修改。',
        en: 'Files over 2 MiB cannot be edited online; download it instead.',
      }));
      return;
    }
    this.openEditor(normalized, name);
  }

  private openEditor(path: string, name: string, isNew = false): void {
    const dialog = this.elements.editorDialog;
    const area = this.elements.editorArea;
    if (!dialog || !area) return;
    this.editorState = { path, name, dirty: isNew, saving: false };
    this.editorText = '';
    if (this.elements.editorTitle) this.elements.editorTitle.textContent = name;
    if (this.elements.editorPath) this.elements.editorPath.textContent = path;
    area.value = '';
    if (isNew) {
      area.readOnly = false;
      this.setEditorStatus({ zh: '新文件，输入内容后保存', en: 'New file; enter content and save' });
      this.updateEditorControls();
      if (!dialog.open) dialog.showModal();
      area.focus();
      return;
    }
    area.readOnly = true;
    this.setEditorStatus({ zh: '正在读取文件…', en: 'Loading file…' });
    this.updateEditorControls();
    if (!dialog.open) dialog.showModal();
    // 走下载通道复用进度与取消逻辑，只是把结果转成文本而不是存盘。
    this.startDownload({ name, type: 'file', size: '', mtime: '', permissions: '' }, true, path);
  }

  private setEditorStatus(copy: LocalizedText): void {
    const status = this.elements.editorStatus;
    if (!status) return;
    status.dataset.i18nZh = copy.zh;
    status.dataset.i18nEn = copy.en;
    status.textContent = this.localize(copy);
  }

  private updateEditorControls(): void {
    const state = this.editorState;
    const area = this.elements.editorArea;
    if (area) area.readOnly = !state || state.saving;
    if (this.elements.editorSave) {
      this.elements.editorSave.disabled = !state || state.saving || !state.dirty;
    }
    if (this.elements.editorCancel) {
      this.elements.editorCancel.hidden = !state?.dirty;
    }
  }

  private closeEditor(): void {
    const dialog = this.elements.editorDialog;
    this.editorState = null;
    this.editorText = '';
    dialog?.close();
  }

  private requestCloseEditor(): void {
    if (!this.editorState?.dirty) {
      this.closeEditor();
      return;
    }
    void this.confirmEditorClose();
  }

  private async confirmEditorClose(): Promise<void> {
    try {
      const confirmed = await this.confirmAction(this.localize({
        zh: '当前文件有未保存的修改，确定要放弃吗？',
        en: 'There are unsaved changes. Discard them?',
      }));
      if (confirmed) this.closeEditor();
    } catch { /* 确认框被关闭时保留编辑器。 */ }
  }

  /** 用下载通道读到的内容填充编辑器。 */
  private fillEditor(name: string, blob: Blob): void {
    const state = this.editorState;
    const area = this.elements.editorArea;
    if (!state || !area) return;
    if (state.name !== name) return;
    void blob.text().then((text) => {
      if (this.editorState !== state) return;
      // 0x00 说明是二进制，编辑器会毁掉内容，直接拒绝而不是猜。
      if (text.includes('\0')) {
        this.closeEditor();
        this.showError(this.localize({ zh: '该文件包含二进制内容，无法编辑。', en: 'This file contains binary data and cannot be edited.' }));
        return;
      }
      this.editorText = text;
      area.value = text;
      area.readOnly = false;
      this.setEditorStatus({ zh: '已读取，可以编辑', en: 'Loaded; ready to edit' });
      this.updateEditorControls();
      area.focus();
    }).catch(() => {
      this.closeEditor();
      this.showError(this.localize({ zh: '文件读取失败。', en: 'Failed to read the file.' }));
    });
  }

  private async saveEditor(): Promise<void> {
    const state = this.editorState;
    const area = this.elements.editorArea;
    if (!state || !area || state.saving) return;
    if (!this.ready || !this.isSocketOpen()) {
      this.setEditorStatus({ zh: 'SFTP 尚未就绪，无法保存。', en: 'SFTP is not ready; cannot save.' });
      return;
    }
    state.saving = true;
    this.setEditorStatus({ zh: '正在保存…', en: 'Saving…' });
    this.updateEditorControls();
    try {
      // 用编辑器当前文本覆盖远端文件：先写临时文件再改名，失败不影响原文件。
      const file = new File([area.value], state.name, { type: 'text/plain' });
      await this.uploadFiles([file], state.path, true);
      this.editorText = area.value;
      state.dirty = false;
      this.setEditorStatus({ zh: '已保存', en: 'Saved' });
    } catch (error) {
      this.setEditorStatus({
        zh: `保存失败：${error instanceof Error ? error.message : String(error)}`,
        en: `Save failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      if (this.editorState === state) {
        state.saving = false;
        this.updateEditorControls();
      }
    }
  }

  /** 供外部查询：编辑器是否有未保存改动（离开页面前确认用）。 */
  hasUnsavedEditorChanges(): boolean {
    return Boolean(this.editorState?.dirty);
  }

  /** 供外部查询：编辑器是否打开（切视图时保留）。 */
  isEditorOpen(): boolean {
    return Boolean(this.elements.editorDialog?.open);
  }

  /** Promise-based operations for the SVAR file-manager adapter. */
  createDirectoryAt(parent: string, name: string): Promise<void> {
    const path = joinPath(normalizePath(parent), name);
    return this.requestMutation('mkdir', path, { type: 'sftp_mkdir', path });
  }

  renamePath(oldPath: string, newPath: string): Promise<void> {
    const oldNormalized = normalizePath(oldPath);
    const newNormalized = normalizePath(newPath);
    return this.requestMutation('rename', oldNormalized, {
      type: 'sftp_rename', oldPath: oldNormalized, newPath: newNormalized,
    });
  }

  async deletePath(path: string, directory = false): Promise<void> {
    const normalized = normalizePath(path);
    const operation = directory ? 'rmdir' : 'delete';
    await this.requestMutation(operation, normalized, {
      type: directory ? 'sftp_rmdir' : 'sftp_delete', path: normalized,
    });
  }

  private requestMutation(operation: string, path: string, message: JsonRecord): Promise<void> {
    if (!this.ready || !this.isSocketOpen()) {
      return Promise.reject(new Error(this.localize({ zh: 'SFTP 尚未就绪。', en: 'SFTP is not ready.' })));
    }
    const requestId = this.createRequest(operation, path, { suppressRefresh: true });
    return new Promise<void>((resolve, reject) => {
      const pending = this.pending.get(requestId);
      if (!pending) { reject(new Error('SFTP request could not be created')); return; }
      pending.resolve = resolve;
      pending.reject = reject;
      this.send({ ...message, requestId });
    });
  }

  /** Download a previewable file into the preview dialog instead of saving it. */
  previewSelected(): void {
    const entry = this.selectedEntry();
    if (!entry || entry.type !== 'file') return;
    if (!PREVIEWABLE_KINDS.has(fileKind(entry))) {
      this.showError(this.localize({ zh: '该文件类型暂不支持预览。', en: 'This file type cannot be previewed.' }));
      return;
    }
    this.startDownload(entry, true);
  }

  private startDownload(entry: SFTPEntry, preview: boolean, explicitPath?: string): void {
    if (!this.ready || entry.type !== 'file' || this.hasTransfer()) return;
    const limit = preview
      ? (fileKind(entry) === 'image' ? MAX_PREVIEW_IMAGE_SIZE : MAX_PREVIEW_TEXT_SIZE)
      : MAX_SFTP_FILE_SIZE;
    const size = transferSize(entry.size);
    if (size !== null && size > limit) {
      this.showError(preview
        ? this.localize({ zh: '文件过大，无法预览。', en: 'This file is too large to preview.' })
        : this.localize({ zh: '文件不能超过 64 MiB。', en: 'Files cannot exceed 64 MiB.' }));
      return;
    }
    const path = explicitPath ? normalizePath(explicitPath) : joinPath(this.cwd, entry.name);
    const requestId = this.createRequest('download', path);
    this.downloadState = {
      generation: this.generation,
      requestId,
      path,
      name: entry.name,
      expectedSize: size,
      received: 0,
      chunks: [],
      started: false,
      cancelling: false,
      cancelSent: false,
      preview,
    };
    this.showProgress('download', entry.name, 0);
    this.send({ type: 'sftp_download', requestId, path });
    this.updateControls();
  }

  cancelTransfer(): void {
    this.requestTransferCancel();
  }

  async handle(data: SocketData): Promise<void> {
    await this.handleSocketData(data, this.generation);
  }

  private bindControls(): void {
    const signal = this.bindings.signal;
    this.elements.path.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.navigate(this.elements.path.value);
    }, { signal });
    this.elements.path.addEventListener('focus', () => {
      this.togglePathInputMode(true);
    }, { signal });
    this.elements.back.addEventListener('click', () => this.back(), { signal });
    this.elements.up.addEventListener('click', () => this.up(), { signal });
    this.elements.home.addEventListener('click', () => this.home(), { signal });
    this.elements.refresh.addEventListener('click', () => this.refresh(), { signal });
    this.elements.upload.addEventListener('click', () => this.elements.uploadInput.click(), { signal });
    this.elements.newFile?.addEventListener('click', () => void this.createFile(), { signal });
    this.elements.pathToggle?.addEventListener('click', () => this.togglePathInputMode(), { signal });
    this.elements.toggleHidden?.addEventListener('click', () => this.toggleHiddenFiles(), { signal });
    this.elements.uploadInput.addEventListener('change', () => {
      const files = Array.from(this.elements.uploadInput.files ?? []);
      this.elements.uploadInput.value = '';
      if (files.length > 0) void this.uploadFiles(files);
    }, { signal });
    this.elements.download.addEventListener('click', () => this.downloadSelected(), { signal });
    this.elements.progressCancel.addEventListener('click', () => this.cancelTransfer(), { signal });
    this.elements.mkdir.addEventListener('click', () => void this.createDirectory(), { signal });
    this.elements.rename.addEventListener('click', () => void this.renameSelected(), { signal });
    this.elements.delete.addEventListener('click', () => void this.deleteSelected(), { signal });
    this.elements.sheetClose?.addEventListener('click', () => this.closeActionSheet(), { signal });
    this.elements.sheet?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.closeActionSheet();
    }, { signal });
    this.elements.sheet?.addEventListener('click', (event) => {
      // Clicking the dimmed backdrop dismisses without restoring focus.
      if (event.target === this.elements.sheet) this.closeActionSheet(false);
    }, { signal });
    this.elements.sheetActions?.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-file-sheet]')
        : null;
      if (!button || button.disabled) return;
      this.handleSheetAction(button.dataset.fileSheet ?? '');
    }, { signal });
    const closePreview = () => {
      this.revokePreviewUrl();
      this.elements.previewDialog?.close();
    };
    this.elements.previewClose?.addEventListener('click', closePreview, { signal });
    this.elements.previewDismiss?.addEventListener('click', closePreview, { signal });
    this.elements.previewDialog?.addEventListener('close', () => this.revokePreviewUrl(), { signal });
    this.elements.previewDownload?.addEventListener('click', () => {
      closePreview();
      this.downloadSelected();
    }, { signal });
    this.elements.propertiesClose?.addEventListener('click', () => this.elements.propertiesDialog?.close(), { signal });
    this.elements.propertiesDismiss?.addEventListener('click', () => this.elements.propertiesDialog?.close(), { signal });
    const editorArea = this.elements.editorArea;
    if (editorArea) {
      editorArea.addEventListener('input', () => {
        const state = this.editorState;
        if (!state || state.saving) return;
        state.dirty = editorArea.value !== this.editorText;
        this.updateEditorControls();
      }, { signal });
      // Ctrl/Cmd+S 保存，Esc 由 dialog 的 cancel 事件统一处理。
      editorArea.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void this.saveEditor();
        }
      }, { signal });
    }
    this.elements.editorSave?.addEventListener('click', () => void this.saveEditor(), { signal });
    this.elements.editorCancel?.addEventListener('click', () => {
      // 放弃改动：把编辑器内容还原成上次读到的文本。
      const area = this.elements.editorArea;
      const state = this.editorState;
      if (!area || !state) return;
      area.value = this.editorText;
      state.dirty = false;
      this.setEditorStatus({ zh: '已放弃修改', en: 'Changes discarded' });
      this.updateEditorControls();
    }, { signal });
    const editorCancel = () => this.requestCloseEditor();
    this.elements.editorClose?.addEventListener('click', editorCancel, { signal });
    this.elements.editorDismiss?.addEventListener('click', editorCancel, { signal });
    this.elements.editorDialog?.addEventListener('cancel', (event) => {
      // Esc 先走确认，直接 close 会让放弃确认变成默认行为。
      event.preventDefault();
      editorCancel();
    }, { signal });

    this.elements.tableBody.addEventListener('click', (event) => {
      const menu = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-file-menu]')
        : null;
      if (menu) {
        event.stopPropagation();
        const index = Number(menu.dataset.fileMenu);
        if (Number.isInteger(index)) this.openActionSheet(index);
        return;
      }
      const target = this.rowFromEvent(event);
      if (target) this.selectRow(target, true);
    }, { signal });
    this.elements.tableBody.addEventListener('contextmenu', (event) => {
      const target = this.rowFromEvent(event);
      if (!target) return;
      event.preventDefault();
      const index = Number(target.dataset.index);
      if (Number.isInteger(index)) this.openActionSheet(index);
    }, { signal });
    // Long-press opens the same sheet on touch devices. A small movement
    // threshold keeps vertical scrolling from being mistaken for a long press.
    const cancelLongPress = () => {
      if (!this.longPress) return;
      window.clearTimeout(this.longPress.timer);
      this.longPress = null;
    };
    this.elements.tableBody.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      const target = this.rowFromEvent(event);
      if (!target) return;
      cancelLongPress();
      const index = Number(target.dataset.index);
      this.longPress = {
        x: event.clientX,
        y: event.clientY,
        row: target,
        timer: window.setTimeout(() => {
          this.longPress = null;
          if (Number.isInteger(index)) this.openActionSheet(index);
        }, 480),
      };
    }, { signal });
    this.elements.tableBody.addEventListener('pointermove', (event) => {
      if (!this.longPress) return;
      if (Math.abs(event.clientX - this.longPress.x) > 8 || Math.abs(event.clientY - this.longPress.y) > 8) {
        cancelLongPress();
      }
    }, { signal });
    this.elements.tableBody.addEventListener('pointerup', cancelLongPress, { signal });
    this.elements.tableBody.addEventListener('pointercancel', cancelLongPress, { signal });
    this.elements.tableBody.addEventListener('scroll', cancelLongPress, { signal });

    this.elements.filterInput?.addEventListener('input', () => {
      this.filterText = this.elements.filterInput!.value;
      this.applyView();
    }, { signal });
    this.elements.filterInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.elements.filterInput!.value = '';
      this.filterText = '';
      this.applyView();
    }, { signal });
    this.elements.filterToggle?.addEventListener('click', () => {
      const bar = this.elements.filterBar;
      if (!bar) return;
      bar.hidden = !bar.hidden;
      this.elements.filterToggle!.setAttribute('aria-expanded', String(!bar.hidden));
      if (!bar.hidden) this.elements.filterInput?.focus();
    }, { signal });
    this.elements.filterClear?.addEventListener('click', () => {
      if (!this.elements.filterInput) return;
      this.elements.filterInput.value = '';
      this.filterText = '';
      this.applyView();
      this.elements.filterInput.focus();
    }, { signal });
    this.elements.sortKeySelect?.addEventListener('change', () => {
      const value = this.elements.sortKeySelect!.value;
      if (!isFileSortKey(value)) return;
      this.sortKey = value;
      this.saveSortPreference();
      this.syncSortControls();
      this.applyView();
    }, { signal });
    this.elements.sortDirButton?.addEventListener('click', () => {
      this.sortAscending = !this.sortAscending;
      this.saveSortPreference();
      this.syncSortControls();
      this.applyView();
    }, { signal });

    // Drag files from the desktop onto the panel to upload into the current directory.
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    this.elements.panel.addEventListener('dragenter', (event) => {
      if (!this.ready || !hasFiles(event)) return;
      event.preventDefault();
      this.dragDepth++;
      this.elements.panel.classList.add('is-drop-target');
    }, { signal });
    this.elements.panel.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    }, { signal });
    this.elements.panel.addEventListener('dragleave', () => {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.elements.panel.classList.remove('is-drop-target');
    }, { signal });
    this.elements.panel.addEventListener('drop', (event) => {
      event.preventDefault();
      this.dragDepth = 0;
      this.elements.panel.classList.remove('is-drop-target');
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void this.uploadFiles(files);
    }, { signal });
    this.updateDropHint();
    this.elements.tableBody.addEventListener('focusin', (event) => {
      const target = this.rowFromEvent(event);
      if (target) this.selectRow(target, false);
    }, { signal });
    this.elements.tableBody.addEventListener('dblclick', (event) => {
      const target = this.rowFromEvent(event);
      if (!target) return;
      const entry = this.selectRow(target, true);
      this.activateEntry(entry);
    }, { signal });
    this.elements.tableBody.addEventListener('keydown', (event) => {
      const target = this.rowFromEvent(event);
      if (!target) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.activateEntry(this.selectRow(target, false));
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = Number(target.dataset.index);
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? this.entries.length - 1
          : Math.max(0, Math.min(this.entries.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)));
      const nextRow = this.elements.tableBody.rows.item(next);
      if (nextRow) this.selectRow(nextRow, true);
    }, { signal });
  }

  private async handleSocketData(data: SocketData, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (typeof data !== 'string') {
      await this.handleBinary(data, generation);
      return;
    }
    let message: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) throw new Error('Invalid SFTP response');
      message = parsed;
    } catch {
      this.showError(this.localize({ zh: '文件服务返回了无效响应。', en: 'The file service returned an invalid response.' }));
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'pong') return;
    if (type === 'sftp_ready') {
      this.handleReady(message);
      return;
    }
    if (type === 'sftp_list_result') {
      this.handleListResult(message);
      return;
    }
    if (type === 'sftp_upload_ready') {
      await this.handleUploadReady(message);
      return;
    }
    if (type === 'sftp_upload_progress') {
      await this.handleUploadProgress(message);
      return;
    }
    if (type === 'sftp_upload_complete') {
      this.handleUploadComplete(message);
      return;
    }
    if (type === 'sftp_download_start') {
      this.handleDownloadStart(message);
      return;
    }
    if (type === 'sftp_download_progress') {
      this.handleDownloadProgress(message);
      return;
    }
    if (type === 'sftp_download_done') {
      this.handleDownloadDone(message);
      return;
    }
    if (type === 'sftp_upload_cancelled' || type === 'sftp_download_cancelled') {
      this.handleTransferCancelled(message, type === 'sftp_upload_cancelled' ? 'upload' : 'download');
      return;
    }
    if (type === 'sftp_error') {
      this.handleServerError(message);
      return;
    }
    if (type === 'sftp_closed') {
      this.socket?.close(1000, 'SFTP service closed');
      return;
    }
    if (type.endsWith('_result')) this.handleMutationResult(message);
  }

  private handleReady(message: JsonRecord): void {
    if (this.ready) return;
    let cwd: string;
    try { cwd = normalizePath(typeof message.cwd === 'string' ? message.cwd : '/'); } catch { cwd = '/'; }
    this.ready = true;
    this.cwd = cwd;
    this.emitCwdChange(cwd);
    this.homePath = cwd;
    this.history = [cwd];
    this.historyIndex = 0;
    this.elements.path.value = cwd;
    this.updateBreadcrumbs(cwd);
    this.updateControls();
    this.requestList(cwd, 'none');
  }

  private requestList(path: string, historyMode: PendingRequest['historyMode'], historyIndex?: number): string | null {
    if (!this.ready || !this.isSocketOpen()) return null;
    let normalized: string;
    try { normalized = normalizePath(path); } catch {
      this.showError(this.localize({ zh: '请输入有效的绝对路径。', en: 'Enter a valid absolute path.' }));
      return null;
    }
    if (this.activeListRequest) this.pending.delete(this.activeListRequest);
    const requestId = this.createRequest('list', normalized, { historyMode, historyIndex });
    this.activeListRequest = requestId;
    this.elements.loading.hidden = false;
    this.elements.empty.hidden = true;
    this.elements.error.hidden = true;
    this.setStatus({ zh: `正在读取 ${normalized}`, en: `Loading ${normalized}` });
    this.send({ type: 'sftp_list', requestId, path: normalized });
    return requestId;
  }

  private handleListResult(message: JsonRecord): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    // === Tree-view fetch: route to tree channel, never enter right-side rendering ===
    if (requestId.startsWith('tree-')) {
      this.resolveTreeList(message, requestId);
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending || pending.generation !== this.generation || pending.operation !== 'list') return;
    this.pending.delete(requestId);
    if (requestId !== this.activeListRequest) return;
    this.activeListRequest = null;
    let path: string;
    try { path = normalizePath(typeof message.path === 'string' ? message.path : pending.path); } catch {
      this.showError(this.localize({ zh: '文件服务返回了无效路径。', en: 'The file service returned an invalid path.' }));
      return;
    }
    if (!Array.isArray(message.entries)) {
      this.showError(this.localize({ zh: '文件服务返回了无效目录列表。', en: 'The file service returned an invalid directory listing.' }));
      return;
    }
    const entries = message.entries.map((entry) => this.parseEntry(entry)).filter((entry): entry is SFTPEntry => entry !== null);
    entries.sort((left, right) => {
      if (left.type === 'directory' && right.type !== 'directory') return -1;
      if (left.type !== 'directory' && right.type === 'directory') return 1;
      return left.name.localeCompare(right.name, this.isChinese() ? 'zh-CN' : 'en', { numeric: true, sensitivity: 'base' });
    });
    this.cwd = path;
    this.emitCwdChange(path);
    if (pending.historyMode === 'push' && this.history[this.historyIndex] !== path) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(path);
      this.historyIndex = this.history.length - 1;
    } else if (pending.historyMode === 'index' && pending.historyIndex !== undefined) {
      this.historyIndex = pending.historyIndex;
    }
    this.sourceEntries = entries;
    this.selectedIndex = -1;
    this.closeActionSheet(false);
    this.elements.path.value = path;
    this.updateBreadcrumbs(path);
    this.togglePathInputMode(false);
    this.elements.loading.hidden = true;
    this.elements.error.hidden = true;
    this.applyView();
    const truncated = message.isTruncated === true;
    this.setStatus({
      zh: `${entries.length} 个项目${truncated ? '（列表已截断）' : ''}`,
      en: `${entries.length} item${entries.length === 1 ? '' : 's'}${truncated ? ' (list truncated)' : ''}`,
    });
  }

  private parseEntry(value: unknown): SFTPEntry | null {
    if (!isRecord(value) || typeof value.name !== 'string') return null;
    let name: string;
    try { name = validateName(value.name); } catch { return null; }
    const rawType = typeof value.type === 'string' ? value.type.toLowerCase() : 'other';
    const type: SFTPEntry['type'] = rawType === 'dir' || rawType === 'directory'
      ? 'directory'
      : rawType === 'file' || rawType === 'regular'
        ? 'file'
        : rawType === 'link' || rawType === 'symlink'
          ? 'symlink'
          : 'other';
    return {
      name,
      type,
      size: fileSizeValue(value.size) ?? 0,
      mtime: typeof value.mtime === 'string' || typeof value.mtime === 'number' ? value.mtime : '',
      permissions: typeof value.permissions === 'string' || typeof value.permissions === 'number' ? value.permissions : '',
      uid: typeof value.uid === 'string' || typeof value.uid === 'number' ? value.uid : undefined,
      gid: typeof value.gid === 'string' || typeof value.gid === 'number' ? value.gid : undefined,
      owner: typeof value.owner === 'string' ? value.owner : undefined,
      group: typeof value.group === 'string' ? value.group : undefined,
    };
  }

  private renderEntries(): void {
    this.elements.tableBody.replaceChildren();
    if (this.listView) {
      this.listView.render({
        chinese: this.isChinese(),
        path: this.cwd,
        selectedId: this.selectedEntry()?.name,
        items: this.entries.map((entry, index) => ({
          id: entry.name, name: entry.name, index, entry,
          columns: [
            entry.type === 'directory' ? '' : this.formatSize(entry.size),
            this.localize(this.typeLabel(entry.type)), this.formatDate(entry.mtime),
            String(entry.permissions), entry.owner ?? String(entry.uid ?? ''),
            entry.group ?? String(entry.gid ?? ''),
          ],
        })),
      });
      return;
    }
    const fragment = document.createDocumentFragment();
    this.entries.forEach((entry, index) => {
      const row = document.createElement('tr');
      row.dataset.index = String(index);
      row.tabIndex = index === this.rovingIndex() ? 0 : -1;
      row.setAttribute('aria-selected', String(index === this.selectedIndex));

      const nameCell = document.createElement('td');
      const nameWrap = document.createElement('span');
      nameWrap.className = 'file-name-cell';
      const icon = document.createElement('span');
      icon.className = `file-kind-icon ${entry.type}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = entry.type === 'directory' ? '\u25a0' : entry.type === 'symlink' ? '\u2197' : '\u25a1';
      const name = document.createElement('span');
      name.textContent = entry.name;
      nameWrap.append(icon, name);
      const menu = document.createElement('button');
      menu.type = 'button';
      menu.className = 'file-row-actions';
      menu.dataset.fileMenu = String(index);
      menu.setAttribute('aria-label', this.localize({
        zh: `操作 ${entry.name}`,
        en: `Actions for ${entry.name}`,
      }));
      menu.setAttribute('aria-haspopup', 'dialog');
      menu.textContent = '\u22ef';
      nameCell.append(nameWrap, menu);
      row.append(
        nameCell,
        this.cell(entry.type === 'directory' ? '' : this.formatSize(entry.size)),
        this.localizedCell(this.typeLabel(entry.type)),
        this.cell(this.formatDate(entry.mtime)),
        this.cell(String(entry.permissions ?? '')),
        this.cell(entry.owner ?? String(entry.uid ?? '')),
        this.cell(entry.group ?? String(entry.gid ?? '')),
      );
      fragment.append(row);
    });
    this.elements.tableBody.append(fragment);
  }

  private cell(text: string): HTMLTableCellElement {
    const cell = document.createElement('td');
    cell.textContent = text;
    cell.title = text;
    return cell;
  }

  private localizedCell(copy: LocalizedText): HTMLTableCellElement {
    const cell = this.cell(this.localize(copy));
    cell.dataset.i18nZh = copy.zh;
    cell.dataset.i18nEn = copy.en;
    return cell;
  }

  private rowFromEvent(event: Event): HTMLTableRowElement | null {
    const target = event.target instanceof Element ? event.target.closest<HTMLTableRowElement>('tr[data-index]') : null;
    if (!target || !this.elements.tableBody.contains(target)) return null;
    return target;
  }

  private selectRow(target: HTMLTableRowElement, focus: boolean): SFTPEntry | null {
    const index = Number(target.dataset.index);
    if (!Number.isInteger(index) || !this.entries[index]) return null;
    this.selectedIndex = index;
    for (const row of this.elements.tableBody.rows) {
      const selected = row === target;
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = selected ? 0 : -1;
    }
    if (focus) target.focus();
    this.updateControls();
    return this.entries[index];
  }

  private rovingIndex(): number {
    if (this.entries.length === 0) return -1;
    return this.selectedIndex >= 0 && this.selectedIndex < this.entries.length ? this.selectedIndex : 0;
  }

  private activateEntry(entry: SFTPEntry | null): void {
    if (!entry) return;
    if (entry.type === 'directory' || entry.type === 'symlink') {
      this.navigate(joinPath(this.cwd, entry.name));
    } else {
      this.downloadSelected();
    }
  }

  private toggleHiddenFiles(): void {
    this.showHiddenFiles = !this.showHiddenFiles;
    if (this.elements.toggleHidden) {
      this.elements.toggleHidden.setAttribute('aria-pressed', String(this.showHiddenFiles));
      this.elements.toggleHidden.title = this.showHiddenFiles ? '隐藏以点开头的文件' : '显示以点开头的文件';
    }
    this.applyView();
  }

  /**
   * 1Panel 风格路径面包屑导航：将绝对路径分解为每一级路径段按钮，
   * 用户可直接点击任意一段跳回对应上级目录；右侧提供 ✎ 按钮一键切回原生路径输入框。
   */
  private updateBreadcrumbs(currentPath = this.cwd): void {
    const container = this.elements.breadcrumbs;
    if (!container) return;
    container.replaceChildren();

    const segments: Array<{ name: string; path: string }> = [{ name: '根目录 /', path: '/' }];
    const parts = currentPath.split('/').filter(Boolean);
    let accum = '';
    for (const part of parts) {
      accum += `/${part}`;
      segments.push({ name: part, path: accum });
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'file-breadcrumb-sep';
        sep.textContent = '>';
        container.append(sep);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'file-breadcrumb-btn';
      btn.textContent = seg.name;
      btn.title = seg.path;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (seg.path !== this.cwd) this.navigate(seg.path);
      });
      container.append(btn);
    }
  }

  private togglePathInputMode(manualInput?: boolean): void {
    const container = this.elements.path.closest('.file-path-container') as HTMLElement | null;
    const breadcrumbs = this.elements.breadcrumbs;
    if (!container || !breadcrumbs) return;

    const toInput = manualInput !== undefined ? manualInput : !container.classList.contains('is-manual');
    container.classList.toggle('is-manual', toInput);
    breadcrumbs.hidden = toInput;
    if (this.elements.pathToggle) {
      this.elements.pathToggle.textContent = toInput ? '✓' : '✎';
      this.elements.pathToggle.title = toInput ? '确认并返回面包屑' : '手动输入绝对路径';
    }
    if (toInput) {
      this.elements.path.focus();
      this.elements.path.select();
    }
  }

  /**
   * 1Panel 风格新建文件：
   * 弹出输入框输入新文件名，确认后立即使用内置在线文本编辑器打开，
   * 用户可以在线编写代码内容并一键保存到服务器！
   */
  private async createFile(): Promise<void> {
    if (!this.ready || this.hasTransfer()) return;
    const input = await this.promptAction(this.localize({
      zh: '新文件名称（如 app.py、docker-compose.yml、config.json）',
      en: 'New file name (e.g. app.py, docker-compose.yml, config.json)',
    }), '');
    if (input === null || !input.trim()) return;
    const filename = input.trim();
    let path: string;
    try { path = joinPath(this.cwd, filename); } catch {
      this.showError(this.localize({ zh: '文件名无效。', en: 'The file name is invalid.' }));
      return;
    }
    const existing = this.sourceEntries.find((e) => e.name === filename);
    if (existing) {
      this.showError(this.localize({ zh: `“${filename}”已存在。`, en: `“${filename}” already exists.` }));
      return;
    }
    // 打开文本编辑器创建新文件，不必发起远程下载
    this.openEditor(path, filename, true);
  }

  private async createDirectory(): Promise<void> {
    if (!this.ready || this.hasTransfer()) return;
    const input = await this.promptAction(this.localize({ zh: '新文件夹名称', en: 'New folder name' }), '');
    if (input === null) return;
    let path: string;
    try { path = joinPath(this.cwd, input); } catch {
      this.showError(this.localize({ zh: '文件夹名称无效。', en: 'The folder name is invalid.' }));
      return;
    }
    const requestId = this.createRequest('mkdir', path);
    this.send({ type: 'sftp_mkdir', requestId, path });
    this.setStatus({ zh: '正在新建文件夹…', en: 'Creating folder…' });
  }

  private async renameSelected(): Promise<void> {
    const entry = this.selectedEntry();
    if (!this.ready || !entry || this.hasTransfer()) return;
    const input = await this.promptAction(this.localize({ zh: '输入新名称', en: 'Enter a new name' }), entry.name);
    if (input === null || input === entry.name) return;
    let newPath: string;
    try { newPath = joinPath(this.cwd, input); } catch {
      this.showError(this.localize({ zh: '文件名无效。', en: 'The file name is invalid.' }));
      return;
    }
    const oldPath = joinPath(this.cwd, entry.name);
    const requestId = this.createRequest('rename', oldPath);
    this.send({ type: 'sftp_rename', requestId, oldPath, newPath });
    this.setStatus({ zh: '正在重命名…', en: 'Renaming…' });
  }

  private async deleteSelected(): Promise<void> {
    const entry = this.selectedEntry();
    if (!this.ready || !entry || this.hasTransfer()) return;
    const confirmed = await this.confirmAction(this.localize({
      zh: `确定要删除“${entry.name}”吗？此操作无法撤销。`,
      en: `Delete “${entry.name}”? This cannot be undone.`,
    }));
    if (!confirmed) return;
    const path = joinPath(this.cwd, entry.name);
    const operation = entry.type === 'directory' ? 'rmdir' : 'delete';
    const requestId = this.createRequest(operation, path);
    this.send({ type: operation === 'rmdir' ? 'sftp_rmdir' : 'sftp_delete', requestId, path });
    this.setStatus({ zh: '正在删除…', en: 'Deleting…' });
  }

  private handleMutationResult(message: JsonRecord): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const pending = this.pending.get(requestId);
    if (!pending || pending.generation !== this.generation || !['mkdir', 'rename', 'delete', 'rmdir'].includes(pending.operation)) return;
    this.pending.delete(requestId);
    pending.resolve?.();
    this.setStatus({ zh: '操作完成', en: 'Operation completed' });
    if (!pending.suppressRefresh) this.refresh();
  }

  private async handleUploadReady(message: JsonRecord): Promise<void> {
    const state = this.matchUpload(message);
    if (!state || state.sent !== 0) return;
    state.readyForData = true;
    if (state.cancelling) {
      this.sendUploadCancel(state);
      return;
    }
    await this.sendNextUploadChunk(state);
  }

  private async handleUploadProgress(message: JsonRecord): Promise<void> {
    const state = this.matchUpload(message);
    if (!state) return;
    const acknowledged = numberValue(message.loaded) ?? numberValue(message.transferred) ?? numberValue(message.received) ?? numberValue(message.bytes) ?? state.sent;
    state.acknowledged = Math.min(state.file.size, Math.max(state.acknowledged, acknowledged));
    state.awaitingAck = false;
    this.showProgress('upload', state.file.name, state.file.size === 0 ? 100 : (state.acknowledged / state.file.size) * 100);
    if (state.cancelling) {
      this.sendUploadCancel(state);
      return;
    }
    await this.sendNextUploadChunk(state);
  }

  private async sendNextUploadChunk(state: UploadState): Promise<void> {
    if (state !== this.uploadState || state.generation !== this.generation || !state.readyForData
      || state.cancelling || state.awaitingAck || state.endSent || !this.isSocketOpen()) return;
    if (state.sent >= state.file.size) {
      state.endSent = true;
      this.updateProgressLanguage();
      this.send({ type: 'sftp_upload_end', requestId: state.requestId });
      return;
    }
    const end = Math.min(state.file.size, state.sent + SFTP_UPLOAD_CHUNK_SIZE);
    const chunk = await state.file.slice(state.sent, end).arrayBuffer();
    if (state !== this.uploadState || state.generation !== this.generation || state.cancelling || !this.isSocketOpen()) return;
    this.socket!.send(chunk);
    state.sent = end;
    state.awaitingAck = true;
  }

  private handleUploadComplete(message: JsonRecord): void {
    const state = this.matchUpload(message);
    if (!state) return;
    this.pending.delete(state.requestId);
    this.uploadState = null;
    this.hideProgress();
    const remaining = this.uploadQueue.length;
    this.setStatus(remaining > 0
      ? { zh: `已上传 ${state.file.name}，剩余 ${remaining} 个`, en: `Uploaded ${state.file.name}, ${remaining} left in queue` }
      : { zh: `已上传 ${state.file.name}`, en: `Uploaded ${state.file.name}` });
    this.updateControls();
    if (remaining > 0) {
      // 队列排空后再刷新目录，避免每个文件都重新拉一次列表。
      void this.pumpUploadQueue();
      return;
    }
    this.refresh();
  }

  private handleDownloadStart(message: JsonRecord): void {
    const state = this.matchDownload(message);
    if (!state) return;
    state.started = true;
    const size = numberValue(message.size);
    state.expectedSize = size;
    if (state.cancelling) {
      this.sendDownloadCancel(state);
      return;
    }
    if (state.expectedSize !== null && state.expectedSize > MAX_SFTP_FILE_SIZE) {
      state.cancelling = true;
      this.setStatus({ zh: '正在取消传输…', en: 'Cancelling transfer…' });
      this.updateProgressLanguage();
      this.sendDownloadCancel(state);
    }
  }

  private handleDownloadProgress(message: JsonRecord): void {
    const state = this.matchDownload(message);
    if (!state || state.cancelling) return;
    const received = numberValue(message.loaded) ?? numberValue(message.transferred) ?? numberValue(message.sent) ?? numberValue(message.bytes) ?? state.received;
    const total = numberValue(message.total) ?? numberValue(message.size) ?? state.expectedSize;
    const percent = total && total > 0 ? Math.min(100, (received / total) * 100) : 0;
    this.showProgress('download', state.name, percent);
  }

  private async handleBinary(data: Exclude<SocketData, string>, generation: number): Promise<void> {
    const state = this.downloadState;
    if (!state || state.generation !== generation || generation !== this.generation) return;
    let buffer: ArrayBuffer;
    if (data instanceof Blob) buffer = await data.arrayBuffer();
    else if (ArrayBuffer.isView(data)) buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    else buffer = data;
    if (state !== this.downloadState || state.generation !== this.generation) return;
    if (state.cancelling) return;
    if (state.received + buffer.byteLength > MAX_SFTP_FILE_SIZE) {
      state.cancelling = true;
      this.setStatus({ zh: '正在取消传输…', en: 'Cancelling transfer…' });
      this.updateProgressLanguage();
      this.sendDownloadCancel(state);
      return;
    }
    state.chunks.push(buffer);
    state.received += buffer.byteLength;
    const total = state.expectedSize;
    this.showProgress('download', state.name, total && total > 0 ? (state.received / total) * 100 : 0);
  }

  private handleDownloadDone(message: JsonRecord): void {
    const state = this.matchDownload(message);
    if (!state) return;
    if (state.cancelling) {
      this.completeCancelledTransfer(state);
      return;
    }
    const doneSize = numberValue(message.size);
    const expectedSize = doneSize ?? state.expectedSize;
    if (expectedSize !== null && state.received !== expectedSize) {
      this.failTransfer(this.localize({ zh: '下载未完成，文件大小不匹配。', en: 'The download is incomplete: file size mismatch.' }));
      return;
    }
    this.pending.delete(state.requestId);
    this.downloadState = null;
    const blob = new Blob(state.chunks);
    // 编辑器复用下载通道：命中编辑器会话时把字节转成文本，而不是弹出预览或存盘。
    const editing = state.preview && this.editorState && this.editorState.name === state.name;
    if (editing) {
      this.hideProgress();
      this.fillEditor(state.name, blob);
      this.updateControls();
      void this.pumpUploadQueue();
      return;
    }
    if (state.preview) void this.showPreview(state.name, blob);
    else this.saveBlob(blob, state.name);
    this.hideProgress();
    this.setStatus(state.preview
      ? { zh: `正在预览 ${state.name}`, en: `Previewing ${state.name}` }
      : { zh: `已下载 ${state.name}`, en: `Downloaded ${state.name}` });
    this.updateControls();
    void this.pumpUploadQueue();
  }

  private handleServerError(message: JsonRecord): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    // === Tree-view fetch error: route to tree channel, never enter right-side error handling ===
    if (requestId.startsWith('tree-')) {
      this.rejectTreeList(message, requestId);
      return;
    }
    const pending = requestId ? this.pending.get(requestId) : undefined;
    if (requestId && (!pending || pending.generation !== this.generation)) return;
    if (requestId) this.pending.delete(requestId);
    if (pending?.operation === 'list' && requestId !== this.activeListRequest) return;
    if (requestId === this.activeListRequest) {
      this.activeListRequest = null;
      this.elements.loading.hidden = true;
    }
    const fallback = this.localize({ zh: '文件操作失败。', en: 'The file operation failed.' });
    const serverMessage = typeof message.message === 'string' && message.message ? message.message : fallback;
    pending?.reject?.(new Error(serverMessage));
    const transfer = requestId === this.uploadState?.requestId
      ? this.uploadState
      : requestId === this.downloadState?.requestId
        ? this.downloadState
        : null;
    if (transfer) {
      this.abortTransfers(true);
    }
    // 编辑器读入失败：错误显示在编辑器状态行，并关掉空对话框。
    if (this.editorState && transfer === this.downloadState) {
      this.closeEditor();
    }
    this.showError(serverMessage);
  }

  /** Resolve a pending tree-view fetch promise with parsed, sorted entries. */
  private resolveTreeList(message: JsonRecord, requestId: string): void {
    const entry = this.treeLists.get(requestId);
    if (!entry || entry.generation !== this.generation) return;
    this.treeLists.delete(requestId);
    let path: string;
    try { path = normalizePath(typeof message.path === 'string' ? message.path : ''); }
    catch {
      entry.reject(new Error(
        this.localize({ zh: '目录列表数据异常。', en: 'The directory listing response was malformed.' }),
        { cause: 'invalid path in tree list result' },
      ));
      return;
    }
    if (!Array.isArray(message.entries)) {
      entry.reject(new Error(
        this.localize({ zh: '目录列表数据异常。', en: 'The directory listing response was malformed.' }),
        { cause: 'invalid entries in tree list result' },
      ));
      return;
    }
    const entries = message.entries
      .map((raw) => this.parseEntry(raw))
      .filter((item): item is SFTPEntry => item !== null);
    entries.sort((left, right) => {
      if (left.type === 'directory' && right.type !== 'directory') return -1;
      if (left.type !== 'directory' && right.type === 'directory') return 1;
      return left.name.localeCompare(right.name, this.isChinese() ? 'zh-CN' : 'en', { numeric: true, sensitivity: 'base' });
    });
    entry.resolve({ path, entries, isTruncated: message.isTruncated === true });
  }

  /** Reject a single pending tree-view fetch promise with the server error message. */
  private rejectTreeList(message: JsonRecord, requestId: string): void {
    const entry = this.treeLists.get(requestId);
    if (!entry || entry.generation !== this.generation) return;
    this.treeLists.delete(requestId);
    const fallback = this.localize({ zh: '文件操作失败。', en: 'The file operation failed.' });
    const serverMessage = typeof message.message === 'string' && message.message ? message.message : fallback;
    entry.reject(new Error(serverMessage));
  }

  /** Reject all pending tree-view fetch promises (used on reset / close / destroy). */
  private rejectTreeLists(error: Error): void {
    this.treeLists.forEach((entry) => {
      entry.reject(error);
    });
    this.treeLists.clear();
  }

  /** Notify all registered cwd-change listeners. Listener errors are swallowed. */
  private emitCwdChange(cwd: string): void {
    this.cwdListeners.forEach((listener) => {
      try { listener(cwd); } catch { /* listener errors are non-fatal */ }
    });
  }

  private handleTransferCancelled(message: JsonRecord, operation: 'upload' | 'download'): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const state = operation === 'upload' ? this.uploadState : this.downloadState;
    if (!state || state.requestId !== requestId || state.generation !== this.generation || !state.cancelling) return;
    this.completeCancelledTransfer(state);
  }

  private completeCancelledTransfer(state: UploadState | DownloadState): void {
    if (state !== this.uploadState && state !== this.downloadState) return;
    this.pending.delete(state.requestId);
    this.abortTransfers(true);
    this.setStatus({ zh: '传输已取消', en: 'Transfer cancelled' });
  }

  private requestTransferCancel(): void {
    const upload = this.uploadState;
    const transfer = upload ?? this.downloadState;
    if (!transfer || transfer.cancelling || upload?.endSent) return;
    transfer.cancelling = true;
    this.setStatus({ zh: '正在取消传输…', en: 'Cancelling transfer…' });
    this.updateProgressLanguage();
    if (upload) this.sendUploadCancel(upload);
    else this.sendDownloadCancel(transfer as DownloadState);
  }

  private sendUploadCancel(state: UploadState): void {
    if (state !== this.uploadState || state.cancelSent || !state.readyForData || !this.isSocketOpen()) return;
    state.cancelSent = true;
    this.send({ type: 'sftp_upload_cancel', requestId: state.requestId });
  }

  private sendDownloadCancel(state: DownloadState): void {
    if (state !== this.downloadState || state.cancelSent || !state.started || !this.isSocketOpen()) return;
    state.cancelSent = true;
    this.send({ type: 'sftp_download_cancel', requestId: state.requestId });
  }

  private createRequest(operation: string, path: string, extra: Partial<PendingRequest> = {}): string {
    const requestId = `${this.generation}-${++this.requestSequence}`;
    this.pending.set(requestId, { generation: this.generation, operation, path, ...extra });
    return requestId;
  }

  private matchUpload(message: JsonRecord): UploadState | null {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const state = this.uploadState;
    return state && state.requestId === requestId && state.generation === this.generation ? state : null;
  }

  private matchDownload(message: JsonRecord): DownloadState | null {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const state = this.downloadState;
    return state && state.requestId === requestId && state.generation === this.generation ? state : null;
  }

  private send(message: JsonRecord): void {
    if (this.isSocketOpen()) this.socket!.send(JSON.stringify(message));
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private hasTransfer(): boolean {
    return this.uploadState !== null || this.downloadState !== null;
  }

  private selectedEntry(): SFTPEntry | null {
    return this.selectedIndex >= 0 ? this.entries[this.selectedIndex] ?? null : null;
  }

  private abortTransfers(updateControls: boolean): void {
    this.uploadState = null;
    this.downloadState = null;
    this.hideProgress();
    if (updateControls) this.updateControls();
    // A cancelled or failed transfer frees the single upload slot for the queue.
    void this.pumpUploadQueue();
  }

  private failTransfer(message: string): void {
    const requestId = this.uploadState?.requestId ?? this.downloadState?.requestId;
    if (requestId) this.pending.delete(requestId);
    this.abortTransfers(true);
    this.showError(message);
  }

  private updateControls(): void {
    const selected = this.selectedEntry();
    const idle = this.ready && !this.hasTransfer() && !this.uploadConfirmationPending;
    this.elements.path.disabled = !this.ready;
    this.elements.back.disabled = !this.ready || this.historyIndex <= 0;
    this.elements.up.disabled = !this.ready || this.cwd === '/';
    // 列目录失败时 cwd 仍是上次成功路径，允许用主目录按钮恢复，而不把错误页锁在原处。
    this.elements.home.disabled = !this.ready || (this.cwd === this.homePath && this.elements.error.hidden);
    this.elements.refresh.disabled = !this.ready;
    this.elements.upload.disabled = !idle;
    this.elements.mkdir.disabled = !idle;
    if (this.elements.newFile) this.elements.newFile.disabled = !idle;
    this.elements.download.disabled = !idle || !selected || selected.type !== 'file' || sizeExceedsLimit(selected.size);
    this.elements.rename.disabled = !idle || !selected;
    this.elements.delete.disabled = !idle || !selected;
    this.updateSheetControls();
  }

  private renderDisconnected(channelLost = false, detail?: LocalizedText): void {
    this.entries = [];
    this.sourceEntries = [];
    this.selectedIndex = -1;
    this.uploadQueue = [];
    this.dragDepth = 0;
    this.elements.panel.classList.remove('is-drop-target');
    this.closeActionSheet(false);
    this.renderEntries();
    this.elements.loading.hidden = true;
    this.elements.empty.hidden = true;
    this.elements.error.hidden = true;
    this.elements.path.value = '/';
    this.updateBreadcrumbs('/');
    this.hideProgress();
    if (channelLost) this.setStatus(detail ?? DISCONNECTED_CHANNEL);
    else this.updateStatusText(DISCONNECTED);
    this.updateControls();
  }

  private describeClose(event: CloseEvent): LocalizedText | undefined {
    if (event.code === 1000) return undefined;
    const codeInfo = this.isChinese()
      ? `代码 ${event.code}${event.reason ? `：${event.reason}` : ''}`
      : `code ${event.code}${event.reason ? `: ${event.reason}` : ''}`;
    const base = DISCONNECTED_CHANNEL;
    return { zh: `${base.zh}（${codeInfo}）`, en: `${base.en} (${codeInfo})` };
  }

  private showError(message: string): void {
    this.elements.loading.hidden = true;
    this.elements.empty.hidden = true;
    this.elements.error.textContent = message;
    this.elements.error.hidden = false;
    this.updateStatusText({ zh: message, en: message });
    this.onError?.(message);
    this.updateControls();
  }

  private scheduleReconnect(): void {
    if (!this.wantConnection || !this.url || this.reconnectTimer !== null) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      console.log(
        `[WS-Reconnect] ${new Date().toISOString()} | SFTP | give_up | attempt=${this.reconnectAttempts - 1}/${RECONNECT_MAX_ATTEMPTS}`,
      );
      this.reconnectGaveUp = true;
      this.reconnectAttempts = 0;
      this.renderDisconnected(true, { zh: '文件管理重连失败。', en: 'File manager reconnect failed.' });
      return;
    }
    const delayIndex = this.reconnectAttempts - 1;
    const delay = delayIndex < RECONNECT_DELAYS.length
      ? RECONNECT_DELAYS[delayIndex]
      : RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1];
    console.log(
      `[WS-Reconnect] ${new Date().toISOString()} | SFTP | reconnect_attempt | attempt=${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}`,
    );
    this.setStatus({
      zh: '文件管理连接已断开，正在重连…',
      en: 'File manager disconnected; reconnecting…',
    });
    const attempts = this.reconnectAttempts;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantConnection || !this.url) return;
      try {
        this.attach(this.url);
      } catch {
        console.log(
          `[WS-Reconnect] ${new Date().toISOString()} | SFTP | reconnect_failed | attempt=${attempts}/${RECONNECT_MAX_ATTEMPTS}`,
        );
        // attach() → reset() zeroed the counter; restore so the next
        // close handler's scheduleReconnect() continues accumulating.
        if (this.wantConnection) {
          this.reconnectAttempts = attempts;
        }
        this.scheduleReconnect();
        return;
      }
      // Successful attach(). The open handler will log reconnect_success
      // once the WebSocket actually connects; for now restore the counter
      // so that if a close fires before open confirms, back-off continues.
      if (this.wantConnection) {
        this.reconnectAttempts = attempts;
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(copy: LocalizedText): void {
    this.updateStatusText(copy);
    this.onStatus?.(this.localize(copy));
  }

  private updateStatusText(copy: LocalizedText): void {
    this.statusCopy = copy;
    this.elements.status.dataset.i18nZh = copy.zh;
    this.elements.status.dataset.i18nEn = copy.en;
    this.elements.status.textContent = this.localize(copy);
  }

  private showProgress(operation: 'upload' | 'download', name: string, percent: number): void {
    this.elements.progress.dataset.operation = operation;
    this.elements.progress.dataset.name = name;
    this.elements.progress.hidden = false;
    this.elements.progressCancel.disabled = false;
    this.elements.progressBar.value = Math.max(0, Math.min(100, percent));
    this.updateProgressLanguage();
  }

  private updateProgressLanguage(): void {
    if (this.elements.progress.hidden) return;
    const transfer = this.uploadState ?? this.downloadState;
    const operation = this.elements.progress.dataset.operation;
    const name = this.elements.progress.dataset.name ?? '';
    const verb = operation === 'upload'
      ? this.localize({ zh: '上传', en: 'Uploading' })
      : this.localize({ zh: '下载', en: 'Downloading' });
    this.elements.progressLabel.textContent = transfer?.cancelling
      ? this.localize({ zh: `正在取消 ${name}…`, en: `Cancelling ${name}…` })
      : `${verb} ${name} ${Math.round(this.elements.progressBar.value)}%`;
    this.elements.progressCancel.disabled = Boolean(transfer?.cancelling || this.uploadState?.endSent);
    this.elements.progressCancel.textContent = transfer?.cancelling
      ? this.localize({ zh: '取消中…', en: 'Cancelling…' })
      : this.localize({ zh: '取消', en: 'Cancel' });
  }

  private hideProgress(): void {
    this.elements.progress.hidden = true;
    this.elements.progressBar.value = 0;
    this.elements.progressLabel.textContent = '';
    this.elements.progressCancel.disabled = false;
    this.elements.progressCancel.textContent = this.localize({ zh: '取消', en: 'Cancel' });
    delete this.elements.progress.dataset.operation;
    delete this.elements.progress.dataset.name;
  }

  private formatSize(bytes: number | string): string {
    if (typeof bytes === 'string') return sizeExceedsLimit(bytes) ? '> 64 MiB' : this.formatSize(Number(bytes));
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = -1;
    do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  private formatDate(value: string | number): string {
    if (value === '') return '';
    const numeric = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1000 : value) : value;
    const date = new Date(numeric);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(this.isChinese() ? 'zh-CN' : 'en', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  private typeLabel(type: SFTPEntry['type']): LocalizedText {
    if (type === 'directory') return { zh: '文件夹', en: 'Folder' };
    if (type === 'file') return { zh: '文件', en: 'File' };
    if (type === 'symlink') return { zh: '链接', en: 'Link' };
    return { zh: '其他', en: 'Other' };
  }

  private saveBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private localize(copy: LocalizedText): string {
    return this.isChinese() ? copy.zh : copy.en;
  }

  private isChinese(): boolean {
    return this.getLanguage().toLowerCase().startsWith('zh');
  }
}
