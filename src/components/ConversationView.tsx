import type { ApprovalMode, AvailableModel, ComposerResource, ConversationMessage, DigitalHuman, ReasoningEffort, RoomProjection, RuntimeApproval, WorkspaceEntry } from "../types";
import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfmCompatible from "../lib/remark-gfm-compatible";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDownIcon, ChevronIcon, CopyIcon, DrawIoIcon, EChartIcon, ExcelSheetIcon, FileIcon, FolderIcon, GitBranchIcon, MarkdownIcon, PlusIcon, SendIcon, ShieldIcon, StopIcon, ToolIcon, WordDocIcon, XIcon } from "./icons";
import { HumanAvatar, PRESENCE_TEXT } from "./DigitalHumanCatalog";
import { AttributionAvatar } from "./AttributionAvatar";
import { InlineFileCards, localFilePathFromHref } from "./FilePreview";
import { FileActionsArea } from "./FileActionsMenu";
import { fileTypeMeta, pathBasename, pathDirname, type LocalPathKind } from "../lib/fileType";
import { EChartBlock } from "./EChartBlock";

/** 从 React 节点树中递归提取文本（用于取 echarts 代码块源码） */
function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

type ConversationViewProps = {
  serviceReady: boolean;
  streaming: boolean;
  draft: string;
  messages: ConversationMessage[];
  activeModel?: AvailableModel;
  modelChoices: AvailableModel[];
  activeProject?: WorkspaceEntry;
  projects: WorkspaceEntry[];
  projectBranches: Record<string, string>;
  projectBranchOptions: Record<string, string[]>;
  switchingBranchPath?: string;
  streamStartedAt?: number | null;
  runDurationMs?: number | null;
  onSelectProject: (project: WorkspaceEntry) => void;
  onSelectDefaultWorkspace: () => void;
  onSwitchProjectBranch: (project: WorkspaceEntry, branch: string) => void;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  /** 输入框中 @ 引用的工程（App 侧用于拼上下文与消息展示） */
  mentions: WorkspaceEntry[];
  onMentionsChange: (projects: WorkspaceEntry[]) => void;
  sentHistory: string[];
  onHistoryEntry: (value: string) => void;
  onStopGeneration: () => void;
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onActivateModel: (channelCode: string) => void;
  onOpenSettings: () => void;
  approvals: RuntimeApproval[];
  resolvingApprovalId: string;
  onResolveApproval: (approvalId: string, verdict: "ALLOW_ONCE" | "ALLOW_SESSION" | "DENY") => void;
  /** 数字人协作：房间投影、目录、邀请与移出 */
  room?: RoomProjection | null;
  digitalHumans?: DigitalHuman[];
  /** 当前项目显式归属的数字人（用于项目胶囊上的头像叠加） */
  projectHumans?: DigitalHuman[];
  onRemoveParticipant?: (digitalHumanId: string) => void;
  /** @ 数字人提及（输入框 chips），发送时随消息一起清空 */
  humanMentions?: DigitalHuman[];
  onHumanMentionsChange?: (humans: DigitalHuman[]) => void;
  /** 执行中的数字人（其消息带归属展示） */
  activeHuman?: DigitalHuman | null;
  /** 房间协作模式：存在时替换消息区为房间事件流视图（App 负责订阅与渲染） */
  roomContent?: ReactNode;
  /** 在右侧面板打开本地文件（独立渲染） */
  onOpenFile?: (path: string) => void;
  /** 房间协作运行中：禁用输入与发送（总体停止前不可继续） */
  roomStreaming?: boolean;
  resources: ComposerResource[];
  onResourcesChange: (resources: ComposerResource[]) => void;
  onPickResourceFolder: () => void;
  onPickResourceFile: () => void;
  onAddResourceProject: (project: WorkspaceEntry) => void;
  onAddResourcePlugin: (kind: ComposerResource["pluginKind"]) => void;
};

const PLUGIN_RESOURCE_LABELS: Record<NonNullable<ComposerResource["pluginKind"]>, string> = {
  word: "Word",
  excel: "Excel",
  md: "MD",
  echart: "EChart",
  drawio: "Draw.io",
};

/** 插件专属图标：+ 菜单与资源胶囊共用，替代千篇一律的扳手 */
const PLUGIN_RESOURCE_ICONS: Record<NonNullable<ComposerResource["pluginKind"]>, ComponentType<{ className?: string }>> = {
  word: WordDocIcon,
  excel: ExcelSheetIcon,
  md: MarkdownIcon,
  echart: EChartIcon,
  drawio: DrawIoIcon,
};

function PluginIcon({ kind, className }: { kind: NonNullable<ComposerResource["pluginKind"]>; className?: string }) {
  const Icon = PLUGIN_RESOURCE_ICONS[kind] || ToolIcon;
  return <Icon className={className} />;
}

function resourceLabel(resource: ComposerResource): string {
  if (resource.kind === "plugin" && resource.pluginKind) return PLUGIN_RESOURCE_LABELS[resource.pluginKind];
  return resource.name;
}

function resourceKindLabel(resource: ComposerResource): string {
  if (resource.kind === "folder") return "文件夹";
  if (resource.kind === "file") return resource.mimeType?.startsWith("image/") ? "图片" : "文件";
  if (resource.kind === "project") return "项目";
  return "插件";
}

type TimelineItem =
  | { kind: "message"; key: string; message: ConversationMessage; asThought?: boolean }
  | { kind: "activity"; key: string; messages: ConversationMessage[] };

function activityLabel(messages: ConversationMessage[]): string {
  const failed = messages.filter((message) => message.status === "error" || message.status === "failed").length;
  const running = messages.filter((message) => message.status === "running").length;
  if (running > 0) return `正在执行 ${messages.length} 步`;
  if (failed > 0) return `执行过程 · ${messages.length} 步 · ${failed} 失败`;
  return `执行过程 · ${messages.length} 步`;
}

function toolTitle(message: ConversationMessage): string {
  const running = message.status === "running";
  const failed = message.status === "error" || message.status === "failed";
  const prefix = failed ? "执行失败" : running ? "正在" : "已";

  if (message.toolName === "fs_read") return `${prefix}读取文件`;
  if (message.toolName === "fs_write") return `${prefix}修改文件`;
  if (message.toolName === "fs_list" || message.toolName === "fs_tree") return `${prefix}查看目录`;
  if (message.toolName === "shell_execute") return `${prefix}执行命令`;
  if (message.toolName === "web_search") return `${prefix}搜索网络`;
  if (message.toolName === "web_fetch") return `${prefix}读取网页`;
  if (message.toolName === "ask_user_question") return failed ? "提问失败" : running ? "等待回答" : "已回答";
  return `${prefix}执行 ${message.toolName || "工具"}`;
}

function toolDetail(message: ConversationMessage): string {
  const argument = message.arguments?.path
    ?? message.arguments?.command
    ?? message.arguments?.query
    ?? message.arguments?.url;
  return typeof argument === "string" && argument.trim() ? argument.trim() : "";
}

/** 从消息参数中提取文件路径（兼容常见字段名），返回 { base, dir }。 */
function toolFilePath(message: ConversationMessage): { base: string; dir: string } | null {
  const args = message.arguments || {};
  const raw = args.path ?? args.file_path ?? args.file ?? args.target ?? args.filename;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const normalized = raw.trim();
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const base = segments[segments.length - 1] || normalized;
  const dir = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
  return { base, dir };
}

/** 从工具结果中解析 diff 统计（形如 "+10 -19"、"lines added: 10" 等）。 */
function toolDiffStats(message: ConversationMessage): { add: number; del: number } | null {
  const text = message.result || "";
  if (!text) return null;
  const plusMinus = text.match(/\+(\d+)\s*[-−]\s*(\d+)/);
  if (plusMinus) return { add: Number(plusMinus[1]), del: Number(plusMinus[2]) };
  const added = text.match(/(?:added|新增|inserted)[^\d]*(\d+)/i);
  const removed = text.match(/(?:removed|deleted|删除)[^\d]*(\d+)/i);
  if (added || removed) {
    return { add: added ? Number(added[1]) : 0, del: removed ? Number(removed[1]) : 0 };
  }
  return null;
}

function isEditTool(toolName?: string): boolean {
  return /^(fs_write|str_replace_editor|edit_file|write_file)$/i.test(toolName || "");
}

