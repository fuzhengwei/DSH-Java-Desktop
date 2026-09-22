import { memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronIcon, FileIcon, SlidersIcon, UsersIcon, XIcon } from "./icons";

/** 顶部文件/产物 Tab 超过该数量后折叠为「下拉 + 总数」，激活 Tab 始终保排在可见区 */
const MAX_VISIBLE_TABS = 4;

const DOCK_WIDTH_STORAGE_KEY = "dsh:right-dock-width";
const DEFAULT_DOCK_WIDTH = 470;
const MIN_DOCK_WIDTH = 320;
const MAX_DOCK_WIDTH = 860;

function clampDockWidth(width: number) {
  const viewportMax = typeof window === "undefined"
    ? MAX_DOCK_WIDTH
    : Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, window.innerWidth - 360));
  return Math.min(Math.max(width, MIN_DOCK_WIDTH), viewportMax);
}

function readInitialDockWidth() {
  if (typeof window === "undefined") return DEFAULT_DOCK_WIDTH;
  const stored = Number(window.localStorage.getItem(DOCK_WIDTH_STORAGE_KEY));
  return clampDockWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_DOCK_WIDTH);
}

export type DockTab =
  | { kind: "collab"; label: string }
  | { kind: "info"; label: string }
  | { kind: "artifact"; id: string; label: string }
  | { kind: "file"; id: string; label: string };

type TabBarProps = {
  activeTab: string; // "collab" | "info" | "artifact:<id>"
  artifactTabs: Array<{ id: string; label: string; kind?: "artifact" | "file" }>;
  hasCollab: boolean;
  dockOpen: boolean;
  onSelectTab: (tab: string) => void;
  /** 协作/信息 pill 的开关行为（激活时再点收起） */
  onToggle: (tab: "collab" | "info") => void;
  onCloseArtifact: (id: string) => void;
  onClose: () => void;
};

/**
 * 顶部统一的 Dock 按钮栏：协作 / 信息 / 产物 Tab + 收起。
 * 渲染在顶栏（topbar-actions）里，替代原先分散的图标按钮与面板内 Tab 栏。
 */
export function DockTabBar({
  activeTab,
  artifactTabs,
  hasCollab,
  dockOpen,
  onSelectTab,
  onToggle,
  onCloseArtifact,
  onClose,
}: TabBarProps) {
  // 激活的产物 Tab 变化时，让它在条带内滚入视野（条带溢出滚动场景）
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const active = strip.querySelector(".right-dock-tab.active");
    if (active) {
      const stripRect = strip.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      if (rect.left < stripRect.left || rect.right > stripRect.right) {
        strip.scrollTo({ left: active instanceof HTMLElement ? active.offsetLeft - 12 : 0, behavior: "smooth" });
      }
    }
  }, [activeTab, dockOpen]);

  // Tab 折叠下拉：超过 MAX_VISIBLE_TABS 时展示，点击项切换、× 关闭
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);
  // 关掉下拉外的 Tab 后若总数回到阈值内，自动收起下拉
  useEffect(() => {
    if (moreOpen && artifactTabs.length <= MAX_VISIBLE_TABS) setMoreOpen(false);
  }, [artifactTabs.length, moreOpen]);

  // 激活 Tab 落在溢出区时把它换入可见区（挤掉末位），保证当前文件始终可见
  const overflow = artifactTabs.length > MAX_VISIBLE_TABS;
  let visibleTabs = artifactTabs;
  if (overflow) {
    const activeId = activeTab.includes(":") ? activeTab.slice(activeTab.indexOf(":") + 1) : "";
    const activeIndex = artifactTabs.findIndex((tab) => tab.id === activeId);
    visibleTabs = activeIndex >= MAX_VISIBLE_TABS
      ? [...artifactTabs.slice(0, MAX_VISIBLE_TABS - 1), artifactTabs[activeIndex]]
      : artifactTabs.slice(0, MAX_VISIBLE_TABS);
  }

  const renderTabButton = (tab: { id: string; label: string; kind?: "artifact" | "file" }) => {
    const tabId = `${tab.kind === "file" ? "file" : "artifact"}:${tab.id}`;
    const active = dockOpen && activeTab === tabId;
    return (
      <button
        key={tabId}
        type="button"
        role="tab"
        aria-selected={active}
        className={`right-dock-tab artifact${active ? " active" : ""}`}
        title={tab.label}
        onClick={() => onSelectTab(tabId)}
      >
        <FileIcon className="icon-14" />
        <span className="right-dock-tab-label">{tab.label}</span>
        <span
          className="right-dock-tab-close"
          role="button"
          aria-label={`关闭 ${tab.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onCloseArtifact(tabId);
          }}
        >
          <XIcon className="icon-10" />
        </span>
      </button>
    );
  };

  return (
    <>
      {hasCollab ? (
        <button
          type="button"
          role="tab"
          aria-selected={dockOpen && activeTab === "collab"}
          className={`right-dock-tab${dockOpen && activeTab === "collab" ? " active" : ""}`}
          onClick={() => onToggle("collab")}
        >
          <UsersIcon className="icon-14" />
          <span>协作</span>
        </button>
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={dockOpen && activeTab === "info"}
        className={`right-dock-tab${dockOpen && activeTab === "info" ? " active" : ""}`}
        onClick={() => onToggle("info")}
      >
        <SlidersIcon className="icon-14" />
        <span>信息</span>
      </button>
      {artifactTabs.length > 0 ? (
        // 产物/文件 Tab 条带：限宽 + 横向滚动，多 Tab 时不再挤压/盖住顶栏标题
        <div className="right-dock-tab-strip" role="list" ref={stripRef}>
          {visibleTabs.map(renderTabButton)}
        </div>
      ) : null}
      {overflow ? (
        <div className="dock-tab-more" ref={moreRef}>
          <button
            type="button"
            className={`right-dock-tab more${moreOpen ? " open" : ""}`}
            title="全部文件列表"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((value) => !value)}
          >
            <span className="dock-tab-more-count">{artifactTabs.length}</span>
            <ChevronIcon className="icon-10 dock-tab-more-chevron" />
          </button>
          {moreOpen ? (
            <div className="dock-tab-menu" role="listbox" aria-label="全部文件">
              {artifactTabs.map((tab) => {
                const tabId = `${tab.kind === "file" ? "file" : "artifact"}:${tab.id}`;
                const active = dockOpen && activeTab === tabId;
                return (
                  <div
                    key={tabId}
                    role="option"
                    aria-selected={active}
                    tabIndex={0}
                    className={`dock-tab-menu-item${active ? " active" : ""}`}
                    title={tab.label}
                    onClick={() => {
                      onSelectTab(tabId);
                      setMoreOpen(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectTab(tabId);
                        setMoreOpen(false);
                      }
                    }}
                  >
                    <FileIcon className="icon-14" />
                    <span className="dock-tab-menu-label">{tab.label}</span>
                    <span
                      className="right-dock-tab-close"
                      role="button"
                      aria-label={`关闭 ${tab.label}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseArtifact(tabId);
                      }}
                    >
                      <XIcon className="icon-10" />
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {dockOpen ? (
        <button
          type="button"
          className="right-dock-close"
          onClick={onClose}
          aria-label="收起侧栏"
          title="收起侧栏"
        >
          <XIcon className="icon-14" />
        </button>
      ) : null}
    </>
  );
}

