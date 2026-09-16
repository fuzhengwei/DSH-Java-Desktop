import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listMessages } from "../lib/agent-client";
import { normalizeConversationMessage, sessionTitle } from "../App";
import type { ConversationMessage, SessionSummary, WorkspaceEntry } from "../types";
import {
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  RefreshIcon,
  SlidersIcon,
  XIcon,
} from "./icons";

type InfoRailProps = {
  open: boolean;
  onClose: () => void;
  servicePort: number | null;
  serviceReady: boolean;
  sessions: SessionSummary[];
  activeProject?: WorkspaceEntry;
  activeBranch?: string;
};

type RailTab = "runs" | "files";

type GitChangedFile = {
  status: string;
  path: string;
  insertions?: number | null;
  deletions?: number | null;
};

type GitChangeSummary = {
  isRepo: boolean;
  branch: string;
  insertions: number;
  deletions: number;
  files: GitChangedFile[];
};

const FILE_TOOL_PATTERN = /write|edit|create|patch|apply|file|save|touch|mkdir/i;
const ARG_PATH_KEYS = ["path", "file", "filePath", "target", "filename", "name", "output", "destination", "cwd"];

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function summarizeResult(result?: string): string {
  if (!result) return "";
  const single = result.replace(/\s+/g, " ").trim();
  return single.length > 90 ? `${single.slice(0, 90)}…` : single;
}

