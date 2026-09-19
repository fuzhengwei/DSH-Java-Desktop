import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfmCompatible from "../lib/remark-gfm-compatible";
import type { ConversationMessage, DigitalHuman, RuntimeApproval } from "../types";
import type { RoomEvent, ServerRoomView } from "../lib/digital-human-client";
import { listRuntimeApprovals, resolveRuntimeApproval } from "../lib/agent-client";
import {
  cancelRoomTask,
  digitalHumanTokensFor,
  fetchRoomEvents,
  fetchServerRoom,
  resumeRoomTask,
  subscribeRoomEvents,
} from "../lib/digital-human-client";
import { buildRoomFeed, foldToolRuns } from "../lib/room-feed";
import type { FeedRow, HumanRef, ToolRun } from "../lib/room-feed";
import { EChartBlock } from "./EChartBlock";
import { InlineFileCards, localFilePathFromHref } from "./FilePreview";
import { FileActionsArea } from "./FileActionsMenu";
import { ArrowDownIcon, ChevronIcon } from "./icons";
import { AttributionAvatar } from "./AttributionAvatar";

type Props = {
  port: number;
  roomId: string;
  humans: DigitalHuman[];
  channelCode?: string;
  approvalMode?: string;
  onRoomChange?: (room: ServerRoomView) => void;
  /** 运行态变化：有活跃任务时为 true（用于禁用输入框、显示总停止） */
  onRunningChange?: (running: boolean) => void;
  /** 点击产物卡：右侧滑出预览 */
  onOpenArtifact?: (artifact: { artifactId?: string; title: string; producerName?: string }) => void;
  /** 点击正文里的文件路径：右侧文件预览 */
  onOpenFile?: (path: string) => void;
  /** 房间刚开始执行、服务端快照尚未返回时也显示输出占位 */
  starting?: boolean;
  /** 右侧群聊点击摘要：中间区域滚动定位到对应 seq 的条目 */
  focusRequest?: { seq: number; nonce: number } | null;
};

type RoomArtifact = NonNullable<ServerRoomView["artifacts"]>[number];
type ArtifactAvailability = "ready" | "pending" | "missing";

function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

/** HumanRef（feed 轻量引用）→ 目录档案（用于点击查看角色信息） */
function lookupHuman(humans: DigitalHuman[], ref: HumanRef): DigitalHuman | null {
  return humans.find((human) => human.id === ref.id) || null;
}

function formatMessageTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function roomArtifactHasPreview(artifact?: RoomArtifact): boolean {
  return Boolean(
    artifact?.content?.trim()
    || artifact?.previewMarkdown?.trim()
    || artifact?.summary?.trim()
    || artifact?.filePath?.trim()
    || artifact?.echartsOption,
  );
}

function roomArtifactFilePaths(artifact?: RoomArtifact): string[] {
  return artifact?.filePath?.trim() ? [artifact.filePath.trim()] : [];
}

function roomArtifactAvailability(artifact: RoomArtifact | undefined, existingFilePaths: Set<string> | null): ArtifactAvailability {
  if (!artifact) return "pending";
  if (artifact.content?.trim() || artifact.previewMarkdown?.trim() || artifact.summary?.trim() || artifact.echartsOption) return "ready";
  const filePaths = roomArtifactFilePaths(artifact);
  if (filePaths.length === 0) return "pending";
  if (!existingFilePaths) return "pending";
  return filePaths.some((path) => existingFilePaths.has(path)) ? "ready" : "missing";
}

// ── 工具行：与普通对话 ToolStep 同款 ──────────────

function toolIconName(message: Pick<ConversationMessage, "toolName">): "edit" | "read" | "command" | "search" | "web" | "list" | "tool" {
  const name = (message.toolName || "").toLowerCase();
  if (/^(fs_write|str_replace_editor|edit_file|write_file)$/i.test(message.toolName || "")) return "edit";
  if (name === "fs_read") return "read";
  if (name === "fs_list" || name === "fs_tree") return "list";
  if (name === "shell_execute") return "command";
  if (name === "web_search") return "search";
  if (name === "web_fetch") return "web";
  return "tool";
}

