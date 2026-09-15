import { useMemo, useState } from "react";
import type { SessionSummary, WorkspaceEntry } from "../types";
import {
  BellIcon,
  ChevronIcon,
  ChatIcon,
  ClockIcon,
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  PluginIcon,
} from "./icons";

export type WorkspaceView = "conversation" | "approvals" | "plugins" | "settings" | "pulls" | "scheduled";

type SidebarProps = {
  activeView: WorkspaceView;
  activeSessionId: string;
  activeProjectPath: string;
  projects: WorkspaceEntry[];
  sessions: SessionSummary[];
  sessionProjectMap: Record<string, string>;
  approvals: RuntimeApproval[];
  plugins: PluginSummary[];
  creatingProject: boolean;
  projectModalOpen: boolean;
  projectName: string;
  onViewChange: (view: WorkspaceView) => void;
  onSelectProject: (project: WorkspaceEntry) => void;
  onNewConversation: (project?: WorkspaceEntry) => void;
  onSelectSession: (sessionId: string) => void;
  onProjectModalChange: (open: boolean, name?: string) => void;
  onCreateProject: () => void;
};

import type { PluginSummary, RuntimeApproval } from "../types";

function sessionTitle(session: SessionSummary): string {
  return session.title || session.lastMessage || session.agentId || session.sessionId || "未命名对话";
}

function projectName(project: WorkspaceEntry): string {
  return project.name || project.path.split("/").filter(Boolean).pop() || "项目";
}

