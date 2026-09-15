import { useCallback, useEffect, useState } from "react";
import { listProjectDirectories } from "../lib/agent-client";
import type {
  AvailableModel,
  ConversationMessage,
  PluginSummary,
  RuntimeApproval,
  WorkspaceEntry,
  GitBranchState,
} from "../types";
import {
  BrowserIcon,
  ChevronIcon,
  FileIcon,
  FolderIcon,
  ReviewIcon,
  TerminalIcon,
} from "./icons";

type InfoTab = "overview" | "files" | "activity";

type InfoPanelProps = {
  port: number | null;
  project?: WorkspaceEntry;
  gitBranch?: GitBranchState | null;
  activeModel?: AvailableModel;
  messages: ConversationMessage[];
  approvals: RuntimeApproval[];
  plugins: PluginSummary[];
  streaming: boolean;
  activeSessionId: string;
  onStartTask: (prompt: string) => void;
};

function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function metric(label: string, value: string | number) {
  return (
    <div className="info-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function InfoPanel({
  port,
  project,
  gitBranch,
  activeModel,
  messages,
  approvals,
  plugins,
  streaming,
  activeSessionId,
  onStartTask,
}: InfoPanelProps) {
  const [tab, setTab] = useState<InfoTab>("overview");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [directoryCache, setDirectoryCache] = useState<Record<string, string[]>>({});
  const [loadingPath, setLoadingPath] = useState("");

  const loadDirectories = useCallback(async (path: string) => {
    if (!port) return;
    setLoadingPath(path);
    try {
      const directories = await listProjectDirectories(port, path);
      setDirectoryCache((current) => ({ ...current, [path]: directories }));
    } catch {
      setDirectoryCache((current) => ({ ...current, [path]: [] }));
    } finally {
      setLoadingPath("");
    }
  }, [port]);

  useEffect(() => {
    setExpanded({});
    setDirectoryCache({});
    if (project?.path) void loadDirectories(project.path);
  }, [loadDirectories, project?.path]);

  const rootDirectories = project?.path ? directoryCache[project.path] || [] : [];
  const renderDirectory = (path: string, depth: number) => {
    const isExpanded = expanded[path];
    return (
      <div key={path} style={{ paddingLeft: depth * 12 }}>
        <button
          className={isExpanded ? "tree-row expanded" : "tree-row"}
          onClick={() => {
            setExpanded((current) => ({ ...current, [path]: !isExpanded }));
            void loadDirectories(path);
          }}
        >
          <ChevronIcon className={`icon-12 chevron ${isExpanded ? "expanded" : ""}`} />
          <FolderIcon className="icon-14" />
          <span>{fileName(path)}</span>
          {loadingPath === path ? <em>加载中</em> : null}
        </button>
        {isExpanded ? (directoryCache[path] || []).map((child) => renderDirectory(child, depth + 1)) : null}
      </div>
    );
  };

  return (
    <aside className="info-panel">
      <div className="info-tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>概览</button>
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>项目分支</button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>活动</button>
      </div>

      <div className="info-scroll">
        {tab === "overview" ? (
          <>
            <section className="info-actions">
              <button onClick={() => onStartTask("审查当前项目，重点检查潜在缺陷、风险和可以立即改进的地方。")}>
                <ReviewIcon className="icon-16" />
                <span>代码审查</span>
                <kbd>⌃⇧G</kbd>
              </button>
              <button onClick={() => onStartTask("打开当前项目的终端工作流，先检查项目状态和最近的构建结果。")}>
                <TerminalIcon className="icon-16" />
                <span>终端</span>
                <kbd>⌃⌥</kbd>
              </button>
              <button onClick={() => onStartTask("使用浏览器验证当前项目相关的页面或接口，并汇总关键结果。")}>
                <BrowserIcon className="icon-16" />
                <span>浏览器</span>
                <kbd>⌘T</kbd>
              </button>
              <button onClick={() => onStartTask("检查当前项目的关键文件，并告诉我最值得先阅读或修改的文件。")}>
                <FileIcon className="icon-16" />
                <span>文件</span>
                <kbd>⌘P</kbd>
              </button>
            </section>
            <section className="info-card">
              <h4>当前项目</h4>
              <div className="info-row"><span>名称</span><strong>{project?.name || "默认工作区"}</strong></div>
              <div className="info-row"><span>路径</span><code>{project?.path || "未绑定目录"}</code></div>
              <div className="info-row"><span>分支</span><strong>{gitBranch?.branch || "读取中…"}</strong></div>
              <div className="info-row"><span>会话</span><strong>{activeSessionId}</strong></div>
            </section>
            <section className="info-card">
              <h4>模型</h4>
              <div className="info-row"><span>当前</span><strong>{activeModel?.modelCode || "未配置"}</strong></div>
              <div className="info-row"><span>渠道</span><strong>{activeModel?.channelCode || "—"}</strong></div>
              <div className="info-row"><span>生成中</span><strong>{streaming ? "是" : "否"}</strong></div>
              <div className="info-row"><span>插件</span><strong>{plugins.length}</strong></div>
            </section>
          </>
        ) : null}

        {tab === "files" ? (
          <section className="info-card">
            <h4>项目分支</h4>
            {!project?.path ? <div className="empty-note">未选择项目</div> : null}
            {project?.path && rootDirectories.length === 0 && !loadingPath ? (
              <div className="empty-note">暂无子目录</div>
            ) : null}
            <div className="directory-tree">{rootDirectories.map((directory) => renderDirectory(directory, 0))}</div>
          </section>
        ) : null}

        {tab === "activity" ? (
          <>
            <section className="info-metric-grid">
              {metric("消息", messages.length)}
              {metric("审批", approvals.length)}
              {metric("插件", plugins.length)}
            </section>
            <section className="info-card">
              <h4>待审批</h4>
              {approvals.length === 0 ? <div className="empty-note">没有待处理操作</div> : null}
              {approvals.map((approval) => (
                <div key={approval.approvalId} className="activity-item">
                  <strong>{approval.toolName || "Tool"}</strong>
                  <span>{approval.displayCommand || "等待审批"}</span>
                </div>
              ))}
            </section>
            <section className="info-card">
              <h4>最近消息</h4>
              {messages.length === 0 ? <div className="empty-note">暂无消息</div> : null}
              {messages.slice(-5).reverse().map((message, index) => (
                <div key={`${message.role}-${index}`} className="activity-item">
                  <strong>{message.role === "user" ? "You" : "Agent"}</strong>
                  <span>{message.content.slice(0, 90) || "生成中…"}</span>
                </div>
              ))}
            </section>
          </>
        ) : null}
      </div>
    </aside>
  );
}