function toolActionLabel(run: ToolRun): string {
  const running = !run.resultSummary && run.status !== "error" && run.status !== "success";
  const name = (run.toolName || "").toLowerCase();
  if (toolIconName(run) === "edit") return "编辑";
  if (name === "fs_read") return "已读取";
  if (name === "fs_list" || name === "fs_tree") return "查看目录";
  if (name === "shell_execute") return run.status === "error" ? "命令失败" : running ? "执行命令" : "已执行命令";
  if (name === "web_search") return "搜索";
  if (name === "web_fetch") return "读取网页";
  return running ? `正在执行 ${run.toolName}` : `已执行 ${run.toolName}`;
}

/** 从调用参数/摘要里取文件路径（与普通对话 toolFilePath 同规则） */
function runFilePath(run: ToolRun): { base: string; dir: string } | null {
  const args = run.callArguments || {};
  const raw = args.path ?? args.file_path ?? args.file ?? args.target ?? args.filename;
  const text = typeof raw === "string" && raw.trim() ? raw.trim() : run.callSummary || "";
  if (!text.trim()) return null;
  const segments = text.trim().split(/[\\/]/).filter(Boolean);
  const base = segments[segments.length - 1] || text.trim();
  const dir = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
  return { base, dir };
}

/**
 * callSummary → 人话。
 * 上游协作网关的 summary 可能是整包事件 JSON（{"toolName":...,"args":"{\"command\":...}"}），
 * 原样展示会变成一坨转义串；这里提炼命令/路径/摘要，提炼不出再回退原文。
 */
function toolCallDisplayText(run: ToolRun): string {
  const raw = (run.callSummary || "").replace(/\s+/g, " ").trim();
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      let args: unknown = obj.args ?? obj.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { /* args 保持字符串 */ }
      }
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const record = args as Record<string, unknown>;
        const cmd = record.command ?? record.cmd ?? record.script;
        if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
      }
      for (const key of ["summary", "description", "path", "file_path"]) {
        const value = obj[key];
        if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
      }
      if (typeof args === "string" && args.trim()) return args.replace(/\s+/g, " ").trim();
    } catch {
      // 非法 JSON 原样展示
    }
  }
  return raw;
}

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
          <path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.3 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.3-3.9-8.5s1.3-6.1 3.9-8.5c-2.6 2.4-3.9 5.3-3.9 8.5s1.3 6.1 3.9 8.5Z" />
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

/** 单条工具行：与普通对话 ToolStep 完全同款的视觉（图标+动作+文件+归属头像） */
const RoomToolStep = memo(function RoomToolStep({ run, focused, humans }: { run: ToolRun; focused?: boolean; humans: DigitalHuman[] }) {
  const file = runFilePath(run);
  const failed = run.status === "error";
  const statusClass = failed ? " failed" : run.status === "success" || run.resultSummary ? "" : " running";
  return (
    <details
      data-seq={run.seq}
      className={`tool-step${statusClass}${focused ? " room-focus" : ""}`}
      open={focused || undefined}
    >
      <summary>
        <ToolStepIcon name={toolIconName(run)} />
        <span className="tool-step-action">{toolActionLabel(run)}</span>
        {file ? (
          <span className="tool-step-file" title={file.dir ? `${file.dir}/${file.base}` : file.base}>
            {file.dir ? <span className="tool-step-dir">{file.dir}/</span> : null}
            <span className="tool-step-base">{file.base}</span>
          </span>
        ) : run.callSummary ? (
          <span className="tool-step-file" title={toolCallDisplayText(run)}>
            <span className="tool-step-base dim">{toolCallDisplayText(run)}</span>
          </span>
        ) : null}
        {failed ? <span className="tool-status failed">失败</span> : null}
        <AttributionAvatar
          name={run.human.name}
          avatar={run.human.avatar}
          color={run.human.color}
          live={!run.resultSummary && !failed && run.status !== "success"}
          human={lookupHuman(humans, run.human)}
        />
      </summary>
      <pre>{run.resultSummary || toolCallDisplayText(run) || JSON.stringify(run.callArguments || {}, null, 2)}</pre>
    </details>
  );
});

type ToolGroup = Extract<FeedRow, { kind: "tool-group" }>;

