import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronIcon,
  FileIcon,
  FilterIcon,
  FolderIcon,
  PanelCollapseIcon,
  RefreshIcon,
  SearchIcon,
  XIcon,
} from "./icons";
import { fileKindOf } from "./FilePreview";
import { fileTypeMeta } from "../lib/fileType";

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
  /** 侧边收回：收起承载目录树的面板（右侧 Dock） */
  onCollapse?: () => void;
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

/** 搜索的扫描预算：最多 readdir 次数 / 返回条数 / 递归深度（防止超大仓库卡死） */
const SEARCH_READ_BUDGET = 500;
const SEARCH_HIT_LIMIT = 200;
const SEARCH_MAX_DEPTH = 8;

/** 类型筛选档位（目录始终保留以维持层级；档位只过滤文件行） */
type TreeFilter = "all" | "dirs" | "docs" | "code" | "sheets" | "images" | "other";

const TREE_FILTERS: Array<{ id: TreeFilter; label: string }> = [
  { id: "all", label: "全部类型" },
  { id: "dirs", label: "仅文件夹" },
  { id: "docs", label: "文档（md/pdf/docx…）" },
  { id: "code", label: "代码与配置" },
  { id: "sheets", label: "表格" },
  { id: "images", label: "图片" },
  { id: "other", label: "其他文件" },
];

function fileMatchesFilter(name: string, filter: TreeFilter): boolean {
  if (filter === "all") return true;
  const kind = fileKindOf(name);
  switch (filter) {
    case "dirs":
      return false;
    case "docs":
      return kind === "markdown" || kind === "text" || kind === "docx" || kind === "pdf" || kind === "html" || kind === "drawio";
    case "code":
      return kind === "code";
    case "sheets":
      return kind === "xlsx";
    case "images":
      return kind === "image";
    case "other":
      return !["markdown", "text", "docx", "pdf", "html", "drawio", "code", "xlsx", "image"].includes(kind);
  }
}

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
 * 工具栏：收回面板 / 搜索（递归扫描 + 点击回跳定位）/ 类型筛选（含显示 . 文件）。
 */
