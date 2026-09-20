import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DigitalHuman, SessionSummary, WorkspaceEntry } from "../types";
import { sanitizeDisplayName, truncateSessionTitle } from "../lib/text";
import { ProjectHumanAssignPopover, ProjectHumanStack, ProjectRowMenu } from "./ProjectRowMenu";
import UpdateStatusBadge from "./UpdateStatusBadge";
import {
  ChevronIcon,
  ChatDotsIcon,
  EditIcon,
  FolderIcon,
  LayersIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
  UsersIcon,
  XIcon,
} from "./icons";

export type WorkspaceView = "conversation" | "settings" | "digital-humans";

/** 侧边栏每个项目默认展示的会话条数，超出部分点击「加载更多」追加 */
const SESSION_PAGE_SIZE = 10;

type SidebarProps = {
  activeView: WorkspaceView;
  collapsed?: boolean;
  activeSessionId: string;
  activeProjectPath: string;
  streaming?: boolean;
  runningSessionIds?: string[];
  /** 未读会话（别名 id → 结束状态）：侧边栏会话行显示未读圆点 */
  unreadSessions?: Record<string, "done" | "error">;
  projects: WorkspaceEntry[];
  sessions: SessionSummary[];
  sessionProjectMap: Record<string, string>;
  sessionOrder?: Record<string, string[]>;
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
  /** 已置顶会话的全部别名 id（含后追加的），用于置顶区展示与图钉状态 */
  pinnedSessionIds?: string[];
  onTogglePinSession?: (session: SessionSummary) => void;
  onMoveSessionToProject?: (sessionIds: string[], projectPath: string) => void;
  onReorderSessions?: (dragIds: string[], targetIds: string[], projectPath: string, position?: "before" | "after") => void;
  onProjectModalChange: (open: boolean, name?: string, editingProject?: SidebarProps["editingProject"]) => void;
  onCreateProject: () => void;
  onPickLocalProject: (parentPath: string) => void;
  onAddLocalProject: (parentPath: string) => void;
  onEditProject: (project: WorkspaceEntry) => void;
  onRenameProject: (name: string) => void;
  onReorderProjects?: (dragPath: string, targetPath: string, position?: "before" | "after") => void;
  onRemoveProject: (project: WorkspaceEntry) => void;
  onRemoveLocalProject: (project: WorkspaceEntry) => void;
  /** 清空项目对话：mode="old" 只清非今日的，"all" 清空全部（含确认弹窗后的批量删除） */
  onClearProjectSessions?: (project: WorkspaceEntry, mode: "old" | "all") => void;
  /** 全部数字人（含项目归属），用于项目行头像堆叠与数量 */
  digitalHumans?: DigitalHuman[];
  /** 勾选/取消勾选：把现有数字人配置到项目（checked=false 时移出项目变全局） */
  onAssignDigitalHuman?: (humanId: string, projectPath: string, checked: boolean) => void;
  /** 浮层底部「新建数字人并归属到该项目」（打开向导，创建后归属该项目） */
  onCreateDigitalHuman?: (project: WorkspaceEntry) => void;
};

type SidebarDragState =
  | { kind: "session"; ids: string[]; label: string }
  | { kind: "project"; path: string; label: string };

type DropTargetState =
  | { kind: "project"; path: string }
  | { kind: "session"; projectPath: string; ids: string[]; position: "before" | "after" };

type DragPreviewState = {
  label: string;
  x: number;
  y: number;
};

const DEFAULT_PROJECT_DROP_TARGET = "__unassigned__";
const POINTER_DRAG_THRESHOLD = 4;

function normalizedSidebarProjectPath(value?: string): string {
  return value && value !== "default" ? value : "";
}

function sessionTitle(session: SessionSummary, customTitles?: Record<string, string>): string {
  const customTitle = [session.sessionId, session.agentId]
    .map((id) => (id && customTitles ? customTitles[id] : ""))
    .find((title) => Boolean(title && title.trim()));
  // 用户手动改过的标题原样展示；否则把 title/lastMessage 压成缩略信息
  if (customTitle && customTitle.trim()) return customTitle.trim();
  const raw = session.title || session.lastMessage || "";
  const summarized = truncateSessionTitle(
    raw
      .replace(/<hidden-context>[\s\S]*?<\/hidden-context>/gi, "")
      .replace(/\n?\[当前选择的工程\][\s\S]*$/i, ""),
  );
  return summarized || session.agentId || session.sessionId || "新对话";
}

