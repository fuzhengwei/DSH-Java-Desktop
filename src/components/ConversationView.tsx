import type { AgentActivity, ApprovalMode, AvailableModel, ConversationMessage, RuntimeApproval, WorkspaceEntry } from "../types";
import { useEffect, useRef } from "react";
import { FolderIcon, SendIcon, ShieldIcon, StopIcon } from "./icons";

type ConversationViewProps = {
  serviceReady: boolean;
  streaming: boolean;
  showReasoning: boolean;
  draft: string;
  messages: ConversationMessage[];
  activeModel?: AvailableModel;
  activeProject?: WorkspaceEntry;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStopGeneration: () => void;
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onShowReasoningChange: (value: boolean) => void;
  onOpenSettings: () => void;
  activity: AgentActivity[];
  approvals: RuntimeApproval[];
  resolvingApprovalId: string;
  onResolveApproval: (approvalId: string, verdict: "ALLOW_ONCE" | "DENY") => void;
};

export default function ConversationView({
  serviceReady,
  streaming,
  showReasoning,
  draft,
  messages,
  activeModel,
  activeProject,
  onDraftChange,
  onSend,
  onStopGeneration,
  approvalMode,
  onApprovalModeChange,
  onShowReasoningChange,
  onOpenSettings,
  activity,
  approvals,
  resolvingApprovalId,
  onResolveApproval,
}: ConversationViewProps) {
  const isHome = messages.length === 0;
  const messageListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  const renderComposer = (variant: "hero" | "chat") => (
    <>
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
              className="ghost-action compact"
              disabled={Boolean(resolvingApprovalId)}
              onClick={() => onResolveApproval(approvals[0].approvalId, "DENY")}
            >
              拒绝
            </button>
          </div>
        </div>
      ) : null}
      {variant === "chat" && activity.length > 0 ? (
        <div className="agent-activity" aria-live="polite">
          <div className="activity-track">
            {activity.slice(-4).map((item) => (
              <div key={item.id} className={`activity-item ${item.state}`}>
                <span className="activity-dot" />
                <div className="activity-copy">
                  <strong>{item.label}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </div>
                {item.state === "running" ? <span className="activity-pulse" /> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="project-context-bar">
        <span><FolderIcon className="icon-14" />{activeProject?.name || "默认工作区"}</span>
        <span className="context-divider" />
        <span>本地</span>
      </div>
      <div className={variant === "hero" ? "prompt-shell hero" : "prompt-shell chat"}>
        <textarea
          value={draft}
          placeholder="描述任务，或粘贴需求上下文"
          disabled={streaming}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="prompt-toolbar">
          <div className="prompt-leading">
            <div className="permission-select">
              <ShieldIcon className="icon-14" />
              <select
                className="permission-chip"
                value={approvalMode}
                title="选择工具执行权限"
                aria-label="工具执行权限"
                disabled={streaming}
                onChange={(event) => onApprovalModeChange(event.target.value as ApprovalMode)}
              >
                <option value="REQUEST_APPROVAL">请求审批</option>
                <option value="AUTO_APPROVE">替我审批</option>
                <option value="FULL_OPEN">完全开放</option>
              </select>
            </div>
          </div>
          <div className="prompt-meta">
            <button className={showReasoning ? "meta-chip active" : "meta-chip"} onClick={() => onShowReasoningChange(!showReasoning)}>
              Reasoning
            </button>
          </div>
          <div className="prompt-controls">
            <button className="model-control" title="打开模型设置" onClick={onOpenSettings}>
              <span>{activeModel?.displayName || activeModel?.modelCode || "模型"}</span>
            </button>
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
            <div className="conversation-scroll" ref={messageListRef}>
              {messages.map((message, index) => (
                <article key={`${message.role}-${index}`} className={`message ${message.role}`}>
                  <div className="message-avatar">{message.role === "user" ? "You" : "AI"}</div>
                  <div className="message-body">
                    {message.role === "tool" ? (
                      <div className="tool-card">
                        <div className="tool-card-head">
                          <strong>{message.toolName || "Tool"}</strong>
                          <span className={`tool-status ${message.status || "running"}`}>
                            {message.status === "success" ? "完成" : message.status === "running" ? "执行中" : "失败"}
                          </span>
                        </div>
                        {message.result ? <pre>{message.result}</pre> : <pre>{JSON.stringify(message.arguments || {}, null, 2)}</pre>}
                      </div>
                    ) : (
                      <>
                        {message.reasoning && showReasoning ? (
                          <details className="reasoning-block" open={!message.content}>
                            <summary>{streaming && !message.content ? "思考中" : "思考过程"}</summary>
                            <pre>{message.reasoning}</pre>
                          </details>
                        ) : null}
                        <div className="message-content">{message.content || (streaming ? "正在思考…" : "")}</div>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        <div className="composer-dock">
          {renderComposer(isHome ? "hero" : "chat")}
        </div>
      </div>
    </div>
  );
}
