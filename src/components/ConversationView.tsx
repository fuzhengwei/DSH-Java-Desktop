import type { ApprovalMode, AvailableModel, ConversationMessage, ReasoningEffort, RuntimeApproval, WorkspaceEntry } from "../types";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDownIcon, ChevronIcon, CopyIcon, FolderIcon, GitBranchIcon, PlusIcon, SendIcon, ShieldIcon, StopIcon, XIcon } from "./icons";

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
  onCreateSession?: () => void;
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
};

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
  if (message.toolName === "ask_user_question") return failed ? "确认失败" : running ? "等待确认" : "已完成确认";
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

/** 从草稿文本中解析已确认的工程提及：@名称（名称后紧跟空格/换行/文本结尾） */
function parseMentionEntries(value: string, candidates: WorkspaceEntry[]): { name: string; start: number; end: number }[] {
  const entries: { name: string; start: number; end: number }[] = [];
  for (const project of candidates) {
    if (!project.name) continue;
    let searchFrom = 0;
    const token = `@${project.name}`;
    while (searchFrom < value.length) {
      const index = value.indexOf(token, searchFrom);
      if (index < 0) break;
      const end = index + token.length;
      const tail = value[end];
      if (end === value.length || tail === " " || tail === "\n" || tail === "\t") {
        entries.push({ name: project.name, start: index, end });
      }
      searchFrom = end;
    }
  }
  entries.sort((a, b) => a.start - b.start);
  return entries;
}

/** 去掉草稿中已确认提及的 @ 文本，得到干净的正文 */
function stripMentionTokens(value: string, entries: { start: number; end: number }[]): string {
  if (entries.length === 0) return value;
  let result = "";
  let cursor = 0;
  for (const entry of entries) {
    result += value.slice(cursor, entry.start);
    cursor = entry.end;
    // 吃掉提及后紧跟的一个空格，避免留下双空格
    if (value[cursor] === " ") cursor += 1;
  }
  result += value.slice(cursor);
  return result;
}