function sessionIds(session: SessionSummary): string[] {
  return [session.sessionId, session.agentId].filter((value, index, values): value is string => (
    Boolean(value) && values.indexOf(value) === index
  ));
}

function sessionIsActive(session: SessionSummary, activeSessionId: string): boolean {
  return sessionIds(session).includes(activeSessionId);
}

/** 项目行会话数量角标：超过 99 显示 99+ */
function sessionCountLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function projectName(project: WorkspaceEntry): string {
  return project.name || project.path.split("/").filter(Boolean).pop() || "项目";
}

/** 会话是否更新于今天（本地时区自然日），用于「清空非今日对话」的筛选 */
export function sessionIsToday(session: SessionSummary): boolean {
  const value = session.updatedAt || session.createdAt;
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
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
  collapsed = false,
  activeSessionId,
  activeProjectPath,
  streaming = false,
  runningSessionIds = [],
  unreadSessions = {},
  projects,
  sessions,
  sessionProjectMap,
  sessionOrder = {},
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
  pinnedSessionIds = [],
  onTogglePinSession,
  onMoveSessionToProject,
  onReorderSessions,
  onProjectModalChange,
  onCreateProject,
  onPickLocalProject,
  onAddLocalProject,
  onEditProject,
  onRenameProject,
  onReorderProjects,
  onRemoveProject,
  onRemoveLocalProject,
  onClearProjectSessions,
  digitalHumans = [],
  onAssignDigitalHuman,
  onCreateDigitalHuman,
}: SidebarProps) {
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [pendingDelete, setPendingDelete] = useState<WorkspaceEntry | null>(null);
  // 清空项目对话的确认弹窗：记录目标项目、模式与影响条数
  const [pendingClear, setPendingClear] = useState<{ project: WorkspaceEntry; mode: "old" | "all"; count: number } | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionSummary | null>(null);
  const [dragging, setDragging] = useState<SidebarDragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  // 会话列表分页：每个项目默认只展示前几条，点击「加载更多」再追加
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const showMoreSessions = (path: string, step: number) => {
    setVisibleCounts((current) => ({ ...current, [path]: (current[path] ?? SESSION_PAGE_SIZE) + step }));
  };

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const ids = sessionIds(session);
      const hasDefaultProject = ids.some((id) => sessionProjectMap[id] === "default");
      const projectPath = hasDefaultProject
        ? "__unassigned__"
        : ids.map((id) => normalizedSidebarProjectPath(sessionProjectMap[id])).find(Boolean)
          || normalizedSidebarProjectPath(session.workspaceId)
          || "__unassigned__";
      const list = groups.get(projectPath) || [];
      list.push(session);
      groups.set(projectPath, list);
    }
    // 组内按更新时间倒序：新建/最近活跃的对话排在最上面
    const timeOf = (session: SessionSummary) => {
      const value = session.updatedAt || session.createdAt || "";
      const time = new Date(value).getTime();
      return Number.isNaN(time) ? 0 : time;
    };
    for (const [projectPath, list] of groups.entries()) {
      const projectKey = projectPath === "__unassigned__" ? "default" : projectPath;
      const orderedIds = sessionOrder[projectKey] || [];
      const orderIndex = new Map(orderedIds.map((id, index) => [id, index]));
      list.sort((a, b) => {
        const aIndex = orderIndex.get(sessionIds(a)[0] || "") ?? -1;
        const bIndex = orderIndex.get(sessionIds(b)[0] || "") ?? -1;
        if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
        // 没进过手动排序的会话（如新建对话）视为最新，排在手动排过序的会话前面
        if (aIndex >= 0) return 1;
        if (bIndex >= 0) return -1;
        return timeOf(b) - timeOf(a);
      });
    }
    return groups;
  }, [sessionOrder, sessionProjectMap, sessions]);

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

  // 项目路径 → 归属该项目的数字人（仅显式归属的，全局数字人不堆到每个项目上）
  const projectHumans = useMemo(() => {
    const map = new Map<string, DigitalHuman[]>();
    for (const human of digitalHumans) {
      if (!human.projectPath) continue;
      const list = map.get(human.projectPath) || [];
      list.push(human);
      map.set(human.projectPath, list);
    }
    return map;
  }, [digitalHumans]);

  // 数字人配置浮层：记录打开的项目路径与锚点位置（相对侧边栏）
  const [assignProjectPath, setAssignProjectPath] = useState("");
  const [assignAnchorTop, setAssignAnchorTop] = useState(0);
  const assignAnchorRef = useRef<HTMLButtonElement | null>(null);
  const projectRowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const assignCheckedIds = useMemo(() => (
    new Set(digitalHumans.filter((human) => human.projectPath === assignProjectPath).map((human) => human.id))
  ), [assignProjectPath, digitalHumans]);
  const closeAssignPopover = () => setAssignProjectPath("");
  const openAssignPopover = (project: WorkspaceEntry, anchor: HTMLButtonElement | null) => {
    // 锚点 = 该项目行的 ⋮ 按钮；用它的纵向位置固定浮层，避免被滚动裁剪
    assignAnchorRef.current = anchor;
    const sidebar = anchor?.closest(".sidebar");
    if (anchor && sidebar) {
      const top = anchor.getBoundingClientRect().bottom - sidebar.getBoundingClientRect().top + 4;
      setAssignAnchorTop(top);
    }
    setAssignProjectPath(project.path);
  };

  const unassignedSessions = groupedSessions.get("__unassigned__") || [];

  // 置顶会话：按置顶顺序（最新置顶在最前）从全部会话中解析，已删除/隐藏的自动跳过
  const pinnedIdSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);
  const isSessionPinned = (session: SessionSummary) => sessionIds(session).some((id) => pinnedIdSet.has(id));
  const pinnedSessions = useMemo(() => {
    const seen = new Set<SessionSummary>();
    const list: SessionSummary[] = [];
    for (const id of pinnedSessionIds) {
      const found = sessions.find((session) => !seen.has(session) && sessionIds(session).includes(id));
      if (found) {
        seen.add(found);
        list.push(found);
      }
    }
    return list;
  }, [pinnedSessionIds, sessions]);

  // 会话归属的项目路径：置顶区的行沿用真实归属，拖拽/选中行为与项目内一致
  const projectPathOfSessionForPinned = (session: SessionSummary) => {
    const ids = sessionIds(session);
    const hasDefaultProject = ids.some((id) => sessionProjectMap[id] === "default");
    return hasDefaultProject
      ? ""
      : ids.map((id) => normalizedSidebarProjectPath(sessionProjectMap[id])).find(Boolean)
        || normalizedSidebarProjectPath(session.workspaceId)
        || "";
  };

  const runningIds = useMemo(() => new Set(runningSessionIds), [runningSessionIds]);
  // 未读判定：会话的任意别名 id 命中未读记录即视为有新内容
  const unreadStatusOf = (session: SessionSummary): "done" | "error" | undefined => (
    sessionIds(session).map((id) => unreadSessions[id]).find(Boolean)
  );
  const isSessionRunning = (session: SessionSummary) => (
    sessionIds(session).some((id) => runningIds.has(id))
  );
  // 项目内正在运行的会话数（当前激活且正在流式输出的会话也算进行中）
  const runningCountOf = (list: SessionSummary[]) => (
    list.filter((session) => isSessionRunning(session) || (sessionIsActive(session, activeSessionId) && streaming)).length
  );

  /** 项目行角标文案：有进行中的对话时显示「进行中/总数」，否则只显示总数 */
  const projectCountBadge = (list: SessionSummary[]) => {
    const total = list.length;
    const running = runningCountOf(list);
    const unread = list.filter((session) => Boolean(unreadStatusOf(session))).length;
    const titleParts = [`${total} 个对话`];
    if (running > 0) titleParts.push(`${running} 个进行中`);
    if (unread > 0) titleParts.push(`${unread} 个未读`);
    return {
      running,
      unread,
      label: running > 0 ? `${sessionCountLabel(running)}/${sessionCountLabel(total)}` : sessionCountLabel(total),
      title: titleParts.join("，"),
    };
  };

  const suppressClickRef = useRef(false);
  const pointerDragRef = useRef<{
    state: SidebarDragState;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);

  const clearDragState = () => {
    setDragging(null);
    setDropTarget(null);
    setDragPreview(null);
    pointerDragRef.current = null;
  };

  const projectPathOfSessionIds = (ids: string[]) => (
    ids
      .map((id) => normalizedSidebarProjectPath(sessionProjectMap[id]))
      .find(Boolean) || ""
  );

  const dropTargetAt = (clientX: number, clientY: number, state: SidebarDragState): DropTargetState | null => {
    const targetSession = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-sidebar-session]");
    if (state.kind === "session" && targetSession) {
      const targetIds = (targetSession.dataset.sessionIds || "").split(",").filter(Boolean);
      const targetProjectPath = targetSession.dataset.projectPath || "";
      const sameSession = targetIds.length > 0 && state.ids.some((id) => targetIds.includes(id));
      const sameProject = projectPathOfSessionIds(state.ids) === targetProjectPath;
      if (!sameSession && sameProject) {
        const rect = targetSession.getBoundingClientRect();
        return {
          kind: "session",
          projectPath: targetProjectPath,
          ids: targetIds,
          position: clientY > rect.top + rect.height / 2 ? "after" : "before",
        };
      }
    }

    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-sidebar-drop]");
    if (!element) return null;
    const targetPath = element.dataset.projectPath || "";
    if (targetPath === DEFAULT_PROJECT_DROP_TARGET) return state.kind === "session" ? { kind: "project", path: DEFAULT_PROJECT_DROP_TARGET } : null;
    if (state.kind === "project" && state.path === targetPath) return null;
    return { kind: "project", path: targetPath };
  };

  const sameDropTarget = (left: DropTargetState | null, right: DropTargetState | null) => {
    if (!left || !right) return left === right;
    if (left.kind !== right.kind) return false;
    if (left.kind === "project" && right.kind === "project") return left.path === right.path;
    if (left.kind === "session" && right.kind === "session") {
      return left.projectPath === right.projectPath && left.position === right.position && left.ids.join(",") === right.ids.join(",");
    }
    return false;
  };

  const finishPointerDrag = (clientX: number, clientY: number) => {
    const pending = pointerDragRef.current;
    if (!pending?.active) {
      clearDragState();
      return;
    }
    const target = dropTargetAt(clientX, clientY, pending.state);
    if (!target) {
      clearDragState();
      return;
    }
    if (pending.state.kind === "session" && target.kind === "session") {
      onReorderSessions?.(pending.state.ids, target.ids, target.projectPath, target.position);
      setExpandedProjects((current) => ({ ...current, [target.projectPath]: true }));
    } else if (pending.state.kind === "session" && target.kind === "project") {
      const nextProjectPath = target.path === DEFAULT_PROJECT_DROP_TARGET ? "" : target.path;
      onMoveSessionToProject?.(pending.state.ids, nextProjectPath);
      setExpandedProjects((current) => ({ ...current, [target.path]: true }));
    } else if (pending.state.kind === "project" && target.kind === "project" && target.path !== DEFAULT_PROJECT_DROP_TARGET) {
      const dropNode = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-sidebar-drop]");
      const row = dropNode?.querySelector(".project-row");
      const rect = row?.getBoundingClientRect();
      const position = rect && clientY > rect.top + rect.height / 2 ? "after" : "before";
      onReorderProjects?.(pending.state.path, target.path, position);
    }
    clearDragState();
  };

  const startPointerDrag = (event: ReactPointerEvent<HTMLElement>, state: SidebarDragState) => {
    if (event.button !== 0) return;
    if (state.kind === "session" && !onMoveSessionToProject && !onReorderSessions) return;
    if (state.kind === "project" && !onReorderProjects) return;
    pointerDragRef.current = {
      state,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };

    const onPointerMove = (pointerEvent: PointerEvent) => {
      const pending = pointerDragRef.current;
      if (!pending) return;
      const distance = Math.hypot(pointerEvent.clientX - pending.startX, pointerEvent.clientY - pending.startY);
      if (!pending.active && distance < POINTER_DRAG_THRESHOLD) return;
      if (!pending.active) {
        pending.active = true;
        suppressClickRef.current = true;
        setDragging(pending.state);
      }
      pointerEvent.preventDefault();
      const target = dropTargetAt(pointerEvent.clientX, pointerEvent.clientY, pending.state);
      setDropTarget((current) => (sameDropTarget(current, target) ? current : target));
      setDragPreview({ label: pending.state.label, x: pointerEvent.clientX, y: pointerEvent.clientY });
    };

    const onPointerUp = (pointerEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      finishPointerDrag(pointerEvent.clientX, pointerEvent.clientY);
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };

    const onPointerCancel = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      clearDragState();
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const renderSessionRow = (session: SessionSummary, showTime: boolean, projectPath = "") => {
    const id = session.sessionId || session.agentId || "";
    const active = sessionIsActive(session, activeSessionId);
    const running = isSessionRunning(session) || (active && streaming);
    const unreadStatus = unreadStatusOf(session);
    // 当前打开的会话不显示红点：行就在屏幕上、消息流式实时渲染，不存在"没看到的新内容"。
    // 双保险——即使挂标链路因会话别名/时序误判，打开的行也不会出现红点
    const unread = Boolean(unreadStatus) && !running && !active;
    const title = sessionTitle(session, sessionCustomTitles);
    const ids = sessionIds(session);
    const sessionDropActive = dropTarget?.kind === "session" && dropTarget.ids.some((item) => ids.includes(item));
    return (
      <div
        key={id}
        className={`session-item${active ? " active" : ""}${unread ? " unread" : ""}${dragging?.kind === "session" && dragging.ids.some((item) => ids.includes(item)) ? " dragging" : ""}${sessionDropActive ? ` drop-${dropTarget.position}` : ""}`}
        data-draggable="true"
        data-sidebar-session="true"
        data-session-ids={ids.join(",")}
        data-project-path={projectPath}
        onPointerDown={(event) => {
          if (ids.length === 0) return;
          if ((event.target as HTMLElement).closest(".session-item-actions")) return;
          startPointerDrag(event, { kind: "session", ids, label: title });
        }}
      >
        <span className="session-drag-handle" aria-hidden="true">
          <svg viewBox="0 0 6 14" width="6" height="14" fill="currentColor">
            {[2, 7, 12].map((cy) =>
              [1.5, 4.5].map((cx) => (
                <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.4" />
              )),
            )}
          </svg>
        </span>
        <button
          type="button"
          className="session-main"
          onClick={(event) => {
            if (suppressClickRef.current) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onSelectSession(id);
          }}
          title={title}
        >
          <span className="session-title">{title}</span>
        </button>
        {/* 进行中：行尾呼吸灯（用户要求把呼吸灯放在会话行，项目角标只保留静态高亮）；未读红点是"跑完没看"的另一种信号 */}
        {running ? (
          <span className="session-running-dot" title="进行中" aria-label="会话进行中" />
        ) : unread ? (
          <span
            className={`session-unread-dot${unreadStatus === "error" ? " error" : ""}`}
            title={unreadStatus === "error" ? "上次执行出错，点开查看" : "有新回复"}
            aria-label={unreadStatus === "error" ? "上次执行出错，点开查看" : "有新回复"}
          />
        ) : showTime && sessionTime(session) ? (
          <span className="session-time">{sessionTime(session)}</span>
        ) : null}
        <span className="session-item-actions">
          {onTogglePinSession ? (
            <button
              type="button"
              className={`session-action-btn pin${isSessionPinned(session) ? " pinned" : ""}`}
              title={isSessionPinned(session) ? "取消置顶" : "置顶"}
              aria-label={`${isSessionPinned(session) ? "取消置顶" : "置顶"} ${title}`}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePinSession(session);
              }}
            >
              <PinIcon className="icon-14" />
            </button>
          ) : null}
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
    <aside className={`sidebar${dragging ? " dragging-sidebar" : ""}${collapsed ? " collapsed" : ""}`}>
      {dragPreview ? (
        <div
          className="sidebar-drag-preview"
          style={{ transform: `translate3d(${dragPreview.x + 12}px, ${dragPreview.y + 10}px, 0)` }}
        >
          <span className="sidebar-drag-preview-icon" aria-hidden="true" />
          <span>{sanitizeDisplayName(dragPreview.label)}</span>
        </div>
      ) : null}
      {/* 项目数字人配置浮层：固定定位在侧边栏内，锚点为触发行的 ⋮ 按钮 */}
      <ProjectHumanAssignPopover
        anchorRef={assignAnchorRef}
        open={Boolean(assignProjectPath)}
        anchorTop={assignAnchorTop}
        humans={digitalHumans}
        checkedIds={assignCheckedIds}
        onAssign={(humanId: string, checked: boolean) => onAssignDigitalHuman?.(humanId, assignProjectPath, checked)}
        onCreateNew={onCreateDigitalHuman ? () => {
          const project = topLevelProjects.find((item) => item.path === assignProjectPath);
          closeAssignPopover();
          if (project) onCreateDigitalHuman(project);
        } : undefined}
        onClose={closeAssignPopover}
      />
      <div className="brand" title="DSH Java Desktop">
        <img className="brand-mark" src="/dsh-icon.png?v=20260917" alt="DSH" />
        <div className="brand-copy">
          <div className="brand-title">
            DSH
            <UpdateStatusBadge />
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

      {!collapsed ? (
      <div className="sidebar-scroll">
        <div className="section-heading-row">
          <div className="section-heading section-heading-label">
            <PinIcon className="icon-14" />
            <span>置顶</span>
            <span className="section-count">{pinnedSessions.length}</span>
          </div>
        </div>
        <div className="pinned-list">
          {pinnedSessions.length === 0 ? (
            <div className="empty-note subtle">把对话行上的图钉点亮，即可置顶到这里。</div>
          ) : pinnedSessions.map((session) => renderSessionRow(session, true, projectPathOfSessionForPinned(session)))}
        </div>
        <div className="section-heading-row">
          <div className="section-heading section-heading-label">
            <LayersIcon className="icon-14" />
            <span>项目</span>
            <span className="section-count">{topLevelProjects.length}</span>
          </div>
          <button className="section-action" onClick={() => onProjectModalChange(true, "", null)} title="新建项目">
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
            const humansOfProject = projectHumans.get(project.path) || [];
            const projectDragActive = dragging?.kind === "project" && dragging.path === project.path;
            const projectDropActive = dropTarget?.kind === "project" && dropTarget.path === project.path;
            return (
              <div
                key={project.path}
                className={`project-node${projectDragActive ? " dragging" : ""}`}
                data-sidebar-drop="project"
                data-project-path={project.path}
              >
                <div className={`project-row${activeProjectPath === project.path ? " active" : ""}${projectDropActive ? " drop-target" : ""}`}>
                  <button
                    className="project-expander"
                    onClick={() => setExpandedProjects((current) => ({ ...current, [project.path]: !expanded }))}
                    title={expanded ? "折叠" : "展开"}
                  >
                    <ChevronIcon className={`icon-14 chevron ${expanded ? "expanded" : ""}`} />
                  </button>
                  <button
                    className="project-main"
                    data-draggable="true"
                    onPointerDown={(event) => {
                      startPointerDrag(event, { kind: "project", path: project.path, label: projectName(project) });
                    }}
                    onClick={(event) => {
                      if (suppressClickRef.current) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      setExpandedProjects((current) => ({ ...current, [project.path]: !expanded }));
                    }}
                    title={expanded ? "折叠；拖动可排序" : "展开；拖动可排序"}
                  >
                    <FolderIcon className="icon-16" />
                    <span>{projectName(project)}</span>
                  </button>
                  <ProjectHumanStack humans={humansOfProject} />
                  {projectSessions.length > 0 ? (() => {
                    const badge = projectCountBadge(projectSessions);
                    return (
                      <span className={`nav-count${badge.running > 0 ? " has-running" : ""}${badge.unread > 0 ? " has-unread" : ""}`} title={badge.title}>
                        {badge.label}
                      </span>
                    );
                  })() : null}
                  <button
                    type="button"
                    className="icon-button project-chat-button"
                    title="在当前项目创建新对话"
                    aria-label={`在 ${sanitizeDisplayName(projectName(project))} 创建新对话`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onNewConversation(project);
                    }}
                  >
                    <ChatDotsIcon className="icon-14" />
                  </button>
                  <ProjectRowMenu
                    triggerRef={(node) => projectRowRefs.current.set(project.path, node)}
                    onNewConversation={() => onNewConversation(project)}
                    onAddLocalProject={() => onAddLocalProject(project.path)}
                    onAddDigitalHuman={onAssignDigitalHuman ? () => openAssignPopover(project, projectRowRefs.current.get(project.path) || null) : undefined}
                    onEdit={() => onEditProject(project)}
                    onDelete={() => setPendingDelete(project)}
                    onClearOldSessions={onClearProjectSessions && projectSessions.some((session) => !sessionIsToday(session))
                      ? () => setPendingClear({
                          project,
                          mode: "old",
                          count: projectSessions.filter((session) => !sessionIsToday(session)).length,
                        })
                      : undefined}
                    onClearAllSessions={onClearProjectSessions && projectSessions.length > 0
                      ? () => setPendingClear({ project, mode: "all", count: projectSessions.length })
                      : undefined}
                  />
                </div>

                {expanded ? (
                  <div className="project-sessions">
                    {projectSessions.length === 0 ? <div className="empty-note subtle">暂无对话</div> : null}
                    {projectSessions.slice(0, visibleCounts[project.path] ?? SESSION_PAGE_SIZE).map((session) => renderSessionRow(session, true, project.path))}
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

          <div
            className="project-node"
            data-sidebar-drop="default"
            data-project-path={DEFAULT_PROJECT_DROP_TARGET}
          >
            <div className={`project-row${activeProjectPath === "" ? " active" : ""}${dropTarget?.kind === "project" && dropTarget.path === DEFAULT_PROJECT_DROP_TARGET ? " drop-target" : ""}`}>
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
              {unassignedSessions.length > 0 ? (() => {
                const badge = projectCountBadge(unassignedSessions);
                return (
                  <span className={`nav-count${badge.running > 0 ? " has-running" : ""}${badge.unread > 0 ? " has-unread" : ""}`} title={badge.title}>
                    {badge.label}
                  </span>
                );
              })() : null}
            </div>
            {expandedProjects.__unassigned__ ? (
              <div className="project-sessions">
                {unassignedSessions.length === 0 ? <div className="empty-note subtle">暂无对话</div> : null}
                {unassignedSessions.slice(0, visibleCounts.__unassigned__ ?? SESSION_PAGE_SIZE).map((session) => renderSessionRow(session, false, ""))}
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
      ) : null}

      <div className="sidebar-footer">
        <button className={activeView === "digital-humans" ? "footer-link active" : "footer-link"} onClick={() => onViewChange("digital-humans")}>
          <UsersIcon className="icon-16" />
          <span>数字人</span>
        </button>
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
              onChange={(event) => onProjectModalChange(true, event.target.value, editingProject)}
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

      {pendingClear ? (
        <div className="modal-overlay" onClick={() => setPendingClear(null)}>
          <div className="modal confirm-modal" onClick={(event) => event.stopPropagation()}>
            <h3>清空对话</h3>
            <p>
              确定清空项目「{sanitizeDisplayName(projectName(pendingClear.project))}」的{pendingClear.mode === "old" ? "非今日" : "全部"}对话吗？
              共 {pendingClear.count} 条对话将被删除，此操作不可恢复。
            </p>
            <div className="modal-actions">
              <div className="modal-action-group">
                <button className="ghost-action" onClick={() => setPendingClear(null)}>取消</button>
                <button
                  className="danger-action"
                  onClick={() => {
                    onClearProjectSessions?.(pendingClear.project, pendingClear.mode);
                    setPendingClear(null);
                  }}
                >
                  清空
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