/** 同一数字人的连续工具调用：聚合头（执行过程 · N 步）+ 可展开明细，同普通对话 ActivityItem */
function ToolGroupBlock({ group, focusSeq, forceOpen, humans }: {
  group: ToolGroup;
  focusSeq: number | null;
  forceOpen: boolean;
  humans: DigitalHuman[];
}) {
  const doneCount = group.runs.filter((run) => run.resultSummary || run.status === "success" || run.status === "error").length;
  const running = doneCount < group.runs.length;
  const single = group.runs.length === 1;

  if (single) {
    return (
      <article className="message activity flat" data-seq={group.seq}>
        <div className="message-body">
          <RoomToolStep run={group.runs[0]} focused={focusSeq === group.runs[0].seq} humans={humans} />
        </div>
      </article>
    );
  }

  const title = running ? `正在执行 ${group.runs.length} 步` : `执行过程 · ${group.runs.length} 步`;
  return (
    <article className="message activity" data-seq={group.seq}>
      <div className="message-body">
        <details className="activity-detail" open={forceOpen || running || undefined}>
          <summary>
            <span className={`activity-state activity-state-${running ? "running" : "done"}`} />
            <span className="activity-title">{title}</span>
            {group.runs.length > 1 ? <span className="activity-count">{group.runs.length}</span> : null}
            <AttributionAvatar
              name={group.human.name}
              avatar={group.human.avatar}
              color={group.human.color}
              live={running}
              human={lookupHuman(humans, group.human)}
            />
            <ChevronIcon className="icon-12 chevron" />
          </summary>
          {running ? <div className="activity-progress" aria-hidden="true" /> : null}
          <div className="activity-list">
            {group.runs.map((run) => (
              <RoomToolStep key={run.id} run={run} focused={focusSeq === run.seq} humans={humans} />
            ))}
          </div>
        </details>
      </div>
    </article>
  );
}

// ── 主视图 ───────────────────────────────────────