/** 输入中的触发词：光标前最后一个 @ 开始的连续非空白片段（不含空格，支持中文） */
function detectMentionTrigger(value: string, caret: number): { start: number; query: string } | null {
  const beforeCaret = value.slice(0, caret);
  const atIndex = beforeCaret.lastIndexOf("@");
  if (atIndex < 0) return null;
  const query = beforeCaret.slice(atIndex + 1);
  if (/[\s@]/.test(query)) return null;
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
  onCreateSession,
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
}: ConversationViewProps) {
  const isHome = messages.length === 0;
  const messageListRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [canJumpLatest, setCanJumpLatest] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // 输入历史：historyCursor 指向 sentHistory 下标，history.length 表示未进入浏览状态
  const [historyCursor, setHistoryCursorState] = useState(sentHistory.length);
  const historyCursorRef = useRef(sentHistory.length);
  const setHistoryCursor = (value: number) => {
    historyCursorRef.current = value;
    setHistoryCursorState(value);
  };
  const draftBackupRef = useRef("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
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

  // 草稿变化时与文本中的 @ 标记对账：名字还在文本里才保留标签，否则移除
  const syncMentionsFromText = useCallback((value: string) => {
    setMentionChips((current) => current.filter((chip) => value.includes(`@${chip.name}`)));
  }, []);
  const syncMentionsRef = useRef(syncMentionsFromText);
  syncMentionsRef.current = syncMentionsFromText;

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

  // 候选为空（项目未挂载工程 / 默认工作区）时不弹层，@ 视为普通字符，避免"弹个空框"
  const mentionOpen = Boolean(mentionTrigger && !mentionDismissed && !streaming && mentionCandidates.length > 0);
  const mentionOpenRef = useRef(mentionOpen);
  mentionOpenRef.current = mentionOpen;

  // 标签变化同步给 App（发送时拼上下文、存到消息上）
  useEffect(() => {
    onMentionsChange(mentionChips);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionChips]);

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

  /** 从弹层确认一个工程：在原位置留下 @名称 文本并登记标签，光标移到其后 */
  const confirmMention = (project: WorkspaceEntry) => {
    const trigger = mentionTriggerRef.current;
    const textarea = textareaRef.current;
    if (!trigger) return;
    const value = draftRef.current;
    const caret = textarea ? textarea.selectionStart : value.length;
    const token = `@${project.name} `;
    const next = value.slice(0, trigger.start) + token + value.slice(caret);
    const caretAfter = trigger.start + token.length;
    setMentionChips((current) => (
      current.some((chip) => chip.path === project.path) ? current : [...current, project]
    ));
    setMentionTrigger(null);
    setMentionDismissed(false);
    onDraftChange(next);
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
    // 同时移除文本中的 @名称，标签与文本保持一致
    const entries = parseMentionEntries(draftRef.current, mentionCandidates)
      .filter((entry) => entry.name === project.name);
    if (entries.length > 0) {
      const next = stripMentionTokens(draftRef.current, entries);
      onDraftChange(next);
    }
    setMentionChips((current) => current.filter((chip) => chip.path !== project.path));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /** 浏览历史时解析草稿中的 @ 文本，恢复标签 */
  const restoreMentionsFromText = (value: string) => {
    const entries = parseMentionEntries(value, mentionCandidates);
    const found = entries
      .map((entry) => mentionCandidates.find((project) => project.name === entry.name))
      .filter((project): project is WorkspaceEntry => Boolean(project));
    // 去重（同名只保留一次）
    const seen = new Set<string>();
    setMentionChips(found.filter((project) => {
      if (seen.has(project.path)) return false;
      seen.add(project.path);
      return true;
    }));
  };

  const exitHistoryBrowsing = () => {
    setHistoryCursor(sentHistoryRef.current.length);
  };

  const setDraftAndCaret = (value: string) => {
    onDraftChange(value);
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
      restoreMentionsFromText(draftBackupRef.current);
      return true;
    }
    next = Math.max(0, Math.min(history.length - 1, next));
    if (next === historyCursorRef.current) return browsing; // 已到端点，浏览中也要拦截默认行为
    setHistoryCursor(next);
    setDraftAndCaret(history[next]);
    restoreMentionsFromText(history[next]);
    return true;
  };

  const renderMarkdown = (value: string) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {value}
    </ReactMarkdown>
  );

  const lastMessage = messages[messages.length - 1];
  const sendFromComposer = () => {
    const text = draftRef.current.trim();
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
    ? `工具 · ${runningTool.toolName || "Tool"}`
    : isThinking ? "思考中" : "生成中";

  useEffect(() => {
    if (!streaming || !streamStartedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [streamStartedAt, streaming]);

  const elapsedSeconds = streaming && streamStartedAt
    ? Math.max(0, Math.floor((now - streamStartedAt) / 1_000))
    : 0;
  const usedTokens = messages.reduce((sum, message) => sum + messageTokenCount(message), 0);
  const contextLimit = 128_000;
  const contextPercent = Math.min(100, (usedTokens / contextLimit) * 100);
  const contextTooltip = `${contextPercent.toFixed(1)}% · ${formatTokens(usedTokens)} / ${formatTokens(contextLimit)} 上下文已使用`;
  useEffect(() => {
    if (messageListRef.current && followOutputRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

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
    return messages.reduce<TimelineItem[]>((items, message, index) => {
      if (message.role === "tool") {
        const previous = items[items.length - 1];
        if (previous?.kind === "activity") {
          previous.messages.push(message);
          return items;
        }
        items.push({ kind: "activity", key: activityKey(message, index), messages: [message] });
        return items;
      }

      const reasoning = message.reasoning?.trim() || "";
      const content = message.content.trim();
      const isLast = index === messages.length - 1;
      const hasAnything = Boolean(reasoning || content);
      // 跳过完全为空的消息项（流式占位除外），避免空 article 产生多余间距
      if (!hasAnything && !(isLast && streaming)) return items;

      items.push({
        kind: "message",
        key: `${message.role}-${index}-${message.callId || message.createdAt || "message"}`,
        message,
        asThought: message.role === "assistant"
          && messages[index + 1]?.role === "tool"
          && !content,
      });
      return items;
    }, []);
  }, [messages, streaming]);

  const renderComposer = (variant: "hero" | "chat") => (
    <>
      {variant === "chat" && streaming ? (
        <div className="conversation-status">
          <span className="conversation-status-dot" />
          <span className="conversation-status-label">
            {runningLabel}
            {elapsedSeconds > 0 ? ` · ${elapsedSeconds}s` : ""}
          </span>
        </div>
      ) : null}
      {historyBrowsing && !streaming ? (
        <div className="conversation-status history-hint">
          <span className="history-hint-key">↑</span>
          <span className="history-hint-key">↓</span>
          <span>
            浏览历史消息 {historyCursor + 1}/{sentHistory.length} · Esc 返回草稿
          </span>
        </div>
      ) : null}
      {approvals.length > 0 ? (
        <div className="runtime-approval" aria-live="polite">
          <div className="runtime-approval-main">
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
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            value={draft}
            placeholder={mentionCandidates.length > 0
              ? "描述任务，输入 @ 可引用当前项目下的工程（↑ 键调出历史消息）"
              : "描述任务，或粘贴需求上下文（↑ 键可调出历史消息）"}
            disabled={streaming}
            onChange={(event) => {
              exitHistoryBrowsing();
              const value = event.target.value;
              const caret = event.target.selectionStart;
              onDraftChange(value);
              syncMentionsRef.current(value);
              const trigger = detectMentionTrigger(value, caret);
              if (trigger) {
                // 光标落在已确认标签的 @ 文本内时，不重新打开弹层
                const insideConfirmed = parseMentionEntries(value, mentionCandidates)
                  .some((entry) => trigger.start >= entry.start && trigger.start < entry.end);
                if (insideConfirmed) {
                  setMentionTrigger(null);
                } else {
                  // Esc 关闭后同一触发词不再自动弹出；换一个触发词（@ 位置变化）重新弹出
                  setMentionDismissed((dismissed) => (
                    dismissed && mentionTriggerRef.current?.start === trigger.start ? dismissed : false
                  ));
                  setMentionTrigger(trigger);
                }
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
                  setMentionActiveIndex((index) => (index + 1) % mentionResults.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionActiveIndex((index) => (index - 1 + mentionResults.length) % mentionResults.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const target = mentionResults[mentionActiveIndex] || mentionResults[0];
                  if (target) confirmMention(target);
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
                restoreMentionsFromText(draftBackupRef.current);
              }
            }}
          />
          {mentionChips.length > 0 ? (
            <div className="mention-overlay" aria-hidden="true">
              <div className="mention-overlay-text">
                {(() => {
                  const chipPaths = new Set(mentionChips.map((chip) => chip.path));
                  const candidates = mentionCandidates.filter((project) => chipPaths.has(project.path));
                  const entries = parseMentionEntries(draft, candidates);
                  const chipsByName = new Map(mentionChips.map((chip) => [chip.name, chip]));
                  const nodes: ReactNode[] = [];
                  let cursor = 0;
                  entries.forEach((entry, index) => {
                    nodes.push(<span key={`text-${index}`}>{draft.slice(cursor, entry.start)}</span>);
                    const chip = chipsByName.get(entry.name);
                    if (chip) {
                      nodes.push(
                        <span key={`chip-${index}`} className="mention-chip-token" title={chip.path}>
                          <FolderIcon className="icon-12" />
                          {chip.name}
                        </span>,
                      );
                    }
                    cursor = entry.end;
                  });
                  nodes.push(<span key="text-tail">{draft.slice(cursor)}</span>);
                  return nodes;
                })()}
              </div>
            </div>
          ) : null}
          {mentionOpen ? (
            <div className="mention-popup" ref={mentionListRef} role="listbox" aria-label="选择工程">
              <div className="mention-popup-title">引用工程</div>
              {mentionResults.length === 0 ? (
                <div className="mention-empty">没有匹配的工程</div>
              ) : null}
              {mentionResults.map((project, index) => (
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
              ))}
            </div>
          ) : null}
        </div>
        <div className="prompt-toolbar">
          <div className="prompt-leading">
            {mentionChips.length > 0 ? (
              <div className="mention-chips" aria-label="已引用的工程">
                {mentionChips.map((chip) => (
                  <span key={chip.path} className="mention-chip" title={chip.path}>
                    <FolderIcon className="icon-12" />
                    <span className="mention-chip-name">{chip.name}</span>
                    <button
                      type="button"
                      className="mention-chip-remove"
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
            <div className="composer-project">
              <button
                className="composer-project-add"
                type="button"
                title="创建会话"
                aria-label="创建会话"
                disabled={streaming}
                onClick={onCreateSession}
              >
                <PlusIcon className="icon-15" />
              </button>
              <div className="project-control" title={activeProject?.path || "选择项目"}>
                <FolderIcon className="icon-14" />
                <select
                  className="project-chip"
                  value={activeProject?.path || ""}
                  aria-label="选择项目"
                  disabled={streaming}
                  onChange={(event) => {
                    if (!event.target.value) {
                      onSelectDefaultWorkspace();
                      return;
                    }
                    const project = projects.find((item) => item.path === event.target.value);
                    if (project) onSelectProject(project);
                  }}
                >
                  <option value="">默认工作区</option>
                  {projects.map((project) => {
                    // 隶属于某项目的本地工程不单独列出，跟随其父项目作为对话背景
                    if (project.local && project.parentPath) return null;
                    const children = projects.filter((item) => item.local && item.parentPath === project.path);
                    return (
                      <option key={project.path} value={project.path}>
                        {project.name}
                        {children.length > 0 ? `（${children.map((item) => item.name).join("、")}）` : ""}
                      </option>
                    );
                  })}
                </select>
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
              <div className="model-control" title="选择对话模型">
                <select
                  className="model-chip"
                  value={activeModel?.channelCode || ""}
                  aria-label="对话模型"
                  disabled={streaming}
                  onChange={(event) => onActivateModel(event.target.value)}
                >
                  {modelChoices.map((model) => {
                    const value = model.channelCode || model.modelCode || "";
                    return (
                      <option key={value} value={value}>
                        {[model.displayName || model.modelCode, model.modelCode]
                          .filter((label, index, labels) => label && labels.indexOf(label) === index)
                          .join(" · ")}
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
                <option value="low">低推理</option>
                <option value="medium">中推理</option>
                <option value="high">高推理</option>
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
              className={streaming ? "composer-action stop" : "composer-action send"}
              onClick={streaming ? onStopGeneration : sendFromComposer}
              disabled={!serviceReady || (!streaming && !draft.trim())}
              title={streaming ? "停止生成" : "发送"}
              aria-label={streaming ? "停止生成" : "发送"}
            >
              {streaming ? <StopIcon className="icon-16" /> : <SendIcon className="icon-16" />}
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
                <p>{activeProject ? "当前项目已就绪" : "选择项目后开始一个新对话"}</p>
              </div>
              <div className="suggestion-grid">
                <button onClick={() => onDraftChange("分析当前项目的代码结构，找出启动入口、核心模块和潜在风险。")}>
                  分析项目结构
                </button>
                <button onClick={() => onDraftChange("为当前项目设计一个可执行的测试计划，并优先列出高风险场景。")}>
                  制定测试计划
                </button>
                <button onClick={() => onDraftChange("审查当前项目的构建配置，找出可以改进的地方。")}>
                  审查构建配置
                </button>
              </div>
            </div>
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
                    <ActivityItem key={item.key} messages={item.messages} />
                  ) : (
                    <MessageItem
                      key={item.key}
                      message={item.message}
                      asThought={item.asThought}
                      renderMarkdown={renderMarkdown}
                      streaming={streaming}
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
  runSummary,
}: {
  message: ConversationMessage;
  asThought?: boolean;
  renderMarkdown: (value: string) => ReactNode;
  streaming: boolean;
  runSummary?: { duration: string | null; files: string[] };
}) {
  const isTool = message.role === "tool";
  const reasoningText = message.reasoning?.trim() || "";
  const contentText = message.content;

  if (asThought) {
    return (
      <article className={`message ${message.role} thought`} aria-live={streaming ? "polite" : undefined}>
        <div className="message-body">
          <details className="reasoning-block">
            <summary aria-label="AI 思考过程">
              <span className="reasoning-dot" />
              <span className="reasoning-label">思考过程</span>
              <ChevronIcon className="icon-12 chevron" />
            </summary>
            <pre>{reasoningText}</pre>
          </details>
        </div>
      </article>
    );
  }

  return (
    <article className={`message ${message.role}`} aria-live={streaming ? "polite" : undefined}>
      <div className="message-body">
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
            {contentText ? (
              <div className="message-content">{renderMarkdown(contentText)}</div>
            ) : streaming ? (
              <div className="typing-indicator" aria-label="正在生成回复">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {runSummary ? (
              <div className="run-summary">
                {runSummary.duration ? (
                  <span className="run-summary-chip">
                    <span className="run-summary-dot" />
                    本轮耗时 {runSummary.duration}
                  </span>
                ) : null}
                {runSummary.files.length > 0 ? (
                  <details className="run-summary-files">
                    <summary>
                      <span>修改文件</span>
                      <span className="run-summary-count">{runSummary.files.length}</span>
                    </summary>
                    <ul>
                      {runSummary.files.map((file) => (
                        <li key={file} title={file}>{file}</li>
                      ))}
                    </ul>
                  </details>
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

const ActivityItem = memo(function ActivityItem({ messages }: { messages: ConversationMessage[] }) {
  const state = activityState(messages);
  const running = state === "running";

  // WorkBuddy 风格：每个工具步骤直接平铺成一行（图标+动作+文件名+差异），
  // 单步且非运行中时不包折叠块，最简洁；多步/运行中给一个可折叠的聚合头。
  if (!running && messages.length === 1) {
    return (
      <article className="message activity flat">
        <div className="message-body">
          <ToolStep message={messages[0]} />
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
              <ToolStep key={activityKey(message, index)} message={message} />
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
  if (name === "ask_user_question") return failed ? "确认失败" : running ? "等待确认" : "已完成确认";
  return toolTitle(message);
}

const ToolStep = memo(function ToolStep({ message }: { message: ConversationMessage }) {
  const file = toolFilePath(message);
  const diff = isEditTool(message.toolName) ? toolDiffStats(message) : null;
  const failed = message.status === "error" || message.status === "failed";
  const detail = !file ? toolDetail(message) : "";
  const statusClass = failed ? " failed" : message.status === "running" ? " running" : "";

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
      </summary>
      <pre>{message.result || JSON.stringify(message.arguments || {}, null, 2)}</pre>
    </details>
  );
});
