import { memo } from "react";
import type { ReactNode } from "react";
import { FileIcon, SlidersIcon, UsersIcon, XIcon } from "./icons";

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
  return (
    <aside className="right-dock" role="complementary" aria-label="侧栏">
      <div className="right-dock-body">{children}</div>
    </aside>
  );
});

export default RightDock;