export default function Sidebar({
  activeView,
  activeSessionId,
  activeProjectPath,
  projects,
  sessions,
  sessionProjectMap,
  approvals,
  plugins,
  creatingProject,
  projectModalOpen,
  projectName: projectModalName,
  onViewChange,
  onSelectProject,
  onNewConversation,
  onSelectSession,
  onProjectModalChange,
  onCreateProject,
}: SidebarProps) {
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const id = session.agentId || session.sessionId || "";
      const projectPath = sessionProjectMap[id] || "__unassigned__";
      const list = groups.get(projectPath) || [];
      list.push(session);
      groups.set(projectPath, list);
    }
    return groups;
  }, [sessionProjectMap, sessions]);

  const isProjectExpanded = (path: string, hasSessions: boolean) => {
    if (path === activeProjectPath) return true;
    if (expandedProjects[path] !== undefined) return expandedProjects[path];
    return hasSessions;
  };

  const unassignedSessions = groupedSessions.get("__unassigned__") || [];
  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-mark" src="/dsh-icon.png" alt="DSH" />
        <div>
          <div className="brand-title">DSH Desktop <span className="brand-chevron">⌄</span></div>
          <div className="brand-subtitle">cn.xiaofuge</div>
        </div>
        <div className="brand-actions">
          <button className="icon-button" title="搜索"><SearchIcon className="icon-16" /></button>
          <button className="icon-button" title="通知"><BellIcon className="icon-16" /></button>
        </div>
      </div>

      <nav className="nav-group" aria-label="主导航">
        <button className={activeView === "conversation" ? "nav-item active" : "nav-item"} onClick={() => onNewConversation()}>
          <ChatIcon className="nav-icon" />
          <span>新对话</span>
        </button>
        <button className="nav-item" onClick={() => onViewChange("pulls")}>
          <GitBranchIcon className="nav-icon" />
          <span>拉取请求</span>
        </button>
        <button className="nav-item" onClick={() => onViewChange("scheduled")}>
          <ClockIcon className="nav-icon" />
          <span>已安排</span>
        </button>
        <button className={activeView === "plugins" ? "nav-item active" : "nav-item"} onClick={() => onViewChange("plugins")}>
          <PluginIcon className="nav-icon" />
          <span>插件</span>
          {plugins.length > 0 ? <span className="nav-count">{plugins.length}</span> : null}
        </button>
      </nav>

      <div className="sidebar-scroll">
        <div className="section-heading-row">
          <div className="section-heading">项目</div>
          <button className="section-action" onClick={() => onProjectModalChange(true, "")} title="新建项目">
            <PlusIcon className="icon-15" />
          </button>
        </div>
        <div className="project-list">
          {projects.length === 0 ? (
            <div className="empty-note">还没有项目。创建后可以按项目组织对话。</div>
          ) : null}

          {projects.map((project) => {
            const projectSessions = groupedSessions.get(project.path) || [];
            const expanded = isProjectExpanded(project.path, projectSessions.length > 0);
            return (
              <div key={project.path} className="project-node">
                <div className={project.path === activeProjectPath ? "project-row active" : "project-row"}>
                  <button
                    className="project-expander"
                    onClick={() => setExpandedProjects((current) => ({ ...current, [project.path]: !expanded }))}
                    title={expanded ? "折叠" : "展开"}
                  >
                    <ChevronIcon className={`icon-14 chevron ${expanded ? "expanded" : ""}`} />
                  </button>
                  <button className="project-main" onClick={() => onSelectProject(project)}>
                    <FolderIcon className="icon-16" />
                    <span>{projectName(project)}</span>
                  </button>
                  <button className="icon-button" onClick={() => onNewConversation(project)} title="新建对话">
                    <PlusIcon className="icon-15" />
                  </button>
                </div>

                {expanded ? (
                  <div className="project-sessions">
                    {projectSessions.length === 0 ? <div className="empty-note subtle">暂无对话</div> : null}
                    {projectSessions.map((session) => {
                      const id = session.agentId || session.sessionId || "";
                      return (
                        <button
                          key={id}
                          className={id === activeSessionId ? "session-item active" : "session-item"}
                          onClick={() => onSelectSession(id)}
                        >
                          <span className="session-title">{sessionTitle(session)}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}

          {unassignedSessions.length > 0 ? (
            <div className="project-node">
              <div className={activeProjectPath === "" ? "project-row active" : "project-row"}>
                <button className="project-expander" onClick={() => setExpandedProjects((current) => ({ ...current, __unassigned__: !expandedProjects.__unassigned__ }))}>
                  <ChevronIcon className={`icon-14 chevron ${expandedProjects.__unassigned__ ? "expanded" : ""}`} />
                </button>
                <button className="project-main" onClick={() => onNewConversation()}>
                  <FolderIcon className="icon-16" />
                  <span>默认工作区</span>
                </button>
              </div>
              {expandedProjects.__unassigned__ ? (
                <div className="project-sessions">
                  {unassignedSessions.map((session) => {
                    const id = session.agentId || session.sessionId || "";
                    return (
                      <button key={id} className={id === activeSessionId ? "session-item active" : "session-item"} onClick={() => onSelectSession(id)}>
                        <span className="session-title">{sessionTitle(session)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="sidebar-footer">
        <button className={activeView === "approvals" ? "footer-link active" : "footer-link"} onClick={() => onViewChange("approvals")}>
          <ShieldIcon className="icon-16" />
          <span>审批</span>
          {approvals.length > 0 ? <span className="nav-count">{approvals.length}</span> : null}
        </button>
        <button className={activeView === "settings" ? "footer-link active" : "footer-link"} onClick={() => onViewChange("settings")}>
          <SettingsIcon className="icon-16" />
          <span>设置</span>
        </button>

      </div>

      {projectModalOpen ? (
        <div className="modal-overlay" onClick={() => onProjectModalChange(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>新建项目</h3>
            <p>项目会在智能体服务的 workspaces 目录下创建。</p>
            <input
              value={projectModalName}
              autoFocus
              placeholder="例如：mall-admin"
              onChange={(event) => onProjectModalChange(true, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCreateProject();
                if (event.key === "Escape") onProjectModalChange(false);
              }}
            />
            <div className="modal-actions">
              <button className="ghost-action" onClick={() => onProjectModalChange(false)}>取消</button>
              <button className="primary-action compact" onClick={onCreateProject} disabled={creatingProject || !projectModalName.trim()}>
                {creatingProject ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
