import { memo, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { FileIcon, SlidersIcon, UsersIcon, XIcon } from "./icons";

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
      {artifactTabs.map((tab) => {
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
                onCloseArtifact(`${tab.kind === "file" ? "file" : "artifact"}:${tab.id}`);
              }}
            >
              <XIcon className="icon-10" />
            </span>
          </button>
        );
      })}
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
};

/** 右侧面板：只承载内容主体；Tab 栏统一放在顶部 topbar（见 DockTabBar） */
const RightDock = memo(function RightDock({ children }: Props) {
  const [dockWidth, setDockWidth] = useState(readInitialDockWidth);

  useEffect(() => {
    window.localStorage.setItem(DOCK_WIDTH_STORAGE_KEY, String(dockWidth));
  }, [dockWidth]);

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

    const startX = event.clientX;
    const startWidth = dockWidth;

    document.body.classList.add("right-dock-resizing");

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setDockWidth(clampDockWidth(startWidth + startX - moveEvent.clientX));
    };

    const stopResize = () => {
      document.body.classList.remove("right-dock-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  };

  return (
    <aside className="right-dock" role="complementary" aria-label="侧栏" style={{ width: dockWidth }}>
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
      <div className="right-dock-body">{children}</div>
    </aside>
  );
});

export default RightDock;
