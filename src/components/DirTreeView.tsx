import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronIcon, FileIcon, FolderIcon, RefreshIcon } from "./icons";

type DirEntryItem = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
};

type DirListing = {
  entries: DirEntryItem[];
  truncated: boolean;
  total: number;
};

type DirTreeViewProps = {
  rootPath: string;
  /** 点击文件时回调（在右侧 Dock 打开内容预览） */
  onOpenFile?: (path: string) => void;
};

/** 文件大小的人类可读展示（超过 1MB 才显示，避免噪音） */
function sizeLabel(size: number): string {
  if (size < 1024 * 1024) return "";
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

const MAX_DEPTH = 8;
/**
 * Java 工程结构目录：不参与路径压缩（对齐 IntelliJ IDEA 观感——
 * src/main/java 这类源码根保持逐级展开，用户自建的包名链才压缩）
 */
const JAVA_STRUCT_DIRS = new Set(["src", "main", "java", "test", "resources", "webapp"]);
/** 压缩链的最大深度与单层加载的额外 readdir 预算（防止极端深链拖慢加载） */
const CHAIN_MAX_DEPTH = 12;
const CHAIN_READ_BUDGET = 80;

/** 拖拽到输入框的自定义 MIME 类型 */
export const TREE_RESOURCE_MIME = "application/x-dsh-tree-resource";

/**
 * 单子目录链压缩（IDEA 式）：目录只有唯一子目录时合并展示为 a/b/c。
 * 链上任何一段是 Java 结构目录（src/main/java/…）即停止压缩。
 * 返回压缩后的条目：name 为合并路径，path 为链末端目录（展开时按末端读层）。
 */
async function compressChain(entry: DirEntryItem, showHidden: boolean, budget: { reads: number }): Promise<DirEntryItem> {
  if (!entry.is_dir || JAVA_STRUCT_DIRS.has(entry.name)) return entry;
  let current = entry;
  let name = entry.name;
  for (let depth = 0; depth < CHAIN_MAX_DEPTH; depth += 1) {
    if (budget.reads >= CHAIN_READ_BUDGET) break;
    budget.reads += 1;
    let listing: DirListing;
    try {
      listing = await invoke<DirListing>("list_directory", { path: current.path, showHidden });
    } catch {
      break;
    }
    if (listing.entries.length !== 1 || !listing.entries[0].is_dir) break;
    const child = listing.entries[0];
    if (JAVA_STRUCT_DIRS.has(child.name)) break;
    name = `${name}/${child.name}`;
    current = { ...child, name };
  }
  return { ...current, name, is_dir: true };
}

/**
 * 惰性目录树：只在目录被展开时才读取该层内容（invoke list_directory），
 * 已加载的层缓存在 ref 里，折叠/再展开不重复 IO；折叠时子树整体卸载出 DOM。
 * 单子目录链在加载层时顺带压缩（链上每段是一次廉价 readdir，有预算上限）。
 */
const DirTreeView = memo(function DirTreeView({ rootPath, onOpenFile }: DirTreeViewProps) {
  // childrenCache: path -> 已加载的该层条目（目录条目已做链压缩，跨折叠保留）
  const childrenCacheRef = useRef<Map<string, DirEntryItem[]>>(new Map());
  const metaCacheRef = useRef<Map<string, { truncated: boolean; total: number }>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [showHidden, setShowHidden] = useState(false);
  const [revealedPath, setRevealedPath] = useState("");
  // showHidden 翻转后已缓存层作废（过滤结果不同）
  const hiddenFlagRef = useRef(false);
  const [tick, setTick] = useState(0); // 缓存是 ref，翻转隐藏开关/刷新时手动触发重渲染

  const loadDir = useCallback(async (dirPath: string) => {
    if (childrenCacheRef.current.has(dirPath)) return;
    setLoading((prev) => new Set(prev).add(dirPath));
    try {
      const listing = await invoke<DirListing>("list_directory", {
        path: dirPath,
        showHidden: hiddenFlagRef.current,
      });
      const budget = { reads: 0 };
      const entries = await Promise.all(listing.entries.map((entry) => (
        entry.is_dir ? compressChain(entry, hiddenFlagRef.current, budget) : Promise.resolve(entry)
      )));
      childrenCacheRef.current.set(dirPath, entries);
      metaCacheRef.current.set(dirPath, { truncated: listing.truncated, total: listing.total });
      setErrors((prev) => {
        if (!prev.has(dirPath)) return prev;
        const next = new Map(prev);
        next.delete(dirPath);
        return next;
      });
    } catch (caught) {
      setErrors((prev) => new Map(prev).set(dirPath, caught instanceof Error ? caught.message : String(caught)));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
      setTick((value) => value + 1);
    }
  }, []);

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath); // 折叠：子树从 DOM 卸载，缓存保留
      } else {
        next.add(dirPath);
        void loadDir(dirPath);
      }
      return next;
    });
  }, [loadDir]);

  // 挂载即加载根目录（根层初始就在 expanded 里）
  useEffect(() => {
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

  const refresh = useCallback(() => {
    childrenCacheRef.current.clear();
    metaCacheRef.current.clear();
    setErrors(new Map());
    hiddenFlagRef.current = showHidden;
    setTick((value) => value + 1);
    // 重新加载当前已展开的各层
    for (const path of expanded) void loadDir(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, showHidden, loadDir]);

  const toggleHidden = useCallback(() => {
    const next = !showHidden;
    setShowHidden(next);
    childrenCacheRef.current.clear();
    metaCacheRef.current.clear();
    hiddenFlagRef.current = next;
    setErrors(new Map());
    setTick((value) => value + 1);
    // expanded 状态保留；空数组缓存清掉后需要重新拉取已展开层
    // loadDir 以 childrenCacheRef.has 为闸门，清空后再次调用会真正请求
    for (const path of expanded) void loadDir(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden, expanded, loadDir]);

  const revealFile = useCallback((path: string) => {
    void invoke("reveal_local_file", { path })
      .then(() => {
        setRevealedPath(path);
        window.setTimeout(() => setRevealedPath(""), 1200);
      })
      .catch(() => undefined);
  }, []);

  const startDrag = useCallback((event: React.DragEvent, entry: DirEntryItem) => {
    const payload = JSON.stringify({ path: entry.path, name: entry.name.split("/").pop() || entry.name, displayName: entry.name, isDir: entry.is_dir });
    event.dataTransfer.setData(TREE_RESOURCE_MIME, payload);
    event.dataTransfer.setData("text/plain", entry.path);
    event.dataTransfer.effectAllowed = "copy";
  }, []);

  const renderEntries = (entries: DirEntryItem[], depth: number, dirPath: string) => {
    const meta = metaCacheRef.current.get(dirPath);
    const rows: React.ReactNode[] = [];
    for (const entry of entries) {
      const dragProps = {
        draggable: true,
        onDragStart: (event: React.DragEvent) => startDrag(event, entry),
        title: `${entry.path}\n${entry.is_dir ? "点击展开 · 拖到输入框引用" : "点击预览 · 拖到输入框引用"}`,
      };
      if (entry.is_dir) {
        const isOpen = expanded.has(entry.path);
        rows.push(
          <div
            key={entry.path}
            className={`dir-tree-row dir${isOpen ? " open" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            role="treeitem"
            aria-expanded={isOpen}
            onClick={() => toggleDir(entry.path)}
            {...dragProps}
          >
            <ChevronIcon className="dir-tree-chevron" />
            <FolderIcon className="dir-tree-icon" />
            <span className="dir-tree-name" title={entry.name}>{entry.name}</span>
          </div>,
        );
        if (isOpen && depth < MAX_DEPTH) {
          const children = childrenCacheRef.current.get(entry.path);
          const isLoading = loading.has(entry.path);
          const error = errors.get(entry.path);
          rows.push(
            <div key={`${entry.path}:children`} className="dir-tree-children" role="group">
              {isLoading ? (
                <div className="dir-tree-hint" style={{ paddingLeft: 10 + (depth + 1) * 14 }}>加载中…</div>
              ) : error ? (
                <div className="dir-tree-hint error" style={{ paddingLeft: 10 + (depth + 1) * 14 }}>{error}</div>
              ) : children && children.length > 0 ? (
                renderEntries(children, depth + 1, entry.path)
              ) : (
                <div className="dir-tree-hint" style={{ paddingLeft: 10 + (depth + 1) * 14 }}>空目录</div>
              )}
            </div>,
          );
        }
      } else {
        rows.push(
          <div
            key={entry.path}
            className={`dir-tree-row file${revealedPath === entry.path ? " revealed" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            role="treeitem"
            onClick={() => onOpenFile?.(entry.path)}
            {...dragProps}
          >
            <span className="dir-tree-chevron-spacer" aria-hidden="true" />
            <FileIcon className="dir-tree-icon" />
            <span className="dir-tree-name" title={entry.name}>{entry.name}</span>
            <button
              type="button"
              className="dir-tree-reveal"
              title="在 Finder 中显示"
              aria-label="在 Finder 中显示"
              onClick={(event) => {
                event.stopPropagation();
                revealFile(entry.path);
              }}
            >
              <ChevronIcon className="dir-tree-reveal-icon" />
            </button>
            {sizeLabel(entry.size) ? <span className="dir-tree-size">{sizeLabel(entry.size)}</span> : null}
          </div>,
        );
      }
    }
    if (meta?.truncated) {
      rows.push(
        <div key={`${dirPath}:truncated`} className="dir-tree-hint" style={{ paddingLeft: 10 + (depth - 1) * 14 }}>
          已显示前 {entries.length} 项（共 {meta.total} 项）
        </div>,
      );
    }
    return rows;
  };

  const rootEntries = childrenCacheRef.current.get(rootPath);
  const rootLoading = loading.has(rootPath);
  const rootError = errors.get(rootPath);
  const rootMeta = metaCacheRef.current.get(rootPath);

  return (
    <div className="dir-tree" role="tree" aria-label="工程目录" data-tick={tick}>
      <div className="dir-tree-toolbar">
        <button
          type="button"
          className={`dir-tree-hidden-toggle${showHidden ? " on" : ""}`}
          onClick={toggleHidden}
          title="显示/隐藏以 . 开头的文件与目录"
        >
          {showHidden ? "隐藏 . 文件" : "显示 . 文件"}
        </button>
        <button type="button" className="dir-tree-refresh" onClick={refresh} title="刷新目录" aria-label="刷新目录">
          <RefreshIcon className={`icon-12${rootLoading ? " spinning" : ""}`} />
        </button>
      </div>
      <div className="dir-tree-scroll">
        {rootLoading && !rootEntries ? (
          <div className="dir-tree-hint">加载中…</div>
        ) : rootError ? (
          <div className="dir-tree-hint error">{rootError}</div>
        ) : rootEntries && rootEntries.length > 0 ? (
          renderEntries(rootEntries, 0, rootPath)
        ) : (
          <div className="dir-tree-hint">空目录</div>
        )}
        {rootMeta?.truncated ? (
          <div className="dir-tree-hint">根目录已显示前 {rootEntries?.length ?? 0} 项（共 {rootMeta.total} 项）</div>
        ) : null}
      </div>
      <div className="dir-tree-footer">点击文件预览 · 点击文件夹展开 · 拖到输入框引用</div>
    </div>
  );
});

export default DirTreeView;