function extractPathLike(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 200) return null;
    if (/[\\/]/.test(trimmed) || /\.[A-Za-z0-9]{1,10}$/.test(trimmed)) return trimmed;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractPathLike(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ARG_PATH_KEYS) {
      if (key in record) {
        const found = extractPathLike(record[key], depth + 1);
        if (found) return found;
      }
    }
    for (const key of Object.keys(record)) {
      const found = extractPathLike(record[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// 工具名/命令文本里直接抓路径（兼容 "shell_executecommand</arg_key><arg_value>mkdir ~/x/y</arg_value>" 这类脏字符串）
function extractPathFromText(text: string): string | null {
  const pattern = /(?:~|\/Users|\/home|\/tmp|\.)\/[\w.@+\-]+(?:\/[\w.@+\-]+)*/g;
  const matches = text.match(pattern);
  if (!matches) return null;
  // 取最长且带扩展名或目录特征的那个
  const candidates = matches.filter((m) => m.length > 3);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || path;
}

function parentDirOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join("/");
}

type FileCard = {
  key: string;
  fileName: string;
  parentDir: string;
  rawPath: string | null;
  toolName: string;
  sessionTitle: string;
  time: number;
  timeLabel: string;
  status: string;
  summary: string;
};

function buildFileCards(
  session: SessionSummary,
  messages: ConversationMessage[],
  timeOf: (message: ConversationMessage) => number,
): FileCard[] {
  const cards: FileCard[] = [];
  const seenPaths = new Set<string>();
  for (const message of messages) {
    const isTool = message.role === "tool" || Boolean(message.toolName);
    if (!isTool) continue;
    const toolNameRaw = message.toolName || "工具";
    // 清理工具名里混入的 arg 标记垃圾
    const toolName = toolNameRaw.split("</arg_key>")[0] || "工具";
    const rawPath = extractPathLike(message.arguments);
    const fromResult = rawPath ? null : extractPathLike(message.result);
    let pathLike = rawPath || fromResult;
    // 兜底：从命令/工具名文本里抓路径（shell_execute、job_run 等）
    if (!pathLike && /shell|command|job_run|exec|bash/i.test(toolNameRaw)) {
      const fromCommand = extractPathFromText(toolNameRaw)
        || extractPathFromText(String(message.arguments?.command || message.arguments?.input || ""));
      if (fromCommand && /\.[A-Za-z0-9]{1,10}$/.test(fromCommand)) {
        pathLike = fromCommand;
      }
    }
    const isFileTool = FILE_TOOL_PATTERN.test(toolName) || /fs_write|fs_read|fs_edit/i.test(toolName);
    if (!pathLike && !isFileTool) continue;
    // 目录路径（无扩展名）只收一次，避免 mkdir/ls 刷屏
    const dedupeKey = pathLike || toolName;
    if (seenPaths.has(dedupeKey)) continue;
    seenPaths.add(dedupeKey);
    const display = pathLike || toolName;
    const time = timeOf(message);
    cards.push({
      key: message.callId || `${toolName}-${cards.length}`,
      fileName: fileNameOf(display),
      parentDir: pathLike ? parentDirOf(pathLike) : "",
      rawPath: pathLike,
      toolName,
      sessionTitle: sessionTitle(session),
      time,
      timeLabel: time ? formatDateTime(time) : "",
      status: message.status || "done",
      summary: summarizeResult(message.result),
    });
  }
  return cards;
}

export default function InfoRail(props: InfoRailProps) {
  const {
    open,
    onClose,
    servicePort,
    serviceReady,
    sessions,
    activeProject,
    activeBranch,
  } = props;

  const [tab, setTab] = useState<RailTab>("runs");
  const [fileCards, setFileCards] = useState<FileCard[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [copiedKey, setCopiedKey] = useState("");
  const [gitChanges, setGitChanges] = useState<GitChangeSummary | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitExpanded, setGitExpanded] = useState(false);

  useEffect(() => {
    if (!open || tab !== "files" || filesLoaded) return;
    if (!serviceReady || !servicePort) {
      setFilesLoaded(true);
      return;
    }
    let cancelled = false;
    setFilesLoading(true);
    setFilesError("");
    const recent = sessions.slice(0, 6);
    void (async () => {
      try {
        const groups = await Promise.all(recent.map(async (session) => {
          const id = session.sessionId || session.agentId;
          if (!id) return [] as FileCard[];
          const loaded = await listMessages(servicePort, id);
          const normalized = loaded
            .map(normalizeConversationMessage)
            .filter((message): message is ConversationMessage => Boolean(message));
          const timeOf = (message: ConversationMessage) => Date.parse(message.createdAt || "") || 0;
          return buildFileCards(session, normalized, timeOf);
        }));
        if (cancelled) return;
        const merged = groups.flat().sort((a, b) => b.time - a.time).slice(0, 40);
        setFileCards(merged);
        setFilesLoaded(true);
      } catch (caught) {
        if (cancelled) return;
        setFilesError(caught instanceof Error ? caught.message : "文件信息加载失败");
        setFilesLoaded(true);
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setFilesLoading(false);
    };
    // filesLoading 故意不放进依赖：effect 重跑时旧任务会被 cleanup 取消，
    // 若因 filesLoading=true 提前 return，旧任务已取消而新任务不启动，会永久卡在"正在扫描"。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, filesLoaded, serviceReady, servicePort, sessions]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !activeProject?.path) {
      setGitChanges(null);
      return;
    }
    let cancelled = false;
    setGitLoading(true);
    void invoke<GitChangeSummary>("project_git_changes", { path: activeProject.path })
      .then((summary) => {
        if (!cancelled) setGitChanges(summary);
      })
      .catch(() => {
        if (!cancelled) setGitChanges(null);
      })
      .finally(() => {
        if (!cancelled) setGitLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeProject?.path]);

  const refreshGit = () => {
    if (!activeProject?.path) return;
    setGitLoading(true);
    void invoke<GitChangeSummary>("project_git_changes", { path: activeProject.path })
      .then(setGitChanges)
      .catch(() => undefined)
      .finally(() => setGitLoading(false));
  };

  const copyPath = (card: FileCard) => {
    if (!card.rawPath) return;
    void navigator.clipboard?.writeText(card.rawPath).then(() => {
      setCopiedKey(card.key);
      window.setTimeout(() => setCopiedKey(""), 1500);
    }).catch(() => undefined);
  };

  const switchTab = (next: RailTab) => {
    setTab(next);
    if (next === "files") setFilesLoaded(false);
  };

  if (!open) return null;

  return (
      <aside className="info-rail">
        <header className="info-rail-head">
          <div className="info-rail-title">
            <SlidersIcon className="info-rail-title-icon" />
            <span>信息栏</span>
          </div>
          <button type="button" className="rail-close" onClick={onClose} aria-label="关闭">
            <XIcon className="rail-close-icon" />
          </button>
        </header>

        <div className="rail-tabs">
          <button
            type="button"
            className={tab === "runs" ? "rail-tab active" : "rail-tab"}
            onClick={() => switchTab("runs")}
          >
            运行信息
          </button>
          <button
            type="button"
            className={tab === "files" ? "rail-tab active" : "rail-tab"}
            onClick={() => switchTab("files")}
          >
            产出文件
          </button>
        </div>

        {tab === "runs" ? (
          <div className="rail-body">
            <section className="rail-section">
              <div className="rail-section-head">
                <FolderIcon className="rail-section-icon" />
                <span>当前工作区</span>
              </div>
              <div className="rail-kv">
                <div className="rail-kv-row">
                  <span className="rail-kv-key">工程</span>
                  <span className="rail-kv-value">{activeProject?.name || "默认工作区"}</span>
                </div>
                {activeProject?.path ? (
                  <div className="rail-kv-row">
                    <span className="rail-kv-key">路径</span>
                    <span className="rail-kv-value rail-mono" title={activeProject.path}>{activeProject.path}</span>
                  </div>
                ) : null}
                <div className="rail-kv-row">
                  <span className="rail-kv-key"><GitBranchIcon className="rail-inline-icon" />分支</span>
                  <span className="rail-kv-value rail-mono">{activeBranch || gitChanges?.branch || "—"}</span>
                </div>
                <div className="rail-kv-row">
                  <span className="rail-kv-key">服务</span>
                  <span className={serviceReady ? "rail-badge ok" : "rail-badge warn"}>
                    {serviceReady ? "运行中" : "未连接"}
                  </span>
                </div>
              </div>
            </section>

            {activeProject?.path && gitChanges?.isRepo ? (
              <section className="rail-section">
                <div className="rail-section-head">
                  <GitBranchIcon className="rail-section-icon" />
                  <span>变更</span>
                  <span className="rail-diff">
                    <em className="rail-diff-add">+{gitChanges.insertions.toLocaleString()}</em>
                    <em className="rail-diff-del">-{gitChanges.deletions.toLocaleString()}</em>
                  </span>
                  <button
                    type="button"
                    className="rail-refresh"
                    onClick={refreshGit}
                    aria-label="刷新变更"
                  >
                    <RefreshIcon className={gitLoading ? "rail-refresh-icon spinning" : "rail-refresh-icon"} />
                  </button>
                </div>
                {gitChanges.files.length === 0 ? (
                  <p className="rail-empty">工作区干净，暂无变更</p>
                ) : (
                  <>
                    <ul className="rail-git-list">
                      {(gitExpanded ? gitChanges.files : gitChanges.files.slice(0, 5)).map((file) => (
                        <li key={`${file.status}-${file.path}`} className="rail-git-row">
                          <span className={`rail-git-status s-${file.status}`}>{file.status}</span>
                          <span className="rail-git-path rail-mono" title={file.path}>{fileNameOf(file.path)}</span>
                          <span className="rail-git-diff rail-mono">
                            {file.insertions != null ? <em className="rail-diff-add">+{file.insertions}</em> : null}
                            {file.deletions != null && file.deletions > 0 ? <em className="rail-diff-del">-{file.deletions}</em> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {gitChanges.files.length > 5 ? (
                      <button type="button" className="rail-git-more" onClick={() => setGitExpanded((value) => !value)}>
                        {gitExpanded ? "收起" : `查看全部 ${gitChanges.files.length} 个文件`}
                      </button>
                    ) : null}
                  </>
                )}
              </section>
            ) : null}
          </div>
        ) : (
          <div className="rail-body">
            <section className="rail-section rail-section-grow">
              <div className="rail-section-head">
                <FileIcon className="rail-section-icon" />
                <span>对话产出的文件</span>
                <em className="rail-count">{fileCards.length}</em>
                <button
                  type="button"
                  className="rail-refresh"
                  onClick={() => setFilesLoaded(false)}
                  aria-label="刷新"
                >
                  <RefreshIcon className={filesLoading ? "rail-refresh-icon spinning" : "rail-refresh-icon"} />
                </button>
              </div>
              {filesLoading ? (
                <p className="rail-empty">正在扫描最近对话的工具调用…</p>
              ) : filesError ? (
                <p className="rail-empty rail-error">{filesError}</p>
              ) : fileCards.length === 0 ? (
                <p className="rail-empty">
                  {serviceReady ? "最近对话中未发现文件产出" : "服务未连接，无法读取对话文件信息"}
                </p>
              ) : (
                <ul className="rail-file-list">
                  {fileCards.map((card) => (
                    <li key={`${card.sessionTitle}-${card.key}`} className="rail-file">
                      <div className="rail-file-icon">
                        <FileIcon className="rail-file-icon-svg" />
                      </div>
                      <div className="rail-file-main">
                        <div className="rail-file-name" title={card.rawPath || card.fileName}>{card.fileName}</div>
                        <div className="rail-file-meta">
                          <span>{card.sessionTitle}</span>
                          {card.timeLabel ? <span>· {card.timeLabel}</span> : null}
                          <span className={card.status === "error" || card.status === "failed" ? "rail-file-status error" : "rail-file-status"}>
                            {card.status === "running" ? "执行中" : card.status === "error" || card.status === "failed" ? "失败" : "完成"}
                          </span>
                        </div>
                        {card.parentDir ? <div className="rail-file-path rail-mono" title={card.rawPath || ""}>{card.parentDir}</div> : null}
                        {card.summary ? <div className="rail-file-summary">{card.summary}</div> : null}
                        {card.rawPath ? (
                          <button type="button" className="rail-file-copy" onClick={() => copyPath(card)}>
                            {copiedKey === card.key ? "已复制" : "复制路径"}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>
  );
}
