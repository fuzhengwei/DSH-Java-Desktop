import { useMemo, useState } from "react";
import type { SessionSummary, WorkspaceEntry } from "../types";
import {
  ChevronIcon,
  FolderIcon,
  FolderPlusIcon,
  EditIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from "./icons";

export type WorkspaceView = "conversation" | "settings";

type SidebarProps = {
  activeView: WorkspaceView;
  activeSessionId: string;
  activeProjectPath: string;
  projects: WorkspaceEntry[];
  sessions: SessionSummary[];
  sessionProjectMap: Record<string, string>;
  creatingProject: boolean;
  projectModalOpen: boolean;
  projectName: string;
  editingProject?: {
    path: string;
    name: string;
    local?: boolean;
  } | null;
  savingProject?: boolean;
  onViewChange: (view: WorkspaceView) => void;
  onSelectProject: (project: WorkspaceEntry) => void;
  onSelectDefaultWorkspace: () => void;
  onNewConversation: (project?: WorkspaceEntry) => void;
  onSelectSession: (sessionId: string) => void;
  onProjectModalChange: (open: boolean, name?: string, editingProject?: SidebarProps["editingProject"]) => void;
  onCreateProject: () => void;
  onPickLocalProject: (parentPath: string) => void;
  onAddLocalProject: (parentPath: string) => void;
  onEditProject: (project: WorkspaceEntry) => void;
  onRenameProject: (name: string) => void;
  onRemoveProject: (project: WorkspaceEntry) => void;
  onRemoveLocalProject: (project: WorkspaceEntry) => void;
};

function sessionTitle(session: SessionSummary): string {
  const raw = session.title || session.lastMessage || session.agentId || session.sessionId || "未命名对话";
  const withoutHiddenContext = raw
    .replace(/<hidden-context>[\s\S]*?<\/hidden-context>/gi, "")
    .replace(/\n?\[当前选择的工程\][\s\S]*$/i, "")
    .trim();
  return withoutHiddenContext || "未命名对话";
}

function sessionIds(session: SessionSummary): string[] {
  return [session.sessionId, session.agentId].filter((value, index, values): value is string => (
    Boolean(value) && values.indexOf(value) === index
  ));
}

function sessionIsActive(session: SessionSummary, activeSessionId: string): boolean {
  return sessionIds(session).includes(activeSessionId);
}

function projectName(project: WorkspaceEntry): string {
  return project.name || project.path.split("/").filter(Boolean).pop() || "项目";
}

function sessionTime(session: SessionSummary): string {
  const value = session.updatedAt || session.createdAt;
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function Sidebar({
  activeView,
  activeSessionId,
  activeProjectPath,
  projects,
  sessions,
  sessionProjectMap,
  creatingProject,
  projectModalOpen,
  projectName: projectModalName,
  editingProject,
  savingProject,
  onViewChange,
  onSelectProject,
  onSelectDefaultWorkspace,
  onNewConversation,
  onSelectSession,
  onProjectModalChange,
  onCreateProject,
  onPickLocalProject,
  onAddLocalProject,
  onEditProject,
  onRenameProject,
  onRemoveProject,
  onRemoveLocalProject,
}: SidebarProps) {
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const projectPath = sessionIds(session)
        .map((id) => sessionProjectMap[id])
        .find(Boolean) || "__unassigned__";
      const list = groups.get(projectPath) || [];
      list.push(session);
      groups.set(projectPath, list);
    }
    return groups;
  }, [sessionProjectMap, sessions]);

  const groupedLocalProjects = useMemo(() => {
    const groups = new Map<string, WorkspaceEntry[]>();
    for (const project of projects) {
      if (!project.local || !project.parentPath) continue;
      const list = groups.get(project.parentPath) || [];
      list.push(project);
      groups.set(project.parentPath, list);
    }
    return groups;
    }, [projects]);

  const topLevelProjects = useMemo(() => (
    projects.filter((project) => !project.local || !project.parentPath)
  ), [projects]);
  const editingProjectChildren = editingProject
    ? groupedLocalProjects.get(editingProject.path) || []
    : [];

  const isProjectExpanded = (path: string, hasSessions: boolean) => {
    if (path === activeProjectPath) return true;
    if (expandedProjects[path] !== undefined) return expandedProjects[path];
    return hasSessions;
  };

  const unassignedSessions = groupedSessions.get("__unassigned__") || [];
  return (
    <aside className="sidebar">
      <div className="brand" title="DSH Java Desktop">
        <img className="brand-mark" src="/dsh-icon.png" alt="DSH" />
        <div>
          <div className="brand-title">
            DSH
          </div>
          <div className="brand-subtitle">Java Desktop</div>
        </div>
      </div>

      <nav className="nav-group" aria-label="主导航">
        <button className="new-chat-button" title="开始新对话" aria-label="开始新对话" onClick={() => onNewConversation()}>
          <PlusIcon className="icon-14" />
          <span>新对话</span>
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
          {topLevelProjects.length === 0 ? (
            <div className="empty-note">还没有项目。创建后可以按项目组织对话。</div>
          ) : null}

          {topLevelProjects.map((project) => {
            const projectSessions = groupedSessions.get(project.path) || [];
            const expanded = isProjectExpanded(project.path, projectSessions.length > 0);
            const childProjects = groupedLocalProjects.get(project.path) || [];
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
                  <button className="icon-button add-project" onClick={() => onAddLocalProject(project.path)} title="添加工程">
                    <FolderPlusIcon className="icon-14" />
                  </button>
                  <button className="icon-button" onClick={() => onEditProject(project)} title="编辑项目">
                    <EditIcon className="icon-14" />
                  </button>
                  <button className="icon-button remove-project" onClick={() => onRemoveProject(project)} title="删除项目">
                    <XIcon className="icon-14" />
                  </button>
                  {projectSessions.length > 0 ? <span className="nav-count">{projectSessions.length}</span> : null}
                </div>

                {childProjects.length > 0 ? (
                  <div className="child-project-list">
                    {childProjects.map((childProject) => (
                      <div
                        key={childProject.path}
                        className={childProject.path === activeProjectPath ? "child-project-row active" : "child-project-row"}
                      >
                        <button className="project-main" onClick={() => onSelectProject(childProject)} title={childProject.path}>
                          <FolderIcon className="icon-14" />
                          <span>{projectName(childProject)}</span>
                        </button>
                        <button className="icon-button" onClick={() => onEditProject(childProject)} title="编辑工程">
                          <EditIcon className="icon-12" />
                        </button>
                        <button className="icon-button remove-project" onClick={() => onRemoveLocalProject(childProject)} title="移除工程">
                          <XIcon className="icon-14" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                {expanded ? (
                  <div className="project-sessions">
                    {projectSessions.length === 0 ? <div className="empty-note subtle">暂无对话</div> : null}
                    {projectSessions.map((session) => {
                      const id = session.sessionId || session.agentId || "";
                      return (
                        <button
                          key={id}
                          className={sessionIsActive(session, activeSessionId) ? "session-item active" : "session-item"}
                          onClick={() => onSelectSession(id)}
                        >
                          <span className="session-title">{sessionTitle(session)}</span>
                          {sessionTime(session) ? <span className="session-time">{sessionTime(session)}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}

          <div className="project-node">
            <div className={activeProjectPath === "" && activeView === "conversation" ? "project-row active" : "project-row"}>
              {unassignedSessions.length > 0 ? (
                <button
                  className="project-expander"
                  onClick={() => setExpandedProjects((current) => ({ ...current, __unassigned__: !expandedProjects.__unassigned__ }))}
                  title={expandedProjects.__unassigned__ ? "折叠" : "展开"}
                >
                  <ChevronIcon className={`icon-14 chevron ${expandedProjects.__unassigned__ ? "expanded" : ""}`} />
                </button>
              ) : (
                <span className="project-expander placeholder" aria-hidden="true" />
              )}
              <button className="project-main" onClick={onSelectDefaultWorkspace} title="切换到默认工作区">
                <FolderIcon className="icon-16" />
                <span>默认工作区</span>
              </button>
              {unassignedSessions.length > 0 ? <span className="nav-count">{unassignedSessions.length}</span> : null}
            </div>
            {expandedProjects.__unassigned__ ? (
              <div className="project-sessions">
                {unassignedSessions.length === 0 ? <div className="empty-note subtle">暂无对话</div> : null}
                {unassignedSessions.map((session) => {
                  const id = session.sessionId || session.agentId || "";
                  return (
                    <button key={id} className={sessionIsActive(session, activeSessionId) ? "session-item active" : "session-item"} onClick={() => onSelectSession(id)}>
                      <span className="session-title">{sessionTitle(session)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="sidebar-footer">
        <button className={activeView === "settings" ? "footer-link active" : "footer-link"} onClick={() => onViewChange("settings")}>
          <SettingsIcon className="icon-16" />
          <span>设置</span>
        </button>

      </div>

      {projectModalOpen ? (
        <div className="modal-overlay" onClick={() => onProjectModalChange(false)}>
          <div className="modal project-modal" onClick={(event) => event.stopPropagation()}>
            <h3>{editingProject ? "编辑项目" : "新建项目"}</h3>
            <p>{editingProject ? "修改名称后保存；本地工程仅修改显示名，不会移动磁盘目录。" : "创建新的智能体项目；创建后可在项目下添加多个本地工程文件夹。"}</p>
            <input
              value={projectModalName}
              autoFocus
              placeholder="例如：mall-admin"
              onChange={(event) => onProjectModalChange(true, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") (editingProject ? onRenameProject(projectModalName) : onCreateProject());
                if (event.key === "Escape") onProjectModalChange(false);
              }}
            />
            {editingProjectChildren.length > 0 ? (
              <div className="modal-child-project-list" aria-label="已选工程列表">
                {editingProjectChildren.map((childProject) => (
                  <div
                    key={childProject.path}
                    className={childProject.path === activeProjectPath ? "child-project-row active" : "child-project-row"}
                    title={childProject.path}
                  >
                    <button className="project-main" onClick={() => onSelectProject(childProject)}>
                      <FolderIcon className="icon-14" />
                      <span>{projectName(childProject)}</span>
                    </button>
                    <button
                      className="icon-button remove-project"
                      onClick={() => onRemoveLocalProject(childProject)}
                      title="移除工程"
                      aria-label={`移除 ${projectName(childProject)}`}
                    >
                      <XIcon className="icon-14" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="modal-actions">
              <button
                className="ghost-action"
                onClick={() => onPickLocalProject(editingProject?.path || activeProjectPath)}
              >
                选择当前项目工程
              </button>
              <div className="modal-action-group">
                <button className="ghost-action" onClick={() => onProjectModalChange(false)}>取消</button>
                <button
                  className="primary-action compact"
                  onClick={() => (editingProject ? onRenameProject(projectModalName) : onCreateProject())}
                  disabled={creatingProject || savingProject || !projectModalName.trim()}
                >
                  {creatingProject || savingProject ? "保存中…" : editingProject ? "保存" : "创建"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
