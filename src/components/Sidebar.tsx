import { useMemo, useState } from "react";
import type { SessionSummary, WorkspaceEntry } from "../types";
import { sanitizeDisplayName } from "../lib/text";
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

/** 侧边栏每个项目默认展示的会话条数，超出部分点击「加载更多」追加 */
const SESSION_PAGE_SIZE = 10;

type SidebarProps = {
  activeView: WorkspaceView;
  activeSessionId: string;
  activeProjectPath: string;
  streaming?: boolean;
  runningSessionIds?: string[];
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
  onSelectDefaultWorkspace: () => void;
  onNewConversation: (project?: WorkspaceEntry) => void;
  onSelectSession: (sessionId: string) => void;
  sessionCustomTitles?: Record<string, string>;
  onRenameSession?: (session: SessionSummary, title: string) => void;
  onDeleteSession?: (session: SessionSummary) => void;
  onProjectModalChange: (open: boolean, name?: string, editingProject?: SidebarProps["editingProject"]) => void;
  onCreateProject: () => void;
  onPickLocalProject: (parentPath: string) => void;
  onAddLocalProject: (parentPath: string) => void;
  onEditProject: (project: WorkspaceEntry) => void;
  onRenameProject: (name: string) => void;
  onRemoveProject: (project: WorkspaceEntry) => void;
  onRemoveLocalProject: (project: WorkspaceEntry) => void;
};

