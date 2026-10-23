import React, { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Tree, type NodeRendererProps, type RowRendererProps, type TreeApi } from 'react-arborist';
import { fileKind, fileKindLabels, fileKindPaths } from './file-kind';
import type { FileListItem, FileListSnapshot, FileListView } from './file-list-view';
import './file-list.css';

interface FileListActions {
  select(index: number): void;
  activate(index: number): void;
  openMenu(index: number): void;
}

const ActionsContext = createContext<FileListActions | null>(null);

function FileRow({ node, attrs, innerRef, children }: RowRendererProps<FileListItem>) {
  const actions = useContext(ActionsContext);
  const press = useRef<{ timer: number | null; x: number; y: number }>({ timer: null, x: 0, y: 0 });
  const cancelLongPress = () => {
    if (press.current.timer === null) return;
    window.clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  useLayoutEffect(() => cancelLongPress, []);
  const openMenu = () => {
    node.select();
    actions?.openMenu(node.data.index);
  };
  return <div {...attrs} ref={innerRef} className={`files-list-row${node.isSelected ? ' is-selected' : ''}`}
    aria-label={node.data.name} onFocus={(event) => event.stopPropagation()}
    onClick={() => node.select()} onDoubleClick={() => node.activate()}
    onContextMenu={(event) => { event.preventDefault(); openMenu(); }}
    onPointerDown={(event) => {
      if (event.pointerType === 'mouse' || !actions) return;
      cancelLongPress();
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => { press.current.timer = null; openMenu(); }, 480),
      };
    }}
    onPointerMove={(event) => {
      if (press.current.timer === null) return;
      if (Math.abs(event.clientX - press.current.x) > 8 || Math.abs(event.clientY - press.current.y) > 8) cancelLongPress();
    }}
    onPointerUp={cancelLongPress}
    onPointerCancel={cancelLongPress}
    onPointerLeave={cancelLongPress}>
    {children}
  </div>;
}

function FileNode({ node, style }: NodeRendererProps<FileListItem>) {
  const { entry, columns } = node.data;
  const actions = useContext(ActionsContext);
  const kind = fileKind(entry);
  return <div className="files-list-columns" style={style}>
    <span className="files-list-name" title={entry.name}>
      <svg className={`files-list-icon is-${kind}`} data-file-kind={kind} viewBox="0 0 24 24" aria-hidden="true">
        {fileKindPaths[kind].map((path) => <path key={path} d={path} />)}
      </svg>
      <span>{entry.name}</span>
    </span>
    {columns.map((text, index) => <span key={index} className={`files-list-meta column-${index}`} title={text}>{text}</span>)}
    <button
      type="button"
      className="files-list-menu"
      aria-label={`${node.data.name} 操作`}
      aria-haspopup="dialog"
      onPointerDown={(event) => {
        // Selecting the row re-renders it; open the sheet on pointerdown so the
        // button is not replaced between mousedown and click.
        event.preventDefault();
        event.stopPropagation();
        node.select();
        actions?.openMenu(node.data.index);
      }}
      onClick={(event) => {
        event.stopPropagation();
        // Keyboard activation (Enter/Space) has detail === 0 and no pointerdown.
        if (event.detail === 0) {
          node.select();
          actions?.openMenu(node.data.index);
        }
      }}
    >&#8943;</button>
  </div>;
}

/** 从 CSS 读取行高，独立页与工作台坞各有一套紧凑度。 */
function readRowHeight(): number {
  if (matchMedia('(max-width: 600px)').matches) return 48;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--files-row-height');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 24 ? parsed : 44;
}

function FileList({ snapshot, actions }: { snapshot: FileListSnapshot; actions: FileListActions }) {
  const viewport = useRef<HTMLDivElement>(null);
  const tree = useRef<TreeApi<FileListItem>>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 600px)').matches);
  // 行高跟随独立页/终端坞两套 CSS：紧凑视图 34px，宽列表 44px，触屏保持大目标。
  const [rowHeight, setRowHeight] = useState(() => readRowHeight());
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewport.current!);
    const media = matchMedia('(max-width: 600px)');
    const update = () => { setMobile(media.matches); setRowHeight(readRowHeight()); };
    media.addEventListener('change', update);
    return () => { observer.disconnect(); media.removeEventListener('change', update); };
  }, []);
  const headers = snapshot.chinese
    ? ['名称', '大小', '类型', '修改时间', '权限', '用户', '组']
    : ['Name', 'Size', 'Type', 'Modified', 'Permissions', 'Owner', 'Group'];
  return <>
    <div className="files-list-header files-list-columns" aria-hidden="true">
      {headers.map((title, index) => <span key={title} className={index ? `column-${index - 1}` : ''}>{title}</span>)}
    </div>
    <div className="files-list-viewport" ref={viewport} onKeyDownCapture={(event) => {
      // Arborist 的 Enter 默认用于内联改名；这里保持文件管理器“Enter 打开”的既有约定。
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      tree.current?.focusedNode?.activate();
    }}>
      {/* 右侧仍是当前目录的平铺列表；目录展开由左侧负责，不额外维护第二棵远端树。 */}
      {size.width > 0 && size.height > 0 && <ActionsContext.Provider value={actions}><Tree<FileListItem>
        ref={tree} data={snapshot.items} width={size.width} height={size.height}
        rowHeight={rowHeight} indent={0} overscanCount={4}
        selection={snapshot.selectedId} selectionFollowsFocus disableMultiSelection
        disableDrag disableDrop disableEdit disableDeselectOnClick
        aria-label={snapshot.chinese ? '文件列表' : 'File list'}
        renderRow={FileRow}
        onSelect={(nodes) => actions.select(nodes[0]?.data.index ?? -1)}
        onActivate={(node) => actions.activate(node.data.index)}>
        {FileNode}
      </Tree></ActionsContext.Provider>}
    </div>
  </>;
}

/** React 只挂在独立文件页内；卸载后把同一会话交还给原生终端表格。 */
export class ArboristFileList implements FileListView {
  private readonly root: Root;
  private revision = 0;
  private lastPath: string | null = null;

  constructor(private readonly host: HTMLElement, private readonly actions: FileListActions) {
    this.root = createRoot(host);
  }

  render(snapshot: FileListSnapshot): void {
    const items = snapshot.items.map((item) => {
      const label = fileKindLabels[fileKind(item.entry)];
      return { ...item, columns: item.columns.map((text, index) => index === 1 && item.entry.type === 'file'
        ? label[snapshot.chinese ? 'zh' : 'en'] : text) };
    });
    // 仅切换目录时重挂载列表，筛选/排序/选中变化在原地更新，避免丢失滚动位置。
    if (this.lastPath !== snapshot.path) {
      this.lastPath = snapshot.path;
      this.revision++;
    }
    this.root.render(<FileList key={this.revision} snapshot={{ ...snapshot, items }} actions={this.actions} />);
  }

  destroy(): void {
    this.root.unmount();
    this.host.remove();
  }
}