type Props = {
  /** 各 Tab 的内容（由 App 按 activeTab 渲染传入） */
  children: ReactNode;
  /** 目录树 + 文件分屏模式：进入时若 Dock 过窄则自动拓宽一次，保证文件区可读 */
  splitMode?: boolean;
  /** 放大模式：铺满工具栏以下的整个窗口（文件预览「放大」） */
  maximized?: boolean;
};

/** 右侧面板：只承载内容主体；Tab 栏统一放在顶部 topbar（见 DockTabBar） */
const RightDock = memo(function RightDock({ children, splitMode, maximized }: Props) {
  const [dockWidth, setDockWidth] = useState(readInitialDockWidth);

  useEffect(() => {
    window.localStorage.setItem(DOCK_WIDTH_STORAGE_KEY, String(dockWidth));
  }, [dockWidth]);

  // 进入分屏时 Dock 不足 640px 则拓宽到 680px（只在该次进入时触发，不覆盖用户手动调整）
  const splitModeRef = useRef(false);
  useEffect(() => {
    if (splitMode && !splitModeRef.current) {
      setDockWidth((width) => (width < 640 ? clampDockWidth(680) : width));
    }
    splitModeRef.current = Boolean(splitMode);
  }, [splitMode]);

  useEffect(() => {
    const handleResize = () => setDockWidth((width) => clampDockWidth(width));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const resizeBy = (delta: number) => {
    setDockWidth((width) => clampDockWidth(width + delta));
  };

  const handleResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const handle = event.currentTarget;
    // 捕获指针：即使拖到 iframe/窗口外，事件也保证路由回边条
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // 忽略：部分环境 pointerId 已释放
    }
    const startX = event.clientX;
    const startWidth = dockWidth;

    document.body.classList.add("right-dock-resizing");

    const stopResize = () => {
      document.body.classList.remove("right-dock-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // 忽略：capture 可能已随指针释放
      }
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      // 兜底：WebView 偶发吞掉 pointerup（如鼠标在 iframe/窗口外松开），
      // 此时 buttons 已归零但仍会持续触发 move；视为松手，避免边条"跟手不放"
      if (moveEvent.buttons === 0) {
        stopResize();
        return;
      }
      setDockWidth(clampDockWidth(startWidth + startX - moveEvent.clientX));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  };

  return (
    <aside
      className={`right-dock${maximized ? " maximized" : ""}`}
      role="complementary"
      aria-label="侧栏"
      style={maximized ? undefined : { width: dockWidth }}
    >
      {maximized ? null : (
        <div
          className="right-dock-resize-handle"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_DOCK_WIDTH}
          aria-valuemax={MAX_DOCK_WIDTH}
          aria-valuenow={dockWidth}
          tabIndex={0}
          onPointerDown={handleResizeStart}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              resizeBy(24);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              resizeBy(-24);
            } else if (event.key === "Home") {
              event.preventDefault();
              setDockWidth(MAX_DOCK_WIDTH);
            } else if (event.key === "End") {
              event.preventDefault();
              setDockWidth(MIN_DOCK_WIDTH);
            }
          }}
        />
      )}
      <div className={`right-dock-body${splitMode ? " split-mode" : ""}`}>{children}</div>
    </aside>
  );
});

export default RightDock;