const DirTreeView = memo(function DirTreeView({ rootPath, onOpenFile, onCollapse }: DirTreeViewProps) {
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

  // ── 搜索 ──
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DirEntryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const searchScrollRef = useRef<HTMLDivElement | null>(null);
  const [locatedPath, setLocatedPath] = useState("");

  // ── 筛选下拉 ──
  const [filter, setFilter] = useState<TreeFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);

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

  // ── 搜索：防抖后从根目录 BFS 扫描（预算内），命中当前筛选档位的条目 ──
  useEffect(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const hits: DirEntryItem[] = [];
        const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
        let reads = 0;
        while (queue.length > 0 && hits.length < SEARCH_HIT_LIMIT && reads < SEARCH_READ_BUDGET) {
          const next = queue.shift()!;
          let listing: DirListing;
          try {
            listing = await invoke<DirListing>("list_directory", {
              path: next.path,
              showHidden: hiddenFlagRef.current,
            });
          } catch {
            continue; // 无权限/已删除的目录跳过
          }
          reads += 1;
          for (const entry of listing.entries) {
            if (hits.length < SEARCH_HIT_LIMIT
              && entry.name.toLowerCase().includes(trimmed)
              && fileMatchesFilter(entry.name, filter)) {
              hits.push(entry);
            }
            if (entry.is_dir && next.depth + 1 <= SEARCH_MAX_DEPTH) {
              queue.push({ path: entry.path, depth: next.depth + 1 });
            }
          }
        }
        if (cancelled) return;
        setSearchResults(hits);
        setSearching(false);
      })();
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, rootPath, filter, showHidden, tick]);

  // 筛选下拉外点关闭
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (event: PointerEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) setFilterOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  /** 从搜索结果回跳定位：清空搜索，展开目标祖先链并滚动高亮 */
  const locateInTree = useCallback((targetPath: string, isDir: boolean) => {
    setQuery("");
    setSearchResults([]);
    const segments = targetPath.slice(rootPath.length).split("/").filter(Boolean);
    const chain: string[] = [];
    let current = rootPath;
    for (const segment of segments) {
      current = `${current}/${segment}`;
      chain.push(current);
    }
    const dirsToExpand = isDir ? chain : chain.slice(0, -1);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of dirsToExpand) next.add(dir);
      return next;
    });
    for (const dir of dirsToExpand) void loadDir(dir);
    // 等目录链渲染出来后滚动定位（两次尝试兜底 IO 延迟）
    for (const delay of [350, 900]) {
      window.setTimeout(() => {
        const container = searchScrollRef.current;
        const el = container?.querySelector(`[data-path="${CSS.escape(targetPath)}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          setLocatedPath(targetPath);
          window.setTimeout(() => setLocatedPath(""), 1600);
        }
      }, delay);
    }
  }, [rootPath, loadDir]);

  const renderSearchHits = () => {
    if (searching) return <div className="dir-tree-hint">搜索中…</div>;
    if (searchResults.length === 0) return <div className="dir-tree-hint">无匹配文件或文件夹</div>;
    return searchResults.map((hit) => {
      const relative = hit.path.startsWith(`${rootPath}/`) ? hit.path.slice(rootPath.length + 1) : hit.path;
      const parentDir = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
      const fileMeta = fileTypeMeta(hit.path);
      return (
        <div
          key={hit.path}
          className="dir-tree-row file search-hit"
          data-path={hit.path}
          title={`${hit.path}\n${hit.is_dir ? "点击在目录树中定位" : "点击预览"}`}
          role="treeitem"
          onClick={() => (hit.is_dir ? locateInTree(hit.path, true) : onOpenFile?.(hit.path))}
        >
          {fileMeta.badge ? (
            <span className="dir-tree-file-badge" style={{ color: fileMeta.color }}>{fileMeta.badge}</span>
          ) : (
            <FileIcon className="dir-tree-icon" />
          )}
          <span className="dir-tree-name" title={hit.name}>{hit.name}</span>
          {parentDir ? <span className="dir-tree-hit-dir">{parentDir}</span> : null}
          {sizeLabel(hit.size) ? <span className="dir-tree-size">{sizeLabel(hit.size)}</span> : null}
        </div>
      );
    });
  };

  const renderEntries = (entries: DirEntryItem[], depth: number, dirPath: string) => {
    const meta = metaCacheRef.current.get(dirPath);
    const rows: React.ReactNode[] = [];
    for (const entry of entries) {
      // 类型筛选：目录行始终保留（维持层级），文件行按档位过滤
      if (!entry.is_dir && !fileMatchesFilter(entry.name, filter)) continue;
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
            data-path={entry.path}
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
        // 语言徽标：按扩展名显示彩色短标（J / TS / PY …），无徽标类型回退通用文件图标
        const fileMeta = fileTypeMeta(entry.path);
        rows.push(
          <div
            key={entry.path}
            className={`dir-tree-row file${revealedPath === entry.path ? " revealed" : ""}${locatedPath === entry.path ? " located" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            role="treeitem"
            data-path={entry.path}
            onClick={() => onOpenFile?.(entry.path)}
            {...dragProps}
          >
            <span className="dir-tree-chevron-spacer" aria-hidden="true" />
            {fileMeta.badge ? (
              <span className="dir-tree-file-badge" style={{ color: fileMeta.color }}>{fileMeta.badge}</span>
            ) : (
              <FileIcon className="dir-tree-icon" />
            )}
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
  const queryTrimmed = query.trim();
  const filterDirty = filter !== "all" || showHidden;

  return (
    <div className="dir-tree" role="tree" aria-label="工程目录" data-tick={tick}>
      <div className="dir-tree-toolbar">
        {onCollapse ? (
          <button
            type="button"
            className="dir-tree-tool-btn"
            onClick={onCollapse}
            title="收回面板"
            aria-label="收回面板"
          >
            <PanelCollapseIcon className="icon-14" />
          </button>
        ) : null}
        <button
          type="button"
          className={`dir-tree-tool-btn${searchOpen ? " on" : ""}`}
          onClick={() => {
            setSearchOpen((value) => !value);
            if (searchOpen) setQuery("");
          }}
          title="搜索文件与文件夹"
          aria-label="搜索文件与文件夹"
        >
          <SearchIcon className="icon-14" />
        </button>
        <div className="dir-tree-filter" ref={filterRef}>
          <button
            type="button"
            className={`dir-tree-tool-btn${filter !== "all" ? " on" : ""}`}
            onClick={() => setFilterOpen((value) => !value)}
            title="筛选"
            aria-label="筛选"
            aria-expanded={filterOpen}
          >
            <FilterIcon className="icon-14" />
          </button>
          {filterOpen ? (
            <div className="dir-tree-filter-menu" role="menu" aria-label="筛选目录">
              <div className="dir-tree-filter-label">筛选类型</div>
              {TREE_FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={filter === item.id}
                  className={`dir-tree-filter-item${filter === item.id ? " active" : ""}`}
                  onClick={() => {
                    setFilter(item.id);
                    setFilterOpen(false);
                  }}
                >
                  <span>{item.label}</span>
                  {filter === item.id ? <span className="dir-tree-filter-check">✓</span> : null}
                </button>
              ))}
              <div className="dir-tree-filter-divider" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={showHidden}
                className={`dir-tree-filter-item${showHidden ? " active" : ""}`}
                onClick={toggleHidden}
              >
                <span>显示 . 文件</span>
                {showHidden ? <span className="dir-tree-filter-check">✓</span> : null}
              </button>
              <div className="dir-tree-filter-divider" />
              <button
                type="button"
                className="dir-tree-filter-item reset"
                disabled={!filterDirty}
                onClick={() => {
                  setFilter("all");
                  if (showHidden) toggleHidden();
                  setFilterOpen(false);
                }}
              >
                <span>重置筛选条件</span>
              </button>
            </div>
          ) : null}
        </div>
        <span className="dir-tree-toolbar-spacer" />
        <button type="button" className="dir-tree-tool-btn" onClick={refresh} title="刷新目录" aria-label="刷新目录">
          <RefreshIcon className={`icon-14${rootLoading ? " spinning" : ""}`} />
        </button>
      </div>
      {searchOpen ? (
        <div className="dir-tree-search-row">
          <SearchIcon className="icon-12 dir-tree-search-icon" />
          <input
            className="dir-tree-search-input"
            value={query}
            placeholder="搜索当前目录…"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                setSearchOpen(false);
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="dir-tree-search-clear"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
            >
              <XIcon className="icon-10" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="dir-tree-scroll" ref={searchScrollRef}>
        {queryTrimmed ? (
          renderSearchHits()
        ) : rootLoading && !rootEntries ? (
          <div className="dir-tree-hint">加载中…</div>
        ) : rootError ? (
          <div className="dir-tree-hint error">{rootError}</div>
        ) : rootEntries && rootEntries.length > 0 ? (
          renderEntries(rootEntries, 0, rootPath)
        ) : (
          <div className="dir-tree-hint">空目录</div>
        )}
        {!queryTrimmed && rootMeta?.truncated ? (
          <div className="dir-tree-hint">根目录已显示前 {rootEntries?.length ?? 0} 项（共 {rootMeta.total} 项）</div>
        ) : null}
      </div>
      <div className="dir-tree-footer">{queryTrimmed ? "点击文件夹定位 · 点击文件预览" : "点击文件预览 · 点击文件夹展开 · 拖到输入框引用"}</div>
    </div>
  );
});

export default DirTreeView;
