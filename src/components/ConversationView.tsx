import type { ApprovalMode, AvailableModel, ConversationMessage, ReasoningEffort, RuntimeApproval, WorkspaceEntry } from "../types";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDownIcon, FolderIcon, GitBranchIcon, PlusIcon, SendIcon, ShieldIcon, StopIcon } from "./icons";

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
  onSelectProject: (project: WorkspaceEntry) => void;
  onSelectDefaultWorkspace: () => void;
  onSwitchProjectBranch: (project: WorkspaceEntry, branch: string) => void;
  onCreateSession?: () => void;
  onDraftChange: (value: string) => void;
  onSend: () => void;
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
  if (typeof argument === "string" && argument.trim()) return argument.trim();
  if (message.result) {
    const result = message.result.trim().replace(/\s+/g, " ");
    return result.length > 96 ? `${result.slice(0, 96)}…` : result;
  }
  return "";
}

function activityState(messages: ConversationMessage[]): "running" | "error" | "done" {
  if (messages.some((message) => message.status === "running")) return "running";
  if (messages.some((message) => message.status === "error" || message.status === "failed")) return "error";
  return "done";
}

function activityKey(message: ConversationMessage, index: number): string {
  return message.callId || `${message.toolName || "tool"}-${index}`;
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
  onSelectProject,
  onSelectDefaultWorkspace,
  onSwitchProjectBranch,
  onCreateSession,
  onDraftChange,
  onSend,
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
  const [canJumpLatest, setCanJumpLatest] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const renderMarkdown = (value: string) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {value}
    </ReactMarkdown>
  );

  const lastMessage = messages[messages.length - 1];
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
    const visibleMessages = messages.filter((message, index) => {
      if (message.role !== "assistant") return true;
      const isLast = index === messages.length - 1;
      if (Boolean(message.content.trim() || message.reasoning?.trim())) return true;
      return isLast && streaming;
    });

    return visibleMessages.reduce<TimelineItem[]>((items, message, index) => {
      if (message.role === "tool") {
        const previous = items[items.length - 1];
        if (previous?.kind === "activity") {
          previous.messages.push(message);
          return items;
        }
        items.push({ kind: "activity", key: activityKey(message, index), messages: [message] });
        return items;
      }

      items.push({
        kind: "message",
        key: message.callId || message.createdAt || `${message.role}-${index}`,
        message,
        asThought: message.role === "assistant" && visibleMessages[index + 1]?.role === "tool",
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
        <textarea
          value={draft}
          placeholder="描述任务，或粘贴需求上下文"
          disabled={streaming}
          onChange={(event) => onDraftChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="prompt-toolbar">
          <div className="prompt-leading">
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
                  {projects.map((project) => (
                    <option key={project.path} value={project.path}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="branch-controls">
              {projects.map((project) => {
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
            <button
              className={streaming ? "composer-action stop" : "composer-action send"}
              onClick={streaming ? onStopGeneration : onSend}
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
}: {
  message: ConversationMessage;
  asThought?: boolean;
  renderMarkdown: (value: string) => ReactNode;
  streaming: boolean;
}) {
  const isTool = message.role === "tool";
  const reasoningText = asThought
    ? message.reasoning?.trim() || message.content.trim()
    : message.reasoning?.trim() || "";
  const contentText = asThought ? "" : message.content;
  return (
    <article className={`message ${message.role}`} aria-live={streaming ? "polite" : undefined}>
      <div className="message-avatar">{message.role === "user" ? "You" : "AI"}</div>
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
                  <span className="reasoning-label">思考</span>
                </summary>
                <pre>{reasoningText}</pre>
              </details>
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
          </>
        )}
      </div>
    </article>
  );
});

const ActivityItem = memo(function ActivityItem({ messages }: { messages: ConversationMessage[] }) {
  const state = activityState(messages);
  const latest = messages[messages.length - 1];
  const latestDetail = toolDetail(latest);

  return (
    <article className="message activity">
      <div className="message-avatar">⚙</div>
      <div className="message-body">
        <details className="activity-detail">
          <summary>
            <span className={`activity-state activity-state-${state}`} />
            <span className="activity-title">{state === "running" ? activityLabel(messages) : toolTitle(latest)}</span>
            {latestDetail ? <span className="activity-summary">{latestDetail}</span> : null}
            {messages.length > 1 ? <span className="activity-count">{messages.length}</span> : null}
          </summary>
          {state === "running" ? <div className="activity-progress" aria-hidden="true" /> : null}
          <div className="activity-list">
            {messages.map((message, index) => (
              <details key={activityKey(message, index)} className="tool-card-detail nested">
                <summary>
                  <span>{toolTitle(message)}</span>
                  {message.status ? (
                    <span className={`tool-status ${message.status}`}>
                      {message.status === "success" ? "完成" : message.status === "running" ? "执行中" : "失败"}
                    </span>
                  ) : null}
                </summary>
                <pre>{message.result || JSON.stringify(message.arguments || {}, null, 2)}</pre>
              </details>
            ))}
          </div>
        </details>
      </div>
    </article>
  );
});