const RoomCollaborationView = memo(function RoomCollaborationView({ port, roomId, humans, channelCode, approvalMode, onRoomChange, onRunningChange, onOpenArtifact, onOpenFile, starting = false, focusRequest }: Props) {
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [room, setRoom] = useState<ServerRoomView | null>(null);
  const [existingArtifactFiles, setExistingArtifactFiles] = useState<Set<string> | null>(null);
  const [loadError, setLoadError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(0);
  /** 已入库的事件 seq：SSE 在历史返回前就以 afterSeq=0 启动，会重推全量，按 seq 去重防"历史重刷一遍" */
  const seenSeqsRef = useRef<Set<number>>(new Set());
  const followOutputRef = useRef(true);
  const [canJumpLatest, setCanJumpLatest] = useState(false);

  // 初始：补历史 + 房间快照
  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    lastSeqRef.current = 0;
    seenSeqsRef.current = new Set();
    void (async () => {
      try {
        const [snapshot, history] = await Promise.all([
          fetchServerRoom(port, roomId),
          fetchRoomEvents(port, roomId, 0),
        ]);
        if (cancelled) return;
        setRoom(snapshot);
        onRoomChange?.(snapshot);
        setEvents(history);
        for (const event of history) seenSeqsRef.current.add(event.seq);
        lastSeqRef.current = history.reduce((max, e) => Math.max(max, e.seq), 0);
      } catch (caught) {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, roomId]);

  // 统一事件入库：SSE 实时推与轮询补拉共用；按 seq 去重，任务/参与者状态变化时刷新快照
  const ingestEvent = useCallback((event: RoomEvent) => {
    // 历史补拉与 SSE 全量重推会叠加：已见过的 seq 直接丢弃，避免消息/产物重复渲染
    if (seenSeqsRef.current.has(event.seq)) return;
    seenSeqsRef.current.add(event.seq);
    lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
    setEvents((current) => [...current, event]);
    // 任务/参与者状态变化时刷新房间快照
    if (["TASK_STATE_CHANGED", "PARTICIPANT_JOINED", "PARTICIPANT_LEFT", "PARTICIPANT_STATUS_CHANGED", "ARTIFACT_CREATED"].includes(event.type)) {
      void fetchServerRoom(port, roomId).then((snapshot) => {
        setRoom(snapshot);
        onRoomChange?.(snapshot);
      }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, roomId]);

  // 实时订阅（断线自动重连，按最新 seq 续传）
  useEffect(() => {
    const unsubscribe = subscribeRoomEvents(port, roomId, () => lastSeqRef.current, ingestEvent);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, roomId]);

  useEffect(() => {
    const paths = Array.from(new Set((room?.artifacts || []).flatMap(roomArtifactFilePaths)));
    if (paths.length === 0) {
      setExistingArtifactFiles(new Set());
      return;
    }
    setExistingArtifactFiles(null);
    let cancelled = false;
    void invoke<string[]>("existing_local_files", { paths })
      .then((existing) => {
        if (!cancelled) setExistingArtifactFiles(new Set(existing));
      })
      .catch(() => {
        if (!cancelled) setExistingArtifactFiles(new Set());
      });
    return () => { cancelled = true; };
  }, [room?.artifacts]);

  const feed = useMemo(() => buildRoomFeed(events, humans), [events, humans]);

  // ── 运行期审批：协作 Agent 走 REQUEST_APPROVAL 时会挂起等待桌面端裁决 ──
  // 桌面端配置的审批模式随任务下发；需审批时 Agent 阻塞在审批点，
  // 这里轮询待决审批并渲染裁决卡片，裁决后 Agent 就地继续执行。
  const [runtimeApprovals, setRuntimeApprovals] = useState<RuntimeApproval[]>([]);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const items = await listRuntimeApprovals(port);
        if (!cancelled) setRuntimeApprovals(items);
      } catch {
        // 服务未就绪时静默忽略，下一轮重试
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [port]);

  const resolveApproval = (approvalId: string, verdict: "ALLOW_ONCE" | "ALLOW_SESSION" | "DENY") => {
    setResolvingApprovalId(approvalId);
    void resolveRuntimeApproval(port, approvalId, verdict)
      .then(() => setRuntimeApprovals((current) => current.filter((item) => item.approvalId !== approvalId)))
      .catch(() => undefined)
      .finally(() => setResolvingApprovalId((id) => (id === approvalId ? null : id)));
  };


  // 兜底收口：服务端任务已全部结束但仍有消息/工具卡停留在 streaming/running（结束事件丢失）时，
  // 强制标记为完成，避免头像光圈或"正在执行 N 步"永久闪烁。
  const hasActiveTask = (room?.tasks || []).some((t) => ["READY", "ASSIGNED", "RUNNING", "WAITING_APPROVAL"].includes(t.state));
  const settledFeed = useMemo(() => {
    if (hasActiveTask || !room) return feed;
    let touched = false;
    const next = feed.map((item) => {
      if (item.kind === "human-message" && item.streaming) {
        touched = true;
        return { ...item, streaming: false };
      }
      if (item.kind === "tool" && item.status === "running") {
        touched = true;
        return { ...item, status: "success" as const, resultSummary: item.resultSummary || "（无输出）" };
      }
      return item;
    });
    return touched ? next : feed;
  }, [feed, hasActiveTask, room]);

  const rows = useMemo(() => foldToolRuns(settledFeed), [settledFeed]);

  // 右侧群聊点选：滚动定位到目标条目并短暂高亮（命中折叠组时自动展开）
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const [revealGroupSeq, setRevealGroupSeq] = useState<number | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const group = rows.find(
      (row): row is Extract<FeedRow, { kind: "tool-group" }> =>
        row.kind === "tool-group" && row.runs.some((run) => run.seq === focusRequest.seq),
    );
    setRevealGroupSeq(group ? group.seq : null);
    setFocusSeq(focusRequest.seq);
    const raf = requestAnimationFrame(() => {
      const node = listRef.current?.querySelector(`[data-seq="${focusRequest.seq}"]`);
      node?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const timer = window.setTimeout(() => setFocusSeq(null), 2400);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, [focusRequest, rows]);

  // 自动滚动到底（仅当用户本来就在底部时跟随）
  useEffect(() => {
    const node = listRef.current;
    if (node && followOutputRef.current) node.scrollTop = node.scrollHeight;
  }, [rows]);

  const activeTasks = useMemo(
    () => (room?.tasks || []).filter((t) => ["READY", "ASSIGNED", "RUNNING", "WAITING_APPROVAL"].includes(t.state)),
    [room],
  );

  // 运行态上抛：输入框据此禁用，避免协作任务并发提交
  const running = activeTasks.length > 0;
  const latestUserSeq = settledFeed.reduce(
    (seq, item) => item.kind === "user" ? Math.max(seq, item.seq) : seq,
    -1,
  );
  const hasCurrentResponse = settledFeed.some((item) => (
    item.seq > latestUserSeq
    && ["human-message", "tool-group", "plan", "artifact", "approval", "error"].includes(item.kind)
  ));
  const showTypingIndicator = (running || (starting && !room)) && !hasCurrentResponse;
  useEffect(() => {
    if (room) onRunningChange?.(running);
  }, [onRunningChange, room, running]);

  // 对账轮询：房间 SSE 断链（plugin-http 静默丢流）时，TASK_STATE_CHANGED 收不到，
  // room.tasks 快照停在"运行中"，上面的兜底收口与 running 状态都会永久卡死。
  // 任务运行期间定期向服务端对账：按 seq 补拉丢失事件 + 刷新快照，不依赖 SSE 存活。
  useEffect(() => {
    if (!running) return;
    const reconcile = async () => {
      try {
        const missed = await fetchRoomEvents(port, roomId, lastSeqRef.current);
        for (const event of missed) ingestEvent(event);
        const snapshot = await fetchServerRoom(port, roomId);
        setRoom(snapshot);
        onRoomChange?.(snapshot);
      } catch {
        // 服务未就绪/瞬时失败：静默，下一轮重试
      }
    };
    const timer = window.setInterval(() => void reconcile(), 5_000);
    return () => window.clearInterval(timer);
  }, [running, port, roomId, ingestEvent, onRoomChange]);

  const scrollToBottom = () => {
    followOutputRef.current = true;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  };

  if (loadError) {
    return <div className="room-error">协作事件加载失败：{loadError}</div>;
  }

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
            void invoke("open_external", { url: href }).catch((error) => {
              console.error("打开外部链接失败:", error);
            });
          }
        }}
      >
        {children}
      </a>
    ),
    pre: ({ children }: { children?: ReactNode }) => {
      const child = Array.isArray(children) ? children[0] : children;
      const className = (child as { props?: { className?: string } })?.props?.className || "";
      const match = /language-(\w+)/.exec(className);
      if (match && ["echart", "echarts"].includes(match[1])) {
        const code = extractText(child).trim();
        if (code.startsWith("{")) return <EChartBlock code={code} />;
      }
      return <pre>{children}</pre>;
    },
  }), [onOpenFile]);

  const renderMarkdown = (value: string): ReactNode => (
    <ReactMarkdown remarkPlugins={[remarkGfmCompatible]} components={markdownComponents}>{value}</ReactMarkdown>
  );

  return (
    <div className="room-view">
      <div
        className="conversation-scroll room-as-conversation"
        ref={listRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
          followOutputRef.current = distance < 84;
          setCanJumpLatest(distance > 240);
        }}
      >
        <div className="conversation-column">
      {rows.length === 0 && !showTypingIndicator ? (
        <div className="room-empty">
          <div className="dh-empty-icon">💬</div>
          <p>把数字人加入后，@ 或直接描述目标开始协作</p>
        </div>
      ) : (
        <>
        {rows.map((item) => {
          const focusClass = focusSeq === item.seq ? " room-focus" : "";
          const dataSeq = { "data-seq": item.seq };
          if (item.kind === "tool-group") {
            return (
              <ToolGroupBlock
                key={item.id}
                group={item}
                focusSeq={focusSeq}
                forceOpen={revealGroupSeq === item.seq}
                humans={humans}
              />
            );
          }
          if (item.kind === "user") {
            return (
              <article key={item.id} {...dataSeq} className={`message user${focusClass}`}>
                <div className="message-body">
                  <div className="message-content">{renderMarkdown(item.content)}</div>
                  <div className="message-meta">
                    {item.occurredAt ? <span className="message-time">{formatMessageTime(item.occurredAt)}</span> : null}
                  </div>
                </div>
              </article>
            );
          }
          if (item.kind === "sys") {
            return <div key={item.id} {...dataSeq} className={`room-sys${focusClass}`}>{item.text}</div>;
          }
          if (item.kind === "plan") {
            return (
              <article key={item.id} {...dataSeq} className={`message assistant${focusClass}`}>
                <div className="message-body">
                  <div className="message-content">
                    {renderMarkdown(
                      `**协作调度 · 分工计划（${item.steps.length} 步）**\n\n${item.steps.map((step) => `${step.seq}. ${step.title} — ${step.assigneeName}`).join("\n")}`,
                    )}
                    <span className="msg-attribution-inline" title="协作调度" style={{ pointerEvents: "none" }}>
                      <span className="msg-attribution-avatar" style={{ background: "#4160f0" }}>✦</span>
                    </span>
                  </div>
                  <div className="message-meta" />
                </div>
              </article>
            );
          }
          if (item.kind === "human-message") {
            return (
              <article key={item.id} {...dataSeq} className={`message assistant attributed${focusClass}`}>
                <div className="message-body">
                  <div className="message-content">
                    {renderMarkdown(item.content || "…")}
                    {!item.streaming ? <InlineFileCards content={item.content} onOpenFile={onOpenFile} /> : null}
                    {item.streaming ? <span className="room-cursor" aria-hidden>▍</span> : null}
                    <AttributionAvatar
                      name={item.human.name}
                      avatar={item.human.avatar}
                      color={item.human.color}
                      live={item.streaming}
                      human={lookupHuman(humans, item.human)}
                    />
                  </div>
                  <div className="message-meta">
                    {item.occurredAt ? <span className="message-time">{formatMessageTime(item.occurredAt)}</span> : null}
                  </div>
                </div>
              </article>
            );
          }
          if (item.kind === "artifact") {
            const readyArtifact = (room?.artifacts || []).find((artifact) => (
              artifact.artifactId === item.artifactId || artifact.title === item.title
            ));
            const availability = roomArtifactAvailability(readyArtifact, existingArtifactFiles);
            const canPreview = roomArtifactHasPreview(readyArtifact) && availability === "ready" && Boolean(onOpenArtifact);
            // 右键菜单目标：产物绑定且真实存在的本地文件
            const artifactMenuPath = roomArtifactFilePaths(readyArtifact).find((path) => existingArtifactFiles?.has(path)) || null;
            const disabledTitle = availability === "missing" ? "文件已不存在，无法查看" : "产物内容还在生成，稍后可查看";
            const metaText = canPreview ? readyArtifact?.kind || item.kindLabel : availability === "missing" ? "文件已不存在" : "内容生成中";
            const openText = canPreview ? "查看 →" : availability === "missing" ? "已失效" : "稍后可查看";
            return (
              <article key={item.id} {...dataSeq} className={`message assistant${focusClass}`}>
                <div className="message-body">
                  <FileActionsArea path={artifactMenuPath}>
                    <button
                      type="button"
                      className={`room-artifact${canPreview ? " clickable" : availability === "missing" ? " missing" : " pending"}`}
                      title={canPreview ? "点击在右侧查看" : disabledTitle}
                      disabled={!canPreview}
                      onClick={canPreview ? () => onOpenArtifact?.({ artifactId: item.artifactId, title: item.title, producerName: item.human.name }) : undefined}
                    >
                      <span className="room-artifact-icon">📄</span>
                      <div className="room-artifact-text">
                        <div className="room-artifact-title">{item.title}</div>
                        <div className="room-artifact-meta">{metaText}</div>
                      </div>
                      <span className="room-artifact-open">{openText}</span>
                    </button>
                  </FileActionsArea>
                  <div className="message-meta">
                    <AttributionAvatar
                      name={item.human.name}
                      avatar={item.human.avatar}
                      color={item.human.color}
                      human={lookupHuman(humans, item.human)}
                    />
                  </div>
                </div>
              </article>
            );
          }
          if (item.kind === "handoff") {
            return <div key={item.id} {...dataSeq} className={`room-sys${focusClass}`}>🔀 {item.fromName} 完成，交接下游</div>;
          }
          if (item.kind === "approval") {
            return (
              <article key={item.id} {...dataSeq} className={`message assistant${focusClass}`}>
                <div className="message-body">
                  <div className={`room-approval${item.resolved ? " resolved" : ""}`}>
                    <div className="room-approval-head">
                      <AttributionAvatar
                        name={item.human.name}
                        avatar={item.human.avatar}
                        color={item.human.color}
                        human={lookupHuman(humans, item.human)}
                      />
                      {item.human.name} 请求确认写操作
                    </div>
                    <div className="room-approval-cmd">{item.summary || "执行写操作"}</div>
                    {item.resolved ? (
                      <span className={`room-tool-state ${item.resolved === "ALLOW" ? "done" : "error"}`}>
                        {item.resolved === "ALLOW" ? "已允许" : "已拒绝"}
                      </span>
                    ) : (
                      <div className="room-approval-actions">
                        <button
                          type="button"
                          className="primary-action compact"
                          onClick={() => void digitalHumanTokensFor(humans)
                            .then((tokens) => resumeRoomTask(port, roomId, item.taskId, channelCode, approvalMode, tokens))
                            .catch(() => undefined)}
                        >
                          允许并继续
                        </button>
                        <button
                          type="button"
                          className="ghost-action compact danger-text"
                          onClick={() => void cancelRoomTask(port, roomId, item.taskId).catch(() => undefined)}
                        >
                          拒绝
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          }
          if (item.kind === "error") {
            return (
              <article key={item.id} {...dataSeq} className={`message assistant${focusClass}`}>
                <div className="message-body">
                  <div className="room-error-card">
                    执行失败：{item.message}
                    {" "}
                    <AttributionAvatar
                      name={item.human.name}
                      avatar={item.human.avatar}
                      color={item.human.color}
                      human={lookupHuman(humans, item.human)}
                    />
                  </div>
                </div>
              </article>
            );
          }
          return null;
        })}
        {runtimeApprovals.map((approval) => (
          <article key={approval.approvalId} className="message assistant">
            <div className="message-body">
              <div className="room-approval">
                <div className="room-approval-head">
                  ⚠️ 数字人请求执行需审批操作
                  {approval.sessionId ? <span className="room-approval-session" title={approval.sessionId}>（{approval.toolName || "工具调用"}）</span> : null}
                </div>
                <div className="room-approval-cmd">
                  {approval.displayCommand
                    || (approval.arguments ? JSON.stringify(approval.arguments) : approval.toolName || "执行写操作")}
                </div>
                <div className="room-approval-actions">
                  <button
                    type="button"
                    className="primary-action compact"
                    disabled={resolvingApprovalId === approval.approvalId}
                    onClick={() => resolveApproval(approval.approvalId, "ALLOW_ONCE")}
                  >
                    {resolvingApprovalId === approval.approvalId ? "处理中…" : "允许一次"}
                  </button>
                  <button
                    type="button"
                    className="ghost-action compact"
                    disabled={resolvingApprovalId === approval.approvalId}
                    onClick={() => resolveApproval(approval.approvalId, "ALLOW_SESSION")}
                  >
                    允许本会话
                  </button>
                  <button
                    type="button"
                    className="ghost-action compact danger-text"
                    disabled={resolvingApprovalId === approval.approvalId}
                    onClick={() => resolveApproval(approval.approvalId, "DENY")}
                  >
                    拒绝
                  </button>
                </div>
              </div>
            </div>
          </article>
        ))}
        {showTypingIndicator ? (
          <article className="message assistant" aria-live="polite">
            <div className="message-body">
              <div className="typing-indicator" role="status" aria-label="正在生成回复">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </div>
            </div>
          </article>
        ) : null}
        </>
      )}
        </div>
      </div>
      {canJumpLatest ? (
        <button className="jump-latest" type="button" onClick={scrollToBottom} aria-label="回到最新" title="回到最新">
          <ArrowDownIcon className="icon-18" />
        </button>
      ) : null}
    </div>
  );
});

export default RoomCollaborationView;