function sessionTitle(session: SessionSummary, customTitles?: Record<string, string>): string {
  const customTitle = [session.sessionId, session.agentId]
    .map((id) => (id && customTitles ? customTitles[id] : ""))
    .find((title) => Boolean(title && title.trim()));
  const raw = customTitle || session.title || session.lastMessage || session.agentId || session.sessionId || "未命名对话";
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

/** 移除名称中的 emoji 与特殊符号变体，避免在部分字体下渲染为占位框。 */

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
  streaming = false,
  runningSessionIds = [],
  projects,
  sessions,
  sessionProjectMap,
  creatingProject,
  projectModalOpen,
  projectName: projectModalName,
  editingProject,
  savingProject,
  onViewChange,
  onSelectDefaultWorkspace,
  onNewConversation,
  onSelectSession,
  sessionCustomTitles,
  onRenameSession,
  onDeleteSession,
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
  const [pendingDelete, setPendingDelete] = useState<WorkspaceEntry | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionSummary | null>(null);
  // 会话列表分页：每个项目默认只展示前几条，点击「加载更多」再追加
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const showMoreSessions = (path: string, step: number) => {
    setVisibleCounts((current) => ({ ...current, [path]: (current[path] ?? SESSION_PAGE_SIZE) + step }));
  };

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
    if (expandedProjects[path] !== undefined) return expandedProjects[path];
    return path === activeProjectPath || hasSessions;
  };

  const unassignedSessions = groupedSessions.get("__unassigned__") || [];
  const runningIds = useMemo(() => new Set(runningSessionIds), [runningSessionIds]);
  const isSessionRunning = (session: SessionSummary) => (
    sessionIds(session).some((id) => runningIds.has(id))
  );

  const renderSessionRow = (session: SessionSummary, showTime: boolean) => {
    const id = session.sessionId || session.agentId || "";
    const active = sessionIsActive(session, activeSessionId);
    const running = isSessionRunning(session) || (active && streaming);
    const title = sessionTitle(session, sessionCustomTitles);
    return (
      <div key={id} className={active ? "session-item active" : "session-item"}>
        <button
          type="button"
          className="session-main"
          onClick={() => onSelectSession(id)}
          title={title}
        >
          <span className="session-title">{title}</span>
        </button>
        {running ? (
          <span className="session-running-dot" title="对话进行中" aria-label="对话进行中" />
        ) : showTime && sessionTime(session) ? (
          <span className="session-time">{sessionTime(session)}</span>
        ) : null}
        <span className="session-item-actions">
          <button
            type="button"
            className="session-action-btn"
            title="重命名对话"
            aria-label={`重命名 ${title}`}
            onClick={(event) => {
              event.stopPropagation();
              setRenamingSession(session);
              setRenameDraft(title);
            }}
          >
            <EditIcon className="icon-14" />
          </button>
          <button
            type="button"
            className="session-action-btn danger"
            title="删除对话"
            aria-label={`删除 ${title}`}
            onClick={(event) => {
              event.stopPropagation();
              setPendingDeleteSession(session);
            }}
          >
            <XIcon className="icon-14" />
          </button>
        </span>
      </div>
    );
  };
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
            return (
              <div key={project.path} className="project-node">
                <div className="project-row">
                  <button
                    className="project-expander"
                    onClick={() => setExpandedProjects((current) => ({ ...current, [project.path]: !expanded }))}
                    title={expanded ? "折叠" : "展开"}
                  >
                    <ChevronIcon className={`icon-14 chevron ${expanded ? "expanded" : ""}`} />
                  </button>
                  <button className="project-main" onClick={() => setExpandedProjects((current) => ({ ...current, [project.path]: !expanded }))} title={expanded ? "折叠" : "展开"}>
                    <FolderIcon className="icon-16" />
                    <span>{sanitizeDisplayName(projectName(project))}</span>
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
                  <button className="icon-button remove-project" onClick={() => setPendingDelete(project)} title="删除项目">
                    <XIcon className="icon-14" />
                  </button>
                  {projectSessions.length > 0 ? <span className="nav-count">{projectSessions.length}</span> : null}
                </div>

                {expanded ? (
                  <div className="project-sessions">
                    {projectSessions.length === 0 ? <div className="empty-note subtle">暂无对话</div> : null}
                    {projectSessions.slice(0, visibleCounts[project.path] ?? SESSION_PAGE_SIZE).map((session) => renderSessionRow(session, true))}
                    {projectSessions.length > (visibleCounts[project.path] ?? SESSION_PAGE_SIZE) ? (
                      <button
                        type="button"
                        className="load-more-sessions"
                        onClick={() => showMoreSessions(project.path, SESSION_PAGE_SIZE)}
                      >
                        加载更多（还有 {projectSessions.length - (visibleCounts[project.path] ?? SESSION_PAGE_SIZE)} 条）
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          <div className="project-node">
            <div className="project-row">
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
                {unassignedSessions.slice(0, visibleCounts.__unassigned__ ?? SESSION_PAGE_SIZE).map((session) => renderSessionRow(session, false))}
                {unassignedSessions.length > (visibleCounts.__unassigned__ ?? SESSION_PAGE_SIZE) ? (
                  <button
                    type="button"
                    className="load-more-sessions"
                    onClick={() => showMoreSessions("__unassigned__", SESSION_PAGE_SIZE)}
                  >
                    加载更多（还有 {unassignedSessions.length - (visibleCounts.__unassigned__ ?? SESSION_PAGE_SIZE)} 条）
                  </button>
                ) : null}
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
                    className="child-project-row"
                    title={childProject.path}
                  >
                    <span className="project-main">
                      <FolderIcon className="icon-14" />
                      <span>{projectName(childProject)}</span>
                    </span>
                    <button
                      className="icon-button remove-project"
                      onClick={() => onRemoveLocalProject(childProject)}
                      title="移除工程"
                      aria-label={`移除 ${sanitizeDisplayName(projectName(childProject))}`}
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

      {pendingDelete ? (
        <div className="modal-overlay" onClick={() => setPendingDelete(null)}>
          <div className="modal confirm-modal" onClick={(event) => event.stopPropagation()}>
            <h3>删除项目</h3>
            <p>
              确定删除项目「{sanitizeDisplayName(projectName(pendingDelete))}」吗？项目目录将被删除，此操作不可恢复。
            </p>
            <div className="modal-actions">
              <div className="modal-action-group">
                <button className="ghost-action" onClick={() => setPendingDelete(null)}>取消</button>
                <button
                  className="danger-action"
                  onClick={() => {
                    onRemoveProject(pendingDelete);
                    setPendingDelete(null);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {renamingSession ? (
        <div className="modal-overlay" onClick={() => setRenamingSession(null)}>
          <div className="modal confirm-modal" onClick={(event) => event.stopPropagation()}>
            <h3>重命名对话</h3>
            <input
              value={renameDraft}
              autoFocus
              placeholder="输入新的对话名称"
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && renameDraft.trim()) {
                  onRenameSession?.(renamingSession, renameDraft.trim());
                  setRenamingSession(null);
                }
                if (event.key === "Escape") setRenamingSession(null);
              }}
            />
            <div className="modal-actions">
              <div className="modal-action-group">
                <button className="ghost-action" onClick={() => setRenamingSession(null)}>取消</button>
                <button
                  className="primary-action compact"
                  disabled={!renameDraft.trim()}
                  onClick={() => {
                    onRenameSession?.(renamingSession, renameDraft.trim());
                    setRenamingSession(null);
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDeleteSession ? (
        <div className="modal-overlay" onClick={() => setPendingDeleteSession(null)}>
          <div className="modal confirm-modal" onClick={(event) => event.stopPropagation()}>
            <h3>删除对话</h3>
            <p>
              确定删除对话「{sessionTitle(pendingDeleteSession, sessionCustomTitles)}」吗？删除后将不再显示，此操作不可恢复。
            </p>
            <div className="modal-actions">
              <div className="modal-action-group">
                <button className="ghost-action" onClick={() => setPendingDeleteSession(null)}>取消</button>
                <button
                  className="danger-action"
                  onClick={() => {
                    onDeleteSession?.(pendingDeleteSession);
                    setPendingDeleteSession(null);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