function toolIconName(message: ConversationMessage): "edit" | "read" | "command" | "search" | "web" | "list" | "tool" {
  const name = (message.toolName || "").toLowerCase();
  if (isEditTool(message.toolName)) return "edit";
  if (name === "fs_read") return "read";
  if (name === "fs_list" || name === "fs_tree") return "list";
  if (name === "shell_execute") return "command";
  if (name === "web_search") return "search";
  if (name === "web_fetch") return "web";
  return "tool";
}

function activityState(messages: ConversationMessage[]): "running" | "error" | "done" {
  if (messages.some((message) => message.status === "running")) return "running";
  if (messages.some((message) => message.status === "error" || message.status === "failed")) return "error";
  return "done";
}

function activityKey(message: ConversationMessage, index: number): string {
  return message.callId || `${message.toolName || "tool"}-${index}`;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

/** 输入中的触发词：光标前最后一个 @ 开始的连续非空白片段（不含空格，支持中文） */
function detectMentionTrigger(value: string, caret: number): { start: number; query: string } | null {
  const beforeCaret = value.slice(0, caret);
  const atIndex = beforeCaret.lastIndexOf("@");
  if (atIndex < 0) return null;
  const query = beforeCaret.slice(atIndex + 1);
  if (/[\s@​]/.test(query)) return null;
  return { start: atIndex, query };
}

function messageTokenCount(message: ConversationMessage): number {
  const argumentText = message.arguments ? JSON.stringify(message.arguments) : "";
  return estimateTokens([message.content, message.reasoning, message.result, argumentText]
    .filter((value): value is string => typeof value === "string" && Boolean(value))
    .join("\n"));
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatMessageTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(value: number): string {
  if (value < 1000) return "不到 1 秒";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours} 小时 ${minuteRemainder} 分` : `${hours} 小时`;
}

function activitySummary(messages: ConversationMessage[]): string {
  const counts = new Map<string, number>();
  messages.forEach((message) => {
    const key = message.toolName || "tool";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].map(([toolName, count]) => {
    const label = toolTitle({ toolName, status: "success" } as ConversationMessage);
    return count > 1 ? `${label} ×${count}` : label;
  }).join(" · ");
}

function editedFiles(messages: ConversationMessage[]): string[] {
  const files = messages
    .filter((message) => message.role === "tool" && isEditTool(message.toolName))
    .map((message) => {
      const args = message.arguments || {};
      const path = args.path ?? args.file_path ?? args.file ?? args.target ?? args.filename;
      return typeof path === "string" && path.trim() ? path.trim() : "";
    })
    .filter(Boolean);
  return [...new Set(files)];
}

/** 本轮文件产物标签列表：异步判定每个路径的真实类型（文件 / 文件夹 / 失效），按类型决定图标与点击行为。 */
function RunSummaryFiles({ files, onOpenFile }: { files: string[]; onOpenFile?: (path: string) => void }) {
  const [kinds, setKinds] = useState<Record<string, LocalPathKind>>({});
  const signature = files.join("\n");

  useEffect(() => {
    const list = signature ? signature.split("\n") : [];
    if (list.length === 0) return;
    let cancelled = false;
    invoke<(LocalPathKind | null)[]>("local_path_kinds", { paths: list })
      .then((result) => {
        if (cancelled) return;
        const next: Record<string, LocalPathKind> = {};
        list.forEach((file, index) => {
          next[file] = result[index] ?? "missing";
        });
        setKinds(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signature]);

  // 目录若同时是其他产物的上级目录，视为过程性路径（如只写了 Desktop），不单独展示
  const visible = files.filter((file) => {
    if (kinds[file] !== "dir") return true;
    const prefix = file.endsWith("/") || file.endsWith("\\") ? file : `${file}/`;
    return !files.some((other) => other !== file && other.startsWith(prefix));
  });

  return (
    <ul className="run-summary-file-list">
      {visible.map((file) => (
        <RunFileChip key={file} file={file} kind={kinds[file] ?? "file"} onOpenFile={onOpenFile} />
      ))}
    </ul>
  );
}

function RunFileChip({ file, kind, onOpenFile }: { file: string; kind: LocalPathKind; onOpenFile?: (path: string) => void }) {
  const meta = fileTypeMeta(file, kind === "dir" ? "dir" : undefined);
  const Icon = meta.Icon;
  const missing = kind === "missing";
  const base = pathBasename(file);
  const dir = pathDirname(file);

  const handleClick = () => {
    if (missing) return;
    // 文件夹点击直接在文件管理器打开；文件优先走右侧预览
    if (kind === "dir" || !onOpenFile) {
      void invoke("open_local_file", { path: file }).catch((error) => {
        console.error("打开路径失败:", error);
      });
      return;
    }
    onOpenFile(file);
  };

  const hint = missing
    ? "路径不存在或已被移动"
    : kind === "dir"
      ? "文件夹 · 点击打开 · 右键更多操作"
      : `${meta.kindLabel} · 点击预览 · 右键更多操作`;
  const title = `${file}\n${hint}`;

  return (
    <li>
      <FileActionsArea path={file}>
        <button
          type="button"
          className={`run-summary-file-chip kind-${kind}`}
          title={title}
          onClick={handleClick}
        >
          <span className="run-summary-file-icon" style={{ color: meta.color }}>
            <Icon className="run-summary-file-svg" />
          </span>
          <span className="run-summary-file-name">{base}</span>
          {missing ? <span className="run-summary-file-state">未找到</span> : null}
          {dir ? <span className="run-summary-file-dir">{dir}</span> : null}
        </button>
      </FileActionsArea>
    </li>
  );
}

/** 找到本轮对话最后一条 AI 回复（不是作为中间思考展示的），用于在尾部挂本轮小结。 */
function findLastAssistantIndex(messages: ConversationMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const isThought = message.role === "assistant" && messages[i + 1]?.role === "tool";
    if (!isThought) return i;
  }
  return -1;
}

async function copyMessageText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
  }
  return false;
}

export default function ConversationView({
  serviceReady,
  streaming,
  draft,
  messages,
  activeModel,
  modelChoices,
  activeProject,
  projects,
  projectBranches,
  projectBranchOptions,
  switchingBranchPath,
  streamStartedAt,
  runDurationMs,
  onSelectProject,
  onSelectDefaultWorkspace,
  onSwitchProjectBranch,
  onDraftChange,
  onSend,
  mentions: mentionsProp,
  onMentionsChange,
  sentHistory,
  onHistoryEntry,
  onStopGeneration,
  approvalMode,
  onApprovalModeChange,
  reasoningEffort,
  onReasoningEffortChange,
  onActivateModel,
  onOpenSettings,
  approvals,
  resolvingApprovalId,
  onResolveApproval,
  room = null,
  digitalHumans = [],
  projectHumans = [],
  onRemoveParticipant,
  humanMentions = [],
  onHumanMentionsChange,
  activeHuman = null,
  roomContent = null,
  onOpenFile,
  roomStreaming = false,
  resources,
  onResourcesChange,
  onPickResourceFolder,
  onPickResourceFile,
  onAddResourceProject,
  onAddResourcePlugin,
}: ConversationViewProps) {
  // 房间协作模式下即使会话消息为空也按对话态渲染（消息由事件流提供）
  const isHome = messages.length === 0 && !roomContent;

  const messageListRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [canJumpLatest, setCanJumpLatest] = useState(false);
  const [roomStatusStartedAt, setRoomStatusStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // 项目没有任何数字人时，历史消息里残留的归属信息也一并隐藏
  const showAttribution = digitalHumans.length > 0;
  // 输入历史：historyCursor 指向 sentHistory 下标，history.length 表示未进入浏览状态
  const [historyCursor, setHistoryCursorState] = useState(sentHistory.length);
  const historyCursorRef = useRef(sentHistory.length);
  const setHistoryCursor = (value: number) => {
    historyCursorRef.current = value;
    setHistoryCursorState(value);
  };
  const draftBackupRef = useRef("");
  const [localDraft, setLocalDraft] = useState(draft);
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false);
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(localDraft);
  const lastCommittedDraftRef = useRef(draft);
  draftRef.current = localDraft;

  const commitDraft = (value: string) => {
    draftRef.current = value;
    lastCommittedDraftRef.current = value;
    setLocalDraft(value);
    onDraftChange(value);
  };

  useEffect(() => {
    if (draft === lastCommittedDraftRef.current) return;
    draftRef.current = draft;
    lastCommittedDraftRef.current = draft;
    setLocalDraft(draft);
  }, [draft]);

  useEffect(() => {
    if (!resourceMenuOpen && !projectMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (resourceMenuRef.current && !resourceMenuRef.current.contains(target)) {
        setResourceMenuOpen(false);
      }
      if (projectMenuRef.current && !projectMenuRef.current.contains(target)) {
        setProjectMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setResourceMenuOpen(false);
        setProjectMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [resourceMenuOpen, projectMenuOpen]);

  const runResourceAction = (action: () => void) => {
    setResourceMenuOpen(false);
    action();
  };

  const runProjectAction = (action: () => void) => {
    setProjectMenuOpen(false);
    action();
  };

  const removeResource = (resource: ComposerResource) => {
    onResourcesChange(resources.filter((item) => item.id !== resource.id));
  };
  const sentHistoryRef = useRef(sentHistory);
  sentHistoryRef.current = sentHistory;
  const historyBrowsing = historyCursor < sentHistory.length;

  // ---- @ 工程提及 ----
  // draft 中的 @工程名 在输入框渲染为标签；确认选择/删词/手动输入/历史恢复都会同步到 mentionChips
  const [mentionChips, setMentionChips] = useState<WorkspaceEntry[]>([]);
  const [mentionTrigger, setMentionTrigger] = useState<{ start: number; query: string } | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef(mentionChips);
  chipsRef.current = mentionChips;
  const mentionTriggerRef = useRef(mentionTrigger);
  mentionTriggerRef.current = mentionTrigger;

  // 可供 @ 提及的候选：仅当前项目下挂载的本地工程文件夹
  const mentionCandidates = useMemo(() => projects.filter((project) => (
    project.local && project.parentPath === activeProject?.path
  )), [activeProject, projects]);

  // 可 @ 的数字人：已入房间时取房间参与者；未入房间时取当前项目配置的数字人
  // （项目配置数字人 = 第一优先级使用，无需先加入房间即可 @ 指派）
  const humanMentionCandidates = useMemo(() => {
    if (room) {
      const joinedIds = new Set(room.participants.map((p) => p.digitalHumanId));
      return digitalHumans.filter((human) => joinedIds.has(human.id));
    }
    return projectHumans;
  }, [digitalHumans, room, projectHumans]);

  const roomHumans = useMemo(() => {
    if (!room) return [];
    return room.participants
      .map((participant) => digitalHumans.find((human) => human.id === participant.digitalHumanId) || null)
      .filter((human): human is DigitalHuman => Boolean(human));
  }, [digitalHumans, room]);

  // 候选工程变化（切项目/增删工程）时刷新标签对应的工程信息，丢弃已不存在的
  useEffect(() => {
    setMentionChips((current) => current
      .map((chip) => mentionCandidates.find((project) => project.path === chip.path) || null)
      .filter((chip): chip is WorkspaceEntry => Boolean(chip)));
  }, [mentionCandidates]);

  const mentionResults = useMemo(() => {
    if (!mentionTrigger) return [];
    const query = mentionTrigger.query.trim().toLowerCase();
    return mentionCandidates.filter((project) => (
      !mentionChips.some((chip) => chip.path === project.path)
      && (!query || project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query))
    ));
  }, [mentionCandidates, mentionChips, mentionTrigger]);

  const humanMentionResults = useMemo(() => {
    if (!mentionTrigger) return [];
    const query = mentionTrigger.query.trim().toLowerCase();
    return humanMentionCandidates.filter((human) => (
      !humanMentions.some((item) => item.id === human.id)
      && (!query || human.displayName.toLowerCase().includes(query) || human.purpose.toLowerCase().includes(query))
    ));
  }, [humanMentionCandidates, humanMentions, mentionTrigger]);

  const mentionTotalCount = humanMentionResults.length + mentionResults.length;

  // 候选为空（项目未挂载工程且房间无数字人 / 默认工作区）时不弹层，@ 视为普通字符，避免"弹个空框"
  const mentionOpen = Boolean(
    mentionTrigger && !mentionDismissed && !streaming
    && (mentionCandidates.length > 0 || humanMentionCandidates.length > 0)
    && mentionTotalCount > 0,
  );
  const mentionOpenRef = useRef(mentionOpen);
  mentionOpenRef.current = mentionOpen;

  // 标签变化同步给 App（发送时拼上下文、存到消息上）
  useEffect(() => {
    onMentionsChange(mentionChips);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionChips]);

  // 引用标签只展示在输入框上方的横条里（.mention-banner），输入框正文保持干净，
  // 不再用盖在 textarea 上的覆盖层（此前覆盖层会挡住输入，已废弃）

  // App 侧外部清空（如发送成功后）
  useEffect(() => {
    if (mentionsProp.length === 0 && chipsRef.current.length > 0) {
      setMentionChips([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionsProp]);

  useEffect(() => {
    setMentionActiveIndex(0);
  }, [mentionTrigger?.start, mentionTrigger?.query]);

  useEffect(() => {
    if (!mentionOpen) return;
    const list = mentionListRef.current;
    const active = list?.querySelector(".mention-item.active");
    if (active instanceof HTMLElement) active.scrollIntoView({ block: "nearest" });
  }, [mentionActiveIndex, mentionOpen]);

  const closeMention = () => setMentionTrigger(null);

  /** 从弹层确认一个工程：把触发词 @xxx 从输入框移除（标签体现在上方横条里），登记标签，光标归位 */
  const confirmMention = (project: WorkspaceEntry) => {
    const trigger = mentionTriggerRef.current;
    const textarea = textareaRef.current;
    if (!trigger) return;
    const value = draftRef.current;
    const caret = textarea ? textarea.selectionStart : value.length;
    // 删掉 "@query" 触发词，输入框只留用户真正要发的正文
    const next = (value.slice(0, trigger.start) + value.slice(caret)).replace(/ {2,}/g, " ");
    const caretAfter = Math.min(trigger.start, next.length);
    setMentionChips((current) => (
      current.some((chip) => chip.path === project.path) ? current : [...current, project]
    ));
    setMentionTrigger(null);
    setMentionDismissed(false);
    commitDraft(next);
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (target) {
        target.focus();
        target.selectionStart = caretAfter;
        target.selectionEnd = caretAfter;
      }
    });
  };

  /** 从弹层确认一个数字人：触发词同样从输入框移除，chips 交给 App 侧管理 */
  const confirmHumanMention = (human: DigitalHuman) => {
    const trigger = mentionTriggerRef.current;
    const textarea = textareaRef.current;
    if (!trigger) return;
    const value = draftRef.current;
    const caret = textarea ? textarea.selectionStart : value.length;
    const next = (value.slice(0, trigger.start) + value.slice(caret)).replace(/ {2,}/g, " ");
    const caretAfter = Math.min(trigger.start, next.length);
    if (!humanMentions.some((item) => item.id === human.id)) {
      onHumanMentionsChange?.([...humanMentions, human]);
    }
    setMentionTrigger(null);
    setMentionDismissed(false);
    commitDraft(next);
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (target) {
        target.focus();
        target.selectionStart = caretAfter;
        target.selectionEnd = caretAfter;
      }
    });
  };

  const removeMentionChip = (project: WorkspaceEntry) => {
    // 标签只存在 chips 状态里（输入框正文不含 @名称），直接从 chips 删除即可
    setMentionChips((current) => current.filter((chip) => chip.path !== project.path));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /** 浏览/恢复历史草稿时清空引用标签（历史正文是干净的，标签归属当时那条消息，不带回新草稿） */
  const clearMentions = () => setMentionChips([]);

  const exitHistoryBrowsing = () => {
    setHistoryCursor(sentHistoryRef.current.length);
  };

  const setDraftAndCaret = (value: string) => {
    commitDraft(value);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        const caret = value.length;
        textarea.selectionStart = caret;
        textarea.selectionEnd = caret;
        textarea.scrollTop = textarea.scrollHeight;
      }
    });
  };

  /** ↑ 键：往更早的历史翻。仅在“输入框为空 / 已在浏览历史 / 光标在第一行行首”时触发。 */
  const recallHistory = (textarea: HTMLTextAreaElement, forward: boolean): boolean => {
    const history = sentHistoryRef.current;
    if (history.length === 0) return false;
    const browsing = historyCursorRef.current < history.length;
    if (!browsing) {
      const empty = draftRef.current.trim() === "";
      const atEdge = forward
        ? textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length
        : textarea.selectionStart === 0 && textarea.selectionEnd === 0 && !textarea.value.slice(0, textarea.selectionStart).includes("\n");
      if (!empty && !atEdge) return false;
      // 进入浏览前备份当前草稿，↓ 到底时恢复
      draftBackupRef.current = draftRef.current;
    }

    let next = forward ? historyCursorRef.current + 1 : historyCursorRef.current - 1;
    if (forward && next >= history.length) {
      // 翻过最新一条：恢复备份的草稿并退出浏览，同时恢复草稿对应的标签
      setHistoryCursor(history.length);
      setDraftAndCaret(draftBackupRef.current);
      clearMentions();
      return true;
    }
    next = Math.max(0, Math.min(history.length - 1, next));
    if (next === historyCursorRef.current) return browsing; // 已到端点，浏览中也要拦截默认行为
    setHistoryCursor(next);
    setDraftAndCaret(history[next]);
    clearMentions();
    return true;
  };

  const openExternal = (url: string) => {
    invoke("open_external", { url }).catch((error) => {
      console.error("打开外部链接失败:", error);
    });
  };

  const markdownComponents = useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: ReactNode }) => (
      <a
        href={href}
        onClick={(event) => {
          const localFilePath = localFilePathFromHref(href);
          if (localFilePath && onOpenFile) {
            event.preventDefault();
            onOpenFile(localFilePath);
            return;
          }
          if (href) {
            event.preventDefault();
            openExternal(href);
          }
        }}
      >
        {children}
      </a>
    ),
    // ```echarts 代码块：渲染为 ECharts 图表
    pre: ({ children }: { children?: ReactNode }) => {
      // react-markdown 会把 code 包在 pre 里；从中取出 language 与源码
      const child = Array.isArray(children) ? children[0] : children;
      const className = (child as { props?: { className?: string } })?.props?.className || "";
      const match = /language-(\w+)/.exec(className);
      if (match && match[1] === "echarts") {
        const raw = extractText(child);
        const code = raw.trim();
        if (code.startsWith("{")) return <EChartBlock code={code} />;
      }
      return <pre>{children}</pre>;
    },
  }), [onOpenFile]);

  const renderMarkdown = (value: string) => (
    <ReactMarkdown remarkPlugins={[remarkGfmCompatible]} components={markdownComponents}>
      {value}
    </ReactMarkdown>
  );

  const lastMessage = messages[messages.length - 1];
  const sendFromComposer = () => {
    // 去掉草稿中的零宽空格（@ 标签的内嵌边界字符），再入库/发送
    const text = draftRef.current.replace(/​/g, "").trim();
    exitHistoryBrowsing();
    if (text) onHistoryEntry(text);
    closeMention();
    onSend();
  };
  const runningTool = [...messages].reverse().find((message) => (
    message.role === "tool" && message.status === "running"
  ));
  const isThinking = Boolean(lastMessage?.role === "assistant" && lastMessage.reasoning && !lastMessage.content);
  const runningLabel = runningTool
    ? (runningTool.toolName === "ask_user_question" ? "等待你的回答" : `工具 · ${runningTool.toolName || "Tool"}`)
    : isThinking ? "思考中" : "生成中";
  const roomStatusHumans = roomStreaming
    ? (humanMentions.length > 0 ? humanMentions : roomHumans.length > 0 ? roomHumans : projectHumans)
    : [];
  const roomStatusHumanLabel = roomStatusHumans.length === 0
    ? "数字人协作中"
    : roomStatusHumans.length === 1
      ? `${roomStatusHumans[0].displayName} · 协作中`
      : `${roomStatusHumans.slice(0, 2).map((human) => human.displayName).join("、")}${roomStatusHumans.length > 2 ? ` 等 ${roomStatusHumans.length} 位` : ""} · 协作中`;

  useEffect(() => {
    if (!streaming && !roomStreaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [roomStreaming, streaming]);

  useEffect(() => {
    if (roomStreaming) {
      setRoomStatusStartedAt((current) => current || Date.now());
      return;
    }
    setRoomStatusStartedAt(null);
  }, [roomStreaming]);

  const elapsedSeconds = streaming && streamStartedAt
    ? Math.max(0, Math.floor((now - streamStartedAt) / 1_000))
    : 0;
  const roomElapsedSeconds = roomStreaming && roomStatusStartedAt
    ? Math.max(0, Math.floor((now - roomStatusStartedAt) / 1_000))
    : 0;
  const usedTokens = messages.reduce((sum, message) => sum + messageTokenCount(message), 0);
  const contextLimit = 128_000;
  const contextPercent = Math.min(100, (usedTokens / contextLimit) * 100);
  const contextTooltip = `${contextPercent.toFixed(1)}% · ${formatTokens(usedTokens)} / ${formatTokens(contextLimit)} 上下文已使用`;
  useEffect(() => {
    if (messageListRef.current && followOutputRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  const scrollToBottom = () => {
    followOutputRef.current = true;
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    });
  };

  const timelineItems = useMemo<TimelineItem[]>(() => {
    // 基于"原始消息数组"判断中间消息（下一条是 tool），而不是过滤后的列表，
    // 这样过程中的文字在任何一步都能稳定折叠保留，不会随渲染状态变化而消失。
    const items = messages.reduce<TimelineItem[]>((nextItems, message, index) => {
      if (message.role === "tool") {
        const previous = nextItems[nextItems.length - 1];
        if (previous?.kind === "activity") {
          previous.messages.push(message);
          return nextItems;
        }
        nextItems.push({ kind: "activity", key: activityKey(message, index), messages: [message] });
        return nextItems;
      }

      const reasoning = message.reasoning?.trim() || "";
      const content = message.content.trim();
      const isLast = index === messages.length - 1;
      const hasAnything = Boolean(reasoning || content);
      // 跳过完全为空的消息项（流式占位除外），避免空 article 产生多余间距
      if (!hasAnything && !(isLast && (streaming || roomStreaming))) return nextItems;

      nextItems.push({
        kind: "message",
        key: `${message.role}-${index}-${message.callId || message.createdAt || "message"}`,
        message,
        asThought: message.role === "assistant"
          && messages[index + 1]?.role === "tool"
          && !content,
      });
      return nextItems;
    }, []);
    const lastItem = items[items.length - 1];
    const hasVisiblePendingAssistant = lastItem?.kind === "message"
      && lastItem.message.role === "assistant"
      && !lastItem.message.reasoning?.trim()
      && !lastItem.message.content.trim();
    const waitingForFirstAssistantChunk = (streaming || roomStreaming)
      && messages.length > 0
      && messages[messages.length - 1]?.role === "user";
    if (waitingForFirstAssistantChunk && !hasVisiblePendingAssistant) {
      items.push({
        kind: "message",
        key: "assistant-pending-placeholder",
        message: { role: "assistant", content: "" },
      });
    }
    return items;
  }, [messages, roomStreaming, streaming]);

  const renderComposer = (variant: "hero" | "chat") => (
    <>
      {variant === "chat" && (streaming || roomStreaming) ? (
        <div className="conversation-status">
          {streaming && activeHuman ? (
            <span className="msg-attribution-avatar" style={{ background: activeHuman.themeColor, width: 18, height: 18, fontSize: 10 }}>
              {activeHuman.avatarRef}
            </span>
          ) : roomStreaming && roomStatusHumans.length > 0 ? (
            <span
              className="conversation-status-humans"
              title={`参与数字人：${roomStatusHumans.map((human) => human.displayName).join("、")}`}
            >
              {roomStatusHumans.slice(0, 3).map((human) => (
                <span key={human.id} className="conversation-status-human">
                  <HumanAvatar human={human} size={16} />
                </span>
              ))}
              {roomStatusHumans.length > 3 ? <span className="conversation-status-more">+{roomStatusHumans.length - 3}</span> : null}
            </span>
          ) : (
            <span className="conversation-status-dot" />
          )}
          <span className="conversation-status-label">
            {streaming
              ? (activeHuman ? `${activeHuman.displayName} · ${runningLabel}` : runningLabel)
              : `${roomStatusHumanLabel} · 等待调度`}
            {streaming && elapsedSeconds > 0 ? ` · ${elapsedSeconds}s` : ""}
            {!streaming && roomElapsedSeconds > 0 ? ` · ${roomElapsedSeconds}s` : ""}
          </span>
        </div>
      ) : null}
      {approvals.length > 0 ? (
        <div className="runtime-approval" aria-live="polite">
          <div className="runtime-approval-main">
            {activeHuman ? (
              <div className="msg-attribution" style={{ marginBottom: 6 }}>
                <span className="msg-attribution-avatar" style={{ background: activeHuman.themeColor, width: 18, height: 18, fontSize: 10 }}>
                  {activeHuman.avatarRef}
                </span>
                <span className="msg-attribution-name">{activeHuman.displayName} 请求确认</span>
              </div>
            ) : null}
            <strong>{approvals[0].toolName || "Tool"}</strong>
            <pre>
              {approvals[0].displayCommand
                || JSON.stringify(approvals[0].arguments || {}, null, 2)}
            </pre>
          </div>
          <div className="runtime-approval-actions">
            <button
              className="primary-action compact"
              disabled={Boolean(resolvingApprovalId)}
              onClick={() => onResolveApproval(approvals[0].approvalId, "ALLOW_ONCE")}
            >
              {resolvingApprovalId === approvals[0].approvalId ? "处理中…" : "允许一次"}
            </button>
            <button
              className="primary-action compact"
              disabled={Boolean(resolvingApprovalId)}
              onClick={() => onResolveApproval(approvals[0].approvalId, "ALLOW_SESSION")}
            >
              本次对话允许
            </button>
            <button
              className="ghost-action compact"
              disabled={Boolean(resolvingApprovalId)}
              onClick={() => onResolveApproval(approvals[0].approvalId, "DENY")}
            >
              拒绝
            </button>
          </div>
        </div>
      ) : null}
      <div className={variant === "hero" ? "prompt-shell hero" : "prompt-shell chat"}>
      {mentionChips.length > 0 || humanMentions.length > 0 ? (
        <div className="mention-banner" aria-label="已加入的数字人与引用的工程">
          {humanMentions.map((human) => {
            const participant = room?.participants.find((p) => p.digitalHumanId === human.id);
            const presence = participant?.presence || "idle";
            return (
              <span key={human.id} className="mention-chip human" title={`${human.purpose}\n状态：${PRESENCE_TEXT[presence]}`}>
                <HumanAvatar human={human} size={18} presence={presence} />
                <span className="mention-chip-name">{human.displayName}</span>
                <span className={`mention-chip-presence presence-text-${presence}`}>{PRESENCE_TEXT[presence]}</span>
                <button
                  type="button"
                  className="mention-banner-remove"
                  aria-label={`移除 ${human.displayName}`}
                  title={`移除 ${human.displayName}`}
                  disabled={streaming}
                  onClick={() => {
                    onHumanMentionsChange?.(humanMentions.filter((item) => item.id !== human.id));
                    onRemoveParticipant?.(human.id);
                  }}
                >
                  <XIcon className="icon-10" />
                </button>
              </span>
            );
          })}
          {mentionChips.map((chip) => (
            <span key={chip.path} className="mention-chip" title={chip.path}>
              <FolderIcon className="icon-12" />
              <span className="mention-chip-name">{chip.name}</span>
              <button
                type="button"
                className="mention-banner-remove"
                aria-label={`移除 ${chip.name}`}
                title={`移除 ${chip.name}`}
                disabled={streaming}
                onClick={() => removeMentionChip(chip)}
              >
                <XIcon className="icon-10" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {resources.length > 0 ? (
        <div className="resource-banner" aria-label="已添加资源">
          {resources.map((resource) => (
            <span key={resource.id} className={`resource-chip ${resource.kind}`} title={resource.path || resourceLabel(resource)}>
              {resource.kind === "folder" || resource.kind === "project" ? <FolderIcon className="icon-12" /> : resource.kind === "file" ? <FileIcon className="icon-12" /> : <PluginIcon kind={resource.pluginKind!} className="icon-12" />}
              <span className="resource-chip-kind">{resourceKindLabel(resource)}</span>
              <span className="resource-chip-name">{resourceLabel(resource)}</span>
              <button
                type="button"
                className="resource-banner-remove"
                title={`移除 ${resourceLabel(resource)}`}
                disabled={streaming}
                onClick={() => removeResource(resource)}
              >
                <XIcon className="icon-10" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
        <div
          className="composer-input"
          onMouseDown={(event) => {
            // 兜底：点到输入区但目标不是 textarea 本身（覆盖层/内边距/边角）时，
            // 把焦点交还给 textarea，且把光标移到文本末尾，不打断正常输入
            if (streaming) return;
            const textarea = textareaRef.current;
            if (!textarea || event.target === textarea) return;
            event.preventDefault();
            textarea.focus();
            const end = textarea.value.length;
            textarea.selectionStart = end;
            textarea.selectionEnd = end;
          }}
        >
          <textarea
            ref={textareaRef}
            value={localDraft}
            placeholder={historyBrowsing
              ? `历史消息 ${historyCursor + 1}/${sentHistory.length} · ↑↓ 切换 · Esc 返回草稿`
              : mentionCandidates.length > 0
                ? "描述任务，输入 @ 可选择数字人或引用当前项目下的工程（↑ 键调出历史消息）"
                : roomStreaming
                  ? "数字人协作中… 请等待当前任务完成"
                  : "描述任务，或粘贴需求上下文（↑ 键可调出历史消息）"}
            disabled={streaming || roomStreaming}
            onChange={(event) => {
              exitHistoryBrowsing();
              const value = event.target.value;
              const caret = event.target.selectionStart;
              commitDraft(value);
              const trigger = detectMentionTrigger(value, caret);
              if (trigger) {
                // Esc 关闭后同一触发词不再自动弹出；换一个触发词（@ 位置变化）重新弹出
                setMentionDismissed((dismissed) => (
                  dismissed && mentionTriggerRef.current?.start === trigger.start ? dismissed : false
                ));
                setMentionTrigger(trigger);
              } else {
                setMentionTrigger(null);
                setMentionDismissed(false);
              }
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(event) => {
              const composing = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
              if (composing) return;
              // @ 弹层打开时优先处理弹层导航
              if (mentionOpenRef.current) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionActiveIndex((index) => (index + 1) % Math.max(1, mentionTotalCount));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionActiveIndex((index) => (index - 1 + Math.max(1, mentionTotalCount)) % Math.max(1, mentionTotalCount));
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  if (mentionActiveIndex < humanMentionResults.length) {
                    const human = humanMentionResults[mentionActiveIndex];
                    if (human) confirmHumanMention(human);
                  } else {
                    const target = mentionResults[mentionActiveIndex - humanMentionResults.length] || mentionResults[0];
                    if (target) confirmMention(target);
                  }
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeMention();
                  setMentionDismissed(true);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendFromComposer();
                return;
              }
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                if (recallHistory(event.currentTarget, event.key === "ArrowDown")) {
                  event.preventDefault();
                }
                return;
              }
              if (event.key === "Escape" && historyBrowsing) {
                event.preventDefault();
                setHistoryCursor(sentHistoryRef.current.length);
                setDraftAndCaret(draftBackupRef.current);
                clearMentions();
              }
            }}
          />
          {mentionOpen ? (
            <div className="mention-popup" ref={mentionListRef} role="listbox" aria-label="选择数字人或工程">
              {humanMentionResults.length > 0 ? <div className="mention-popup-title">指派给数字人</div> : null}
              {humanMentionResults.map((human, index) => (
                <button
                  key={human.id}
                  type="button"
                  role="option"
                  aria-selected={index === mentionActiveIndex}
                  className={`mention-item${index === mentionActiveIndex ? " active" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    confirmHumanMention(human);
                  }}
                  onMouseEnter={() => setMentionActiveIndex(index)}
                >
                  <HumanAvatar human={human} size={22} />
                  <span className="mention-item-name">{human.displayName}</span>
                  <span className="mention-item-path" title={human.purpose}>{human.purpose}</span>
                </button>
              ))}
              {mentionResults.length > 0 ? <div className="mention-popup-title">引用工程</div> : null}
              {mentionResults.length === 0 && humanMentionResults.length === 0 ? (
                <div className="mention-empty">没有匹配项</div>
              ) : null}
              {mentionResults.map((project, projectIndex) => {
                const index = humanMentionResults.length + projectIndex;
                return (
                  <button
                    key={project.path}
                    type="button"
                    role="option"
                    aria-selected={index === mentionActiveIndex}
                    className={`mention-item${index === mentionActiveIndex ? " active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      confirmMention(project);
                    }}
                    onMouseEnter={() => setMentionActiveIndex(index)}
                  >
                    <FolderIcon className="icon-14" />
                    <span className="mention-item-name">{project.name}</span>
                    <span className="mention-item-path" title={project.path}>{project.path}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="prompt-toolbar">
          <div className="prompt-leading">
            <div className="composer-project">
              <div className="resource-add" ref={resourceMenuRef}>
                <button
                  className="composer-project-add"
                  type="button"
                  title="加资源"
                  aria-label="加资源"
                  aria-haspopup="menu"
                  aria-expanded={resourceMenuOpen}
                  disabled={streaming}
                  onClick={(event) => {
                    event.stopPropagation();
                    setResourceMenuOpen((open) => !open);
                  }}
                >
                  <PlusIcon className="icon-15" />
                </button>
                {resourceMenuOpen ? (
                  <div className="resource-menu" role="menu">
                    <div className="resource-menu-title">资源</div>
                    <button type="button" role="menuitem" className="resource-menu-item" onClick={() => runResourceAction(onPickResourceFolder)}>
                      <FolderIcon className="icon-14" />
                      文件夹
                    </button>
                    <button type="button" role="menuitem" className="resource-menu-item" onClick={() => runResourceAction(onPickResourceFile)}>
                      <FileIcon className="icon-14" />
                      文件（图片、MD 等）
                    </button>
                    <div className="resource-menu-subtitle">项目</div>
                    {(activeProject ? [activeProject] : []).concat(projects.filter((project) => (
                      (!project.local || !project.parentPath) && project.path !== activeProject?.path
                    ))).slice(0, 6).map((project) => (
                      <button key={project.path} type="button" role="menuitem" className="resource-menu-item" onClick={() => runResourceAction(() => onAddResourceProject(project))}>
                        <FolderIcon className="icon-14" />
                        <span className="resource-menu-name">{project.name}</span>
                      </button>
                    ))}
                    <div className="resource-menu-divider" />
                    <div className="resource-menu-title">插件</div>
                    {(["word", "excel", "md", "echart", "drawio"] as const).map((kind) => (
                      <button key={kind} type="button" role="menuitem" className="resource-menu-item" onClick={() => runResourceAction(() => onAddResourcePlugin(kind))}>
                        <PluginIcon kind={kind} className="icon-14" />
                        {PLUGIN_RESOURCE_LABELS[kind]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {/* 数字人配置入口已收敛到侧边栏项目行；输入框不再放数字人按钮 */}
              {/* 项目选择：触发器只显示项目名；下拉里展示路径 / 分支 / 子工程等丰富信息 */}
              <div className="project-control" ref={projectMenuRef}>
                <FolderIcon className="icon-14" />
                <button
                  type="button"
                  className="project-trigger"
                  aria-label="选择项目"
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen}
                  title={activeProject?.path || "选择项目"}
                  disabled={streaming}
                  onClick={(event) => {
                    event.stopPropagation();
                    setProjectMenuOpen((open) => !open);
                  }}
                >
                  <span className="project-trigger-label">{activeProject?.name || "默认工作区"}</span>
                  <ChevronIcon className="icon-12 chevron" />
                </button>
                {projectMenuOpen ? (
                  <div className="project-picker-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className={`project-picker-item${activeProject ? "" : " active"}`}
                      onClick={() => runProjectAction(onSelectDefaultWorkspace)}
                    >
                      <span className="project-picker-name">默认工作区</span>
                      <span className="project-picker-meta">
                        {(() => {
                          const globalHumans = digitalHumans.filter((human) => !human.projectPath);
                          return globalHumans.length > 0
                            ? `数字人：${globalHumans.map((human) => human.displayName).join("、")}`
                            : "未绑定项目目录";
                        })()}
                      </span>
                    </button>
                    {projects.map((project) => {
                      // 隶属于某项目的本地工程不单独列出，跟随其父项目作为对话背景
                      if (project.local && project.parentPath) return null;
                      const children = projects.filter((item) => item.local && item.parentPath === project.path);
                      const humans = digitalHumans.filter((human) => human.projectPath === project.path);
                      const branch = projectBranches[project.path] || "";
                      const metaText = [
                        branch,
                        children.length > 0 ? `工程：${children.map((item) => item.name).join("、")}` : "",
                        humans.length > 0 ? `数字人：${humans.map((human) => human.displayName).join("、")}` : "",
                      ].filter(Boolean).join(" · ") || "未挂载工程 · 未配置数字人";
                      return (
                        <button
                          key={project.path}
                          type="button"
                          role="menuitem"
                          className={`project-picker-item${activeProject?.path === project.path ? " active" : ""}`}
                          title={`${project.path}\n${metaText}`}
                          onClick={() => runProjectAction(() => onSelectProject(project))}
                        >
                          <span className="project-picker-name">{project.name}</span>
                          <span className="project-picker-meta">{metaText}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="branch-controls">
              {projects.map((project) => {
                // 子工程不单独展示分支切换，跟随父项目
                if (project.local && project.parentPath) return null;
                const branch = projectBranches[project.path] || "";
                const branches = projectBranchOptions[project.path] || [];
                if (!branch || branches.length === 0) return null;
                return (
                  <div className="branch-control" key={project.path} title={`${project.name} · Git 分支`}>
                    <GitBranchIcon className="icon-14" />
                    <select
                      className="branch-chip"
                      value={branch}
                      aria-label={`${project.name} Git 分支`}
                      disabled={streaming || Boolean(switchingBranchPath)}
                      onChange={(event) => onSwitchProjectBranch(project, event.target.value)}
                    >
                      {branches.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <div className="permission-select">
              <ShieldIcon className="icon-14" />
              <select
                className="permission-chip"
                value={approvalMode}
                title="请求审批 / 自动审批（仍受沙箱限制）/ 完全开放·沙箱外"
                aria-label="工具执行权限"
                disabled={streaming}
                onChange={(event) => onApprovalModeChange(event.target.value as ApprovalMode)}
              >
                <option value="REQUEST_APPROVAL">请求审批</option>
                <option value="AUTO_APPROVE">自动审批·沙箱内</option>
                <option value="FULL_OPEN">完全开放·沙箱外</option>
              </select>
            </div>
          </div>
          <div className="prompt-meta">
          </div>
          <div className="prompt-controls">
            {modelChoices.length > 0 ? (
              <div className="model-control" title={activeModel
                ? `${activeModel.displayName || activeModel.modelCode || activeModel.channelCode || "模型"} · ${activeModel.modelCode || ""}`.replace(/ · $/, "")
                : "选择对话模型"}>
                <select
                  className="model-chip"
                  value={activeModel?.channelCode || ""}
                  aria-label="对话模型"
                  disabled={streaming}
                  onChange={(event) => onActivateModel(event.target.value)}
                >
                  {modelChoices.map((model) => {
                    const value = model.channelCode || model.modelCode || "";
                    // chip 与选项均展示短标签（模型名），完整「渠道 · 模型」信息放在悬浮提示中
                    return (
                      <option key={value} value={value}>
                        {model.modelCode || model.displayName || value}
                      </option>
                    );
                  })}
                </select>
              </div>
            ) : (
              <button className="model-control" title="打开模型设置" onClick={onOpenSettings}>
                <span>{activeModel?.modelCode || activeModel?.displayName || activeModel?.channelCode || "添加模型"}</span>
              </button>
            )}
            <div className="reasoning-select" title="选择推理级别">
              <select
                className="reasoning-chip"
                value={reasoningEffort}
                aria-label="推理级别"
                disabled={streaming}
                onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort)}
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </div>
            <div
              className="context-ring-wrap"
              role="status"
              aria-label={contextTooltip}
              title={contextTooltip}
            >
              <svg className="context-ring-svg" viewBox="0 0 22 22" aria-hidden="true">
                <circle className="context-ring-bg" cx="11" cy="11" r="9" />
                <circle
                  className={`context-ring-fg${contextPercent >= 80 ? " danger" : contextPercent >= 50 ? " warn" : ""}`}
                  cx="11"
                  cy="11"
                  r="9"
                  strokeDasharray={`${(contextPercent / 100) * 2 * Math.PI * 9} ${2 * Math.PI * 9}`}
                  strokeDashoffset="0"
                />
              </svg>
              <span className="context-ring-label">{Math.round(contextPercent)}%</span>
              <div className="context-ring-tooltip">{contextTooltip}</div>
            </div>
            <button
              className={(streaming || roomStreaming) ? "composer-action stop" : "composer-action send"}
              onClick={(streaming || roomStreaming) ? onStopGeneration : sendFromComposer}
              disabled={!streaming && !roomStreaming && (!serviceReady || (!localDraft.trim() && resources.length === 0))}
              title={streaming
                ? "停止生成"
                : roomStreaming
                  ? "停止数字人协作"
                  : !serviceReady
                    ? "智能体服务未就绪"
                    : !localDraft.trim() && resources.length === 0
                      ? "请先输入消息或添加资源"
                      : "发送"}
              aria-label={streaming ? "停止生成" : roomStreaming ? "停止数字人协作" : "发送"}
            >
              {(streaming || roomStreaming) ? <StopIcon className="icon-16" /> : <SendIcon className="icon-16" />}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  const runFiles = useMemo(() => editedFiles(messages), [messages]);
  const lastAssistantIndex = useMemo(() => findLastAssistantIndex(messages), [messages]);

  return (
    <div className="conversation-layout">
      <div className="conversation-main">
        {isHome ? (
          <div className="conversation-scroll home">
            <div className="home-hero">
            <div className="home-title">
              <h1>今天要做什么？</h1>
              <p>
                {activeProject
                  ? "DSH-Java 智能体已就绪，当前项目已加载"
                  : "DSH-Java 智能体已就绪，选择项目后开始一个新对话"}
              </p>
            </div>
            <div className="suggestion-grid">
              <button
                onClick={() =>
                  commitDraft(
                    "分析当前项目的整体结构与核心模块，画一张 draw.io 架构图，并附简要说明。"
                  )
                }
              >
                <span className="suggestion-title">看懂一个项目</span>
                <span className="suggestion-desc">
                  梳理结构与核心链路，自动产出 draw.io 架构图
                </span>
              </button>
              <button
                onClick={() =>
                  commitDraft(
                    "分析当前项目的代码规模与模块分布，生成一份带 ECharts 图表的项目分析报告。"
                  )
                }
              >
                <span className="suggestion-title">生成分析报告</span>
                <span className="suggestion-desc">
                  一键产出带图表的 Word / Markdown 报告
                </span>
              </button>
              <button
                onClick={() =>
                  commitDraft(
                    "审查当前项目的代码质量与潜在风险，列出改进建议并按优先级排序。"
                  )
                }
              >
                <span className="suggestion-title">审查与改进</span>
                <span className="suggestion-desc">
                  找出风险与坏味道，给出可执行的优化建议
                </span>
              </button>
            </div>
            </div>
          </div>
        ) : roomContent ? (
          // 房间协作模式：消息区由服务端房间事件流驱动（多数字人归属、计划、工具卡、产物）
          <div className="conversation-scroll room-mode">
            <div className="conversation-column room-column">{roomContent}</div>
          </div>
        ) : (
          <>
            <div
              className="conversation-scroll"
              ref={messageListRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
                followOutputRef.current = distance < 84;
                setCanJumpLatest(distance > 240);
              }}
            >
              <div className="conversation-column">
                {timelineItems.map((item) => (
                  item.kind === "activity" ? (
                    <ActivityItem key={item.key} messages={item.messages} showAttribution={showAttribution} digitalHumans={digitalHumans} />
                  ) : (
                    <MessageItem
                      key={item.key}
                      message={item.message}
                      asThought={item.asThought}
                      renderMarkdown={renderMarkdown}
                      streaming={streaming || roomStreaming}
                      showAttribution={showAttribution}
                      digitalHumans={digitalHumans}
                      onOpenFile={onOpenFile}
                      basePath={activeProject?.path}
                      runSummary={
                        !streaming && item.message.role === "assistant" && item.message === messages[lastAssistantIndex]
                          ? {
                              duration: typeof runDurationMs === "number" && runDurationMs > 0 ? formatDuration(runDurationMs) : null,
                              files: runFiles,
                            }
                          : undefined
                      }
                    />
                  )
                ))}
              </div>
            </div>
            {canJumpLatest ? (
              <button className="jump-latest" type="button" onClick={scrollToBottom} aria-label="回到最新" title="回到最新">
                <ArrowDownIcon className="icon-18" />
              </button>
            ) : null}
          </>
        )}
      {/* 成员展示并入输入框 chips（含状态与删除），不再单独显示顶部成员栏，避免重复 */}
      <div className="composer-dock">
        {renderComposer(isHome ? "hero" : "chat")}
      </div>
      </div>
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  message,
  asThought,
  renderMarkdown,
  streaming,
  showAttribution = true,
  runSummary,
  digitalHumans,
  onOpenFile,
  basePath,
}: {
  message: ConversationMessage;
  asThought?: boolean;
  renderMarkdown: (value: string) => ReactNode;
  streaming: boolean;
  showAttribution?: boolean;
  runSummary?: { duration: string | null; files: string[] };
  /** 数字人目录：归属头像点击时取完整档案 */
  digitalHumans: DigitalHuman[];
  /** 在右侧面板打开本地文件 */
  onOpenFile?: (path: string) => void;
  /** 当前项目根：用于把回复中的相对代码路径解析为可打开的文件 */
  basePath?: string;
}) {
  const isTool = message.role === "tool";
  const reasoningText = message.reasoning?.trim() || "";
  const contentText = message.content.replace(/​/g, "");
  const pendingAssistant = message.role === "assistant" && streaming && !reasoningText && !contentText.trim();
  const attribution = showAttribution ? message.attribution : undefined;
  const humanRecord = attribution
    ? digitalHumans.find((human) => human.id === attribution.digitalHumanId) || null
    : null;

  // 数字人归属：小头像内嵌在思考过程/工具行行尾，点击弹出角色信息卡
  const attributionAvatar = attribution ? (
    <AttributionAvatar
      name={attribution.displayName}
      avatar={attribution.avatarRef}
      color={attribution.themeColor}
      human={humanRecord}
      taskLabel={attribution.taskLabel}
    />
  ) : null;

  if (asThought) {
    return (
      <article className={`message ${message.role} thought`} aria-live={streaming ? "polite" : undefined}>
        <div className="message-body">
          <details className="reasoning-block">
            <summary aria-label="AI 思考过程">
              <span className="reasoning-dot" />
              <span className="reasoning-label">思考过程</span>
              {attributionAvatar}
              <ChevronIcon className="icon-12 chevron" />
            </summary>
            <pre>{reasoningText}</pre>
          </details>
        </div>
      </article>
    );
  }

  return (
    <article className={`message ${message.role}${attribution ? " attributed" : ""}${pendingAssistant ? " pending" : ""}`} aria-live={streaming ? "polite" : undefined}>
      <div className="message-body">
        {attribution ? (
          <div className="message-attribution-row">
            <AttributionAvatar
              name={attribution.displayName}
              avatar={attribution.avatarRef}
              color={attribution.themeColor}
              human={humanRecord}
              taskLabel={attribution.taskLabel}
            />
            <span className="message-attribution-name">{attribution.displayName}</span>
          </div>
        ) : null}
        {isTool ? (
          <div className="tool-card">
            <details className="tool-card-detail">
              <summary>
                <span>{message.toolName || "Tool"}</span>
                {message.status ? (
                  <span className={`tool-status ${message.status}`}>
                    {message.status === "success" ? "完成" : message.status === "running" ? "执行中" : "失败"}
                  </span>
                ) : null}
                {attributionAvatar}
              </summary>
              <pre>{message.result || JSON.stringify(message.arguments || {}, null, 2)}</pre>
            </details>
          </div>
        ) : (
          <>
            {reasoningText ? (
              <details className="reasoning-block">
                <summary aria-label="AI 思考过程">
                  <span className="reasoning-dot" />
                  <span className="reasoning-label">思考过程</span>
                  {attributionAvatar}
                  <ChevronIcon className="icon-12 chevron" />
                </summary>
                <pre>{reasoningText}</pre>
              </details>
            ) : null}
            {message.role === "user" && message.mentions && message.mentions.length > 0 ? (
              <div className="message-mentions">
                {message.mentions.map((project) => (
                  <span key={project.path} className="mention-chip static" title={project.path}>
                    <FolderIcon className="icon-12" />
                    <span className="mention-chip-name">{project.name}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {message.role === "user" && message.resources && message.resources.length > 0 ? (
              <div className="message-mentions">
                {message.resources.map((resource) => (
                  <span key={resource.id} className={`resource-chip static ${resource.kind}`} title={resource.path || resourceLabel(resource)}>
                    {resource.kind === "folder" || resource.kind === "project" ? <FolderIcon className="icon-12" /> : resource.kind === "file" ? <FileIcon className="icon-12" /> : <PluginIcon kind={resource.pluginKind!} className="icon-12" />}
                    <span className="resource-chip-kind">{resourceKindLabel(resource)}</span>
                    <span className="resource-chip-name">{resourceLabel(resource)}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {contentText ? (
              <div className="message-content">
                {renderMarkdown(contentText)}
              </div>
            ) : pendingAssistant ? (
              <div className="typing-indicator" role="status" aria-label="正在生成回复">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </div>
            ) : null}
            {/* 产出的本地文件（md/word/excel/代码等）：内嵌渲染卡片，点击查看 */}
            {!streaming && contentText ? <InlineFileCards content={contentText} onOpenFile={onOpenFile} basePath={basePath} /> : null}
            {runSummary ? (
              <div className="run-summary">
                {runSummary.duration ? (
                  <span className="run-summary-chip">
                    <span className="run-summary-dot" />
                    本轮耗时 {runSummary.duration}
                  </span>
                ) : null}
                {runSummary.files.length > 0 ? (
                  <div className="run-summary-files">
                    <span className="run-summary-files-header">
                      <span>修改文件</span>
                      <span className="run-summary-count">{runSummary.files.length}</span>
                    </span>
                    <RunSummaryFiles files={runSummary.files} onOpenFile={onOpenFile} />
                  </div>
                ) : null}
              </div>
            ) : null}
            {message.role === "user" || message.role === "assistant" ? (
              <MessageMeta message={message} />
            ) : null}
          </>
        )}
      </div>
    </article>
  );
});

function MessageMeta({ message }: { message: ConversationMessage }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  const time = formatMessageTime(message.createdAt);
  const copyText = message.content || message.reasoning || "";
  if (!time && !copyText) return null;

  const handleCopy = async () => {
    if (!copyText) return;
    if (await copyMessageText(copyText)) {
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1_600);
    }
  };

  return (
    <div className="message-meta">
      {time ? <span className="message-time">{time}</span> : null}
      {copyText ? (
        <button
          className={`message-copy${copied ? " copied" : ""}`}
          type="button"
          onClick={() => void handleCopy()}
          title={copied ? "已复制" : "复制内容"}
          aria-label={copied ? "已复制" : "复制内容"}
        >
          {copied ? "已复制" : <CopyIcon className="icon-14" />}
        </button>
      ) : null}
    </div>
  );
}

const ActivityItem = memo(function ActivityItem({
  messages,
  showAttribution = true,
  digitalHumans,
}: {
  messages: ConversationMessage[];
  showAttribution?: boolean;
  digitalHumans: DigitalHuman[];
}) {
  const state = activityState(messages);
  const running = state === "running";

  // WorkBuddy 风格：每个工具步骤直接平铺成一行（图标+动作+文件名+差异），
  // 单步且非运行中时不包折叠块，最简洁；多步/运行中给一个可折叠的聚合头。
  if (!running && messages.length === 1) {
    return (
      <article className="message activity flat">
        <div className="message-body">
          <ToolStep message={messages[0]} showAttribution={showAttribution} digitalHumans={digitalHumans} />
        </div>
      </article>
    );
  }

  const title = running ? activityLabel(messages) : activitySummary(messages);
  return (
    <article className="message activity">
      <div className="message-body">
        <details className="activity-detail" open={running}>
          <summary>
            <span className={`activity-state activity-state-${state}`} />
            <span className="activity-title">{title}</span>
            {messages.length > 1 ? <span className="activity-count">{messages.length}</span> : null}
            <ChevronIcon className="icon-12 chevron" />
          </summary>
          {running ? <div className="activity-progress" aria-hidden="true" /> : null}
          <div className="activity-list">
            {messages.map((message, index) => (
              <ToolStep key={activityKey(message, index)} message={message} showAttribution={showAttribution} digitalHumans={digitalHumans} />
            ))}
          </div>
        </details>
      </div>
    </article>
  );
});

function ToolStepIcon({ name }: { name: ReturnType<typeof toolIconName> }) {
  const className = "tool-step-icon";
  switch (name) {
    case "edit":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="m4 20h4L20 8l-4-4L4 16v4Z" />
          <path d="m14 6 4 4" />
        </svg>
      );
    case "read":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
      );
    case "command":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
          <path d="m7 9.5 3 2.5-3 2.5M12.5 14.5H17" />
        </svg>
      );
    case "search":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10.8" cy="10.8" r="6.3" />
          <path d="m16 16 4.3 4.3" />
        </svg>
      );
    case "web":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.3 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.3-3.9-8.5s1.3-6.1 3.9-8.5Z" />
        </svg>
      );
    case "list":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.2l2 2.4H18a2.5 2.5 0 0 1 2.5 2.5v6.6A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
        </svg>
      );
    default:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.8 2.8-2.4-.7-.7-2.4z" />
        </svg>
      );
  }
}

function toolActionLabel(message: ConversationMessage): string {
  const running = message.status === "running";
  const failed = message.status === "error" || message.status === "failed";
  if (isEditTool(message.toolName)) return "编辑";
  const name = (message.toolName || "").toLowerCase();
  if (name === "fs_read") return "已读取";
  if (name === "fs_list" || name === "fs_tree") return "查看目录";
  if (name === "shell_execute") return failed ? "命令失败" : running ? "执行命令" : "已执行命令";
  if (name === "web_search") return "搜索";
  if (name === "web_fetch") return "读取网页";
  if (name === "ask_user_question") return failed ? "提问失败" : running ? "等待回答" : "已回答";
  return toolTitle(message);
}

const ToolStep = memo(function ToolStep({
  message,
  showAttribution = true,
  digitalHumans,
}: {
  message: ConversationMessage;
  showAttribution?: boolean;
  digitalHumans: DigitalHuman[];
}) {
  const file = toolFilePath(message);
  const diff = isEditTool(message.toolName) ? toolDiffStats(message) : null;
  const failed = message.status === "error" || message.status === "failed";
  const detail = !file ? toolDetail(message) : "";
  const statusClass = failed ? " failed" : message.status === "running" ? " running" : "";
  const attribution = showAttribution ? message.attribution : undefined;

  return (
    <details className={`tool-step${statusClass}`}>
      <summary>
        <ToolStepIcon name={toolIconName(message)} />
        <span className="tool-step-action">{toolActionLabel(message)}</span>
        {file ? (
          <span className="tool-step-file" title={file.dir ? `${file.dir}/${file.base}` : file.base}>
            {file.dir ? <span className="tool-step-dir">{file.dir}/</span> : null}
            <span className="tool-step-base">{file.base}</span>
          </span>
        ) : detail ? (
          <span className="tool-step-file" title={detail}>
            <span className="tool-step-base dim">{detail}</span>
          </span>
        ) : null}
        {diff && (diff.add > 0 || diff.del > 0) ? (
          <span className="tool-step-diff">
            {diff.add > 0 ? <span className="diff-add">+{diff.add}</span> : null}
            {diff.del > 0 ? <span className="diff-del">-{diff.del}</span> : null}
          </span>
        ) : null}
        {failed ? <span className="tool-status failed">失败</span> : null}
        {attribution ? (
          <AttributionAvatar
            name={attribution.displayName}
            avatar={attribution.avatarRef}
            color={attribution.themeColor}
            human={digitalHumans.find((human) => human.id === attribution.digitalHumanId) || null}
            taskLabel={attribution.taskLabel}
          />
        ) : null}
      </summary>
      <pre>{message.result || JSON.stringify(message.arguments || {}, null, 2)}</pre>
    </details>
  );
});
