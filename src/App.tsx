import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationView from "./components/ConversationView";
import Sidebar, { type WorkspaceView } from "./components/Sidebar";
import SettingsView, { type SettingsSection } from "./components/SettingsView";
import InfoRail from "./components/InfoRail";
import { SlidersIcon } from "./components/icons";
import { truncateSessionTitle } from "./lib/text";
import {
  activateModelSetting,
  deleteModelSetting,
  discoverModels,
  listAvailableModels,
  listMessages,
  listModelSettings,
  listRuntimeApprovals,
  listSessions,
  listWorkspaces,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  saveModelSetting,
  resolveRuntimeApproval,
  streamAgentMessage,
  waitForService,
} from "./lib/agent-client";
import type {
  AgentServiceState,
  ApprovalMode,
  AvailableModel,
  ConversationMessage,
  ModelDraft,
  ModelSetting,
  ReasoningEffort,
  SessionSummary,
  WorkspaceEntry,
  RuntimeApproval,
} from "./types";

const emptyModelDraft: ModelDraft = {
  displayName: "",
  providerCode: "custom",
  modelCode: "",
  baseUrl: "",
  apiKeyRef: "",
  protocol: "openai",
  enabled: true,
};

type ProjectEditTarget = {
  path: string;
  name: string;
  local?: boolean;
};

type GitBranchesState = {
  current: string;
  branches: string[];
};

function readDraftSessions(): SessionSummary[] {
  try {
    const drafts = JSON.parse(localStorage.getItem("dsh-draft-sessions") || "[]");
    return Array.isArray(drafts) ? drafts.filter((item): item is SessionSummary => Boolean(item && typeof item === "object")) : [];
  } catch {
    return [];
  }
}

/** 用户手动改过的会话标题：{ 任一 sessionId/agentId: 标题 }，优先于服务端 title 展示。 */
function readCustomSessionTitles(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem("dsh-session-custom-titles") || "{}");
    if (!raw || typeof raw !== "object") return {};
    const cleaned: Record<string, string> = {};
    for (const [id, title] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof title === "string" && title.trim()) cleaned[id] = title;
    }
    return cleaned;
  } catch {
    return {};
  }
}

/** 前端本地删除（隐藏）的会话 id 列表；服务端暂无删除接口，靠它在列表中过滤。 */
function readHiddenSessionIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem("dsh-hidden-session-ids") || "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
  } catch {
    return [];
  }
}

function sessionKey(session: SessionSummary): string {
  return session.agentId || session.sessionId || "";
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

function payloadString(payload: unknown, ...keys: string[]): string {
  if (typeof payload === "string") return payload;
  const record = payloadRecord(payload);
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function payloadArguments(payload: Record<string, unknown>): Record<string, unknown> {
  const value = payload.arguments ?? payload.args;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) return { input: value };
  return {};
}

function mergeStreamText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming === current || current.endsWith(incoming)) return current;
  if (incoming.startsWith(current)) return incoming;
  return current + incoming;
}

function readApprovalMode(): ApprovalMode {
  const value = localStorage.getItem("dsh-approval-mode");
  return value === "AUTO_APPROVE" || value === "FULL_OPEN" ? value : "REQUEST_APPROVAL";
}

function readReasoningEffort(): ReasoningEffort {
  const value = localStorage.getItem("dsh-reasoning-effort");
  return value === "low" || value === "high" ? value : "medium";
}

function readSessionMessages(sessionId: string): ConversationMessage[] {
  try {
    const cache = JSON.parse(localStorage.getItem("dsh-session-messages") || "{}");
    const messages = cache[sessionId];
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

function writeSessionMessages(sessionId: string, messages: ConversationMessage[]) {
  try {
    const cache = JSON.parse(localStorage.getItem("dsh-session-messages") || "{}");
    cache[sessionId] = messages;
    localStorage.setItem("dsh-session-messages", JSON.stringify(cache));
  } catch {
    return;
  }
}

const PROMPT_HISTORY_LIMIT = 100;

function readPromptHistory(): string[] {
  try {
    const history = JSON.parse(localStorage.getItem("dsh-prompt-history") || "[]");
    return Array.isArray(history)
      ? history.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(-PROMPT_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function normalizeConversationMessage(message: unknown): ConversationMessage | null {
  if (!message || typeof message !== "object") return null;
  const raw = message as Record<string, unknown>;
  const role = typeof raw.role === "string" ? raw.role : "";
  if (!role) return null;

  const parsedContent = parseThinkingMarkup(typeof raw.content === "string" ? raw.content : "");

  const normalized: ConversationMessage = {
    role,
    content: visibleMessageText(role === "user" ? visibleUserMessage(parsedContent.content) : parsedContent.content),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : raw.occurredAt as string | undefined,
  };
  if (parsedContent.reasoning) normalized.reasoning = parsedContent.reasoning;
  if (Array.isArray(raw.mentions)) {
    const mentions = raw.mentions.filter((item): item is WorkspaceEntry => Boolean(
      item && typeof item === "object"
      && typeof (item as Record<string, unknown>).name === "string"
      && typeof (item as Record<string, unknown>).path === "string",
    ));
    if (mentions.length > 0) normalized.mentions = mentions;
  }

  if (Array.isArray(raw.blocks)) {
    let reasoning = "";
    let text = "";
    for (const block of raw.blocks) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      const kind = typeof item.kind === "string" ? item.kind : "";
      const blockText = typeof item.text === "string" ? item.text : "";
      if (kind === "text" && blockText) text += text ? "\n" + blockText : blockText;
      if (kind === "reasoning" && blockText) reasoning += reasoning ? "\n" + blockText : blockText;
      if (kind === "tool-call") {
        normalized.toolName = typeof item.toolName === "string" ? item.toolName : normalized.toolName;
        normalized.callId = typeof item.callId === "string" ? item.callId : normalized.callId;
        const args = item.argsRaw ?? item.args ?? item.arguments;
        let parsedArgs: unknown = args;
        if (typeof args === "string") {
          try {
            parsedArgs = JSON.parse(args);
          } catch {
            parsedArgs = null;
          }
        }
        normalized.arguments = parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
          ? parsedArgs as Record<string, unknown>
          : typeof args === "string" ? { input: args } : normalized.arguments;
        normalized.status = typeof item.status === "string" ? item.status : normalized.status;
        normalized.result = typeof item.result === "string" ? item.result : normalized.result;
      }
    }
    if (text) normalized.content = visibleMessageText(text);
    if (reasoning) normalized.reasoning = [normalized.reasoning, visibleMessageText(reasoning)]
      .filter(Boolean)
      .join("\n\n");
  } else {
    if (typeof raw.reasoning === "string" && raw.reasoning) normalized.reasoning = raw.reasoning;
    if (typeof raw.toolName === "string" && raw.toolName) normalized.toolName = raw.toolName;
    if (typeof raw.callId === "string" && raw.callId) normalized.callId = raw.callId;
    if (raw.arguments && typeof raw.arguments === "object" && !Array.isArray(raw.arguments)) {
      normalized.arguments = raw.arguments as Record<string, unknown>;
    } else if (raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)) {
      normalized.arguments = raw.args as Record<string, unknown>;
    }
    if (typeof raw.result === "string" && raw.result) normalized.result = raw.result;
    if (typeof raw.status === "string" && raw.status) normalized.status = raw.status;
  }

  return normalized;
}

function newSessionId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function payloadText(payload: unknown): string {
  return payloadString(payload, "content", "text", "delta", "message", "info", "error", "result", "value");
}

const HIDDEN_CONTEXT_OPEN = "<hidden-context>";
const HIDDEN_CONTEXT_CLOSE = "</hidden-context>";

/** 去掉输入框 @ 标签内嵌的零宽空格（U+200B）——只是编辑器内部的边界标记，不进消息/提示词 */
function stripInvisibleChars(value: string): string {
  return value.replace(/​/g, "");
}

function visibleMessageText(value: string): string {
  let text = stripInvisibleChars(value);
  const openIndex = text.indexOf(HIDDEN_CONTEXT_OPEN);
  if (openIndex >= 0) {
    const closeIndex = text.indexOf(HIDDEN_CONTEXT_CLOSE, openIndex);
    text = closeIndex >= 0
      ? text.slice(0, openIndex) + text.slice(closeIndex + HIDDEN_CONTEXT_CLOSE.length)
      : text.slice(0, openIndex);
  }
  return text.replace(/\n?\[当前选择的工程\][\s\S]*$/, "").trim();
}

function parseThinkingMarkup(value: string): { content: string; reasoning: string } {
  let reasoning = "";
  const content = value.replace(/<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi, (match) => {
    const inner = match.replace(/^<(?:think|thinking|reasoning)>/i, "").replace(/<\/(?:think|thinking|reasoning)>$/i, "").trim();
    if (inner) reasoning += reasoning ? `\n\n${inner}` : inner;
    return "";
  });
  return {
    content: content.trim(),
    reasoning: reasoning.trim(),
  };
}

function visibleUserMessage(value: string): string {
  const marker = "用户原始请求：";
  const instructionPrefix = "请先使用可用工具完成下面的任务，";
  if (value.startsWith(instructionPrefix) && value.includes(marker)) {
    return value.slice(value.indexOf(marker) + marker.length).trim();
  }
  return value;
}

export function sessionTitle(session: SessionSummary, customTitles?: Record<string, string>): string {
  const customTitle = [session.sessionId, session.agentId]
    .map((id) => (id && customTitles ? customTitles[id] : ""))
    .find((title) => Boolean(title && title.trim()));
  // 用户手动改过的标题原样展示；否则把 title/lastMessage 压成缩略信息
  if (customTitle && customTitle.trim()) return customTitle.trim();
  const rawTitle = session.title || session.lastMessage || "";
  const summarized = truncateSessionTitle(visibleMessageText(visibleUserMessage(rawTitle)));
  return summarized || session.agentId || session.sessionId || "新对话";
}

function messagesFromPayload(payload: unknown): ConversationMessage[] | null {
  const messages = payloadRecord(payload).messages;
  if (!Array.isArray(messages)) return null;
  const normalized = messages.map(normalizeConversationMessage)
    .filter((message): message is ConversationMessage => Boolean(message));
  return normalized.filter((message, index) => (
    !(message.role === "user" && index > 0
      && normalized[index - 1].role === "user"
      && normalized[index - 1].content.trim() === message.content.trim())
  ));
}

export default function App() {
  const [activeView, setActiveView] = useState<WorkspaceView>("conversation");
  const [service, setService] = useState<AgentServiceState | null>(null);
  const [serviceStatus, setServiceStatus] = useState<"checking" | "stopped" | "running" | "starting">("checking");
  const [error, setError] = useState("");
  const [serviceError, setServiceError] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [draftSessions, setDraftSessions] = useState<SessionSummary[]>(readDraftSessions);
  const [customSessionTitles, setCustomSessionTitles] = useState<Record<string, string>>(readCustomSessionTitles);
  const [hiddenSessionIds, setHiddenSessionIds] = useState<string[]>(readHiddenSessionIds);
  const [projects, setProjects] = useState<WorkspaceEntry[]>([]);
  const [activeProjectPath, setActiveProjectPath] = useState("");
  const [sessionProjectMap, setSessionProjectMap] = useState<Record<string, string>>({});
  const [localProjects, setLocalProjects] = useState<WorkspaceEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(() => localStorage.getItem("dsh-active-session-id") || newSessionId());
  const [messages, setMessages] = useState<ConversationMessage[]>(() => readSessionMessages(localStorage.getItem("dsh-active-session-id") || ""));
  const [approvals, setApprovals] = useState<RuntimeApproval[]>([]);
  const [resolvingApprovalId, setResolvingApprovalId] = useState("");
  const [modelSettings, setModelSettings] = useState<ModelSetting[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModelDraft);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const [savingModel, setSavingModel] = useState(false);
  const [syncingModels, setSyncingModels] = useState(false);
  const [draft, setDraft] = useState("");
  const [promptHistory, setPromptHistory] = useState<string[]>(readPromptHistory);
  const appendPromptHistory = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPromptHistory((current) => {
      const next = [...current.filter((item) => item !== trimmed), trimmed].slice(-PROMPT_HISTORY_LIMIT);
      try {
        localStorage.setItem("dsh-prompt-history", JSON.stringify(next));
      } catch {
        // 存储失败不影响主流程
      }
      return next;
    });
  }, []);
  type SessionRunState = {
    startedAt: number;
    title: string;
    agentId: string;
    sessionId?: string;
  };
  const [sessionRuns, setSessionRuns] = useState<Record<string, SessionRunState>>({});
  const [lastRunDurations, setLastRunDurations] = useState<Record<string, number>>({});
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(readApprovalMode);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(readReasoningEffort);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectEditTarget | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  const [projectBranches, setProjectBranches] = useState<Record<string, string>>({});
  const [projectBranchOptions, setProjectBranchOptions] = useState<Record<string, string[]>>({});
  const [switchingBranchPath, setSwitchingBranchPath] = useState("");
  const [railOpen, setRailOpen] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const sessionMessagesRef = useRef<Map<string, ConversationMessage[]>>(new Map());
  const sessionRunsRef = useRef<Record<string, SessionRunState>>({});
  const connectingRef = useRef<Promise<void> | null>(null);
  const activeSessionRef = useRef(activeSessionId);
  const activeProjectPathRef = useRef(activeProjectPath);
  const draftSessionsRef = useRef(draftSessions);
  const sessionProjectMapRef = useRef(sessionProjectMap);
  const streaming = Boolean(sessionRuns[activeSessionId]);
  const anyStreaming = Object.keys(sessionRuns).length > 0;

  const port = service?.port ?? null;
  const serviceReady = serviceStatus === "running" && Boolean(port);
  const combinedSessions = useMemo(() => {
    // 同一会话在服务端和 draft 里可能分别用 sessionId / agentId 记录，
    // 去重时要检查任一 ID 是否已存在，避免重复出现
    const persistedIds = new Set<string>();
    for (const session of sessions) {
      if (session.agentId) persistedIds.add(session.agentId);
      if (session.sessionId) persistedIds.add(session.sessionId);
    }
    const merged = [
      ...sessions,
      ...draftSessions.filter((session) => {
        const agentId = session.agentId || "";
        const sessionId = session.sessionId || "";
        const hasAnyId = Boolean(agentId || sessionId);
        return hasAnyId && !persistedIds.has(agentId) && !persistedIds.has(sessionId);
      }),
    ];
    if (hiddenSessionIds.length === 0) return merged;
    // 本地删除的会话不再展示（服务端暂无删除接口，靠隐藏列表过滤）
    const hidden = new Set(hiddenSessionIds);
    return merged.filter((session) => !(
      (session.sessionId && hidden.has(session.sessionId))
      || (session.agentId && hidden.has(session.agentId))
    ));
  }, [draftSessions, hiddenSessionIds, sessions]);
  const combinedSessionsRef = useRef(combinedSessions);
  useEffect(() => {
    combinedSessionsRef.current = combinedSessions;
  }, [combinedSessions]);
  const activeSession = combinedSessions.find((session) => (
    session.agentId === activeSessionId || session.sessionId === activeSessionId
  ));
  const activeModel = useMemo(() => {
    const activeSetting = modelSettings.find((model) => model.active && model.enabled !== false);
    if (activeSetting) {
      return {
        channelCode: activeSetting.channelCode,
        displayName: activeSetting.displayName,
        providerCode: activeSetting.providerCode,
        modelCode: activeSetting.modelCode,
      };
    }
    return availableModels.find((model) => model.channelCode && model.modelCode) || availableModels[0];
  }, [availableModels, modelSettings]);

  const loadWorkspaceData = useCallback(async (servicePort: number, focusModelsIfEmpty = false) => {
    const [sessionsResult, projectsResult, modelSettingsResult, runtimeModelsResult, approvalsResult] =
      await Promise.allSettled([
        listSessions(servicePort),
        listWorkspaces(servicePort),
        listModelSettings(servicePort),
        listAvailableModels(servicePort),
        listRuntimeApprovals(servicePort),
      ]);

    if (sessionsResult.status === "fulfilled") {
      const loadedSessions = sessionsResult.value;
      setSessions(loadedSessions);
      // 重启/刷新后服务端返回的会话可能只有 sessionId，而映射当初只按草稿阶段的 agentId 记录，
      // 导致分组时按 sessionId 查不到项目、被错误归入"默认工作区"。这里做两级回填：
      // 1) 服务端 SessionHeader 持久化的 workspaceId（即会话创建时的 cwd / 项目路径）是权威来源；
      // 2) 本地映射里已存在的归属则补齐到同会话的其他 ID（agentId <-> sessionId）。
      setSessionProjectMap((current) => {
        let changed = false;
        const next = { ...current };
        for (const session of loadedSessions) {
          const ids = [session.sessionId, session.agentId].filter((id): id is string => Boolean(id));
          // 本地映射优先（发送消息时已按会话归属写入并与服务端 cwd 对齐）；
          // 服务端 workspaceId 仅作兜底，用于补齐本地缺失的老会话归属
          const projectPath = ids.map((id) => next[id]).find(Boolean) || session.workspaceId;
          if (!projectPath) continue;
          for (const id of ids) {
            if (next[id] !== projectPath) {
              next[id] = projectPath;
              changed = true;
            }
          }
        }
        return changed ? next : current;
      });
    }
    if (projectsResult.status === "fulfilled") {
      setProjects(projectsResult.value);
      setActiveProjectPath((current) => current || projectsResult.value[0]?.path || "");
    }
    const loadedModels = modelSettingsResult.status === "fulfilled" ? modelSettingsResult.value : [];
    const loadedRuntimeModels = runtimeModelsResult.status === "fulfilled" ? runtimeModelsResult.value : [];
    setModelSettings(loadedModels);
    setAvailableModels(loadedRuntimeModels);
    if (approvalsResult.status === "fulfilled") setApprovals(approvalsResult.value.filter(
      (approval) => !approval.sessionId || approval.sessionId === activeSessionRef.current,
    ));

    if (focusModelsIfEmpty && loadedModels.length === 0) {
      setActiveView("settings");
    }
  }, []);

  useEffect(() => {
    // 加载历史映射时剔除空串脏数据：旧版本曾把空值写入映射，会阻断回填逻辑
    const storedMap = JSON.parse(localStorage.getItem("dsh-session-project-map") || "{}") as Record<string, string>;
    const cleanedMap: Record<string, string> = {};
    for (const [id, path] of Object.entries(storedMap)) {
      if (typeof path === "string" && path) cleanedMap[id] = path;
    }
    if (Object.keys(cleanedMap).length !== Object.keys(storedMap).length) {
      localStorage.setItem("dsh-session-project-map", JSON.stringify(cleanedMap));
    }
    setSessionProjectMap(cleanedMap);
    setLocalProjects(JSON.parse(localStorage.getItem("dsh-local-projects") || "[]"));
    setDraftSessions(readDraftSessions());
  }, []);

  useEffect(() => {
    localStorage.setItem("dsh-active-session-id", activeSessionId);
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    activeProjectPathRef.current = activeProjectPath;
  }, [activeProjectPath]);

  useEffect(() => {
    draftSessionsRef.current = draftSessions;
  }, [draftSessions]);

  useEffect(() => {
    sessionProjectMapRef.current = sessionProjectMap;
  }, [sessionProjectMap]);

  useEffect(() => {
    sessionRunsRef.current = sessionRuns;
  }, [sessionRuns]);

  useEffect(() => {
    sessionMessagesRef.current.set(activeSessionId, messages);
  }, [activeSessionId, messages]);

  useEffect(() => {
    localStorage.setItem("dsh-session-project-map", JSON.stringify(sessionProjectMap));
  }, [sessionProjectMap]);

  useEffect(() => {
    writeSessionMessages(activeSessionId, messages);
  }, [activeSessionId, messages]);

  useEffect(() => {
    localStorage.setItem("dsh-local-projects", JSON.stringify(localProjects));
  }, [localProjects]);

  useEffect(() => {
    localStorage.setItem("dsh-draft-sessions", JSON.stringify(draftSessions));
  }, [draftSessions]);

  // 清理僵尸 draft：id 与服务端会话撞车被去重过滤、永远不可见的草稿，
  // 留着只会干扰「新对话」的复用判断
  useEffect(() => {
    if (sessions.length === 0 || draftSessions.length === 0) return;
    const persistedIds = new Set<string>();
    for (const session of sessions) {
      if (session.agentId) persistedIds.add(session.agentId);
      if (session.sessionId) persistedIds.add(session.sessionId);
    }
    const zombies = draftSessions.filter((draft) => {
      const agentId = draft.agentId || "";
      const sessionId = draft.sessionId || "";
      return (agentId && persistedIds.has(agentId)) || (sessionId && persistedIds.has(sessionId));
    });
    if (zombies.length > 0) {
      setDraftSessions((current) => current.filter((draft) => !zombies.includes(draft)));
    }
  }, [draftSessions, sessions]);

  useEffect(() => {
    localStorage.setItem("dsh-session-custom-titles", JSON.stringify(customSessionTitles));
  }, [customSessionTitles]);

  useEffect(() => {
    localStorage.setItem("dsh-hidden-session-ids", JSON.stringify(hiddenSessionIds));
  }, [hiddenSessionIds]);

  useEffect(() => {
    localStorage.setItem("dsh-approval-mode", approvalMode);
  }, [approvalMode]);

  useEffect(() => {
    localStorage.setItem("dsh-reasoning-effort", reasoningEffort);
  }, [reasoningEffort]);

  const connectService = useCallback(async (focusModelsIfEmpty = false) => {
    setServiceStatus("starting");
    setServiceError("");
    let lastError = "智能体服务启动失败";
    try {
      const existingState = await invoke<AgentServiceState>("agent_status");
      if (existingState.status === "running" && existingState.port) {
        setService(existingState);
        await waitForService(existingState.port);
        setServiceStatus("running");
        await loadWorkspaceData(existingState.port, focusModelsIfEmpty);
        return;
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const state = await invoke<AgentServiceState>("start_agent");
          if (!state.port) throw new Error(state.message || "服务启动失败");
          setService(state);
          await waitForService(state.port);
          setServiceStatus("running");
          setServiceError("");
          await loadWorkspaceData(state.port, focusModelsIfEmpty);
          return;
        } catch (caught) {
          lastError = caught instanceof Error ? caught.message : String(caught);
          if (attempt < 2) {
            await invoke("stop_agent").catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
      }
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught);
    }
    setServiceStatus("stopped");
    setServiceError(lastError);
  }, [loadWorkspaceData]);

  const startService = useCallback(() => {
    if (connectingRef.current) return connectingRef.current;
    const connecting = connectService(true).finally(() => {
      connectingRef.current = null;
    });
    connectingRef.current = connecting;
    return connecting;
  }, [connectService]);

  useEffect(() => {
    void startService();
  }, [startService]);

  useEffect(() => {
    if (serviceStatus !== "running") return;
    let cancelled = false;
    const checkService = async () => {
      try {
        const state = await invoke<AgentServiceState>("agent_status");
        if (cancelled) return;
        if (state.status !== "running") {
          setService(state);
          setServiceStatus("stopped");
          setServiceError(state.message || "智能体服务不可用");
        }
      } catch {
        return;
      }
    };
    const timer = window.setInterval(() => void checkService(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [serviceStatus]);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!port || streaming || messages.length > 0) return;
    const session = combinedSessions.find((item) => (
      item.sessionId === activeSessionId || item.agentId === activeSessionId
    ));
    const sessionId = session?.sessionId;
    if (!sessionId) return;
    let cancelled = false;
    const targetIds = new Set([sessionId, session.agentId].filter((value): value is string => Boolean(value)));
    void listMessages(port, sessionId)
      .then((loaded) => {
        if (cancelled || !targetIds.has(activeSessionRef.current)) return;
        const normalized = loaded
          .map(normalizeConversationMessage)
          .filter((message): message is ConversationMessage => Boolean(message));
        if (normalized.length > 0) setMessages(normalized);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, combinedSessions, messages.length, port, streaming]);

  useEffect(() => {
    if (!port || !anyStreaming) return;
    let cancelled = false;
    const loadApprovals = async () => {
      try {
        const items = await listRuntimeApprovals(port);
        if (!cancelled) setApprovals(items);
      } catch {
        return;
      }
    };

    void loadApprovals();
    const timer = window.setInterval(() => void loadApprovals(), 1_200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [port, anyStreaming]);

  const aliasesForSession = useCallback((sessionId: string): string[] => {
    const run = sessionRunsRef.current[sessionId];
    const aliasSet = new Set<string>([sessionId]);
    if (run?.agentId) aliasSet.add(run.agentId);
    if (run?.sessionId) aliasSet.add(run.sessionId);
    return [...aliasSet];
  }, []);

  const updateMessagesForAliases = useCallback((
    aliases: string[],
    updater: (current: ConversationMessage[]) => ConversationMessage[],
  ) => {
    for (const alias of aliases) {
      const currentMessages = sessionMessagesRef.current.get(alias) || [];
      const next = updater(currentMessages);
      sessionMessagesRef.current.set(alias, next);
      writeSessionMessages(alias, next);
      if (alias === activeSessionRef.current) {
        setMessages(next);
      }
    }
  }, []);

  const notifyRunFinished = useCallback((sessionId: string, run: SessionRunState | undefined, failed: boolean, errorMessage?: string) => {
    const focused = typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
    const viewing = focused && activeSessionRef.current === sessionId;
    if (viewing) return;
    const title = failed ? "对话执行出错" : "对话已完成";
    const body = run?.title
      ? (failed ? `「${run.title}」：${errorMessage || "执行失败"}` : `「${run.title}」已生成回复`)
      : (failed ? (errorMessage || "执行失败") : "已生成回复");
    void invoke("send_notification", { title, body }).catch(() => undefined);
  }, []);

  const selectSession = useCallback(async (sessionId: string) => {
    if (!port) return;
    try {
      const loadedMessages = (await listMessages(port, sessionId))
        .map(normalizeConversationMessage)
        .filter((message): message is ConversationMessage => Boolean(message));
      setMessages(loadedMessages);
      setActiveSessionId(sessionId);
      setActiveView("conversation");
    } catch {
      const cachedMessages = sessionMessagesRef.current.get(sessionId) || readSessionMessages(sessionId);
      sessionMessagesRef.current.set(sessionId, cachedMessages);
      setMessages(cachedMessages);
      setActiveSessionId(sessionId);
      setActiveView("conversation");
    }
  }, [port]);

  // 切到一个正在后台运行的会话时，本地缓存可能落后于服务端，补一次服务端消息拉取
  useEffect(() => {
    if (!port || !sessionRuns[activeSessionId]) return;
    const run = sessionRuns[activeSessionId];
    const targetId = run.sessionId || run.agentId;
    if (!targetId) return;
    let cancelled = false;
    const aliases = aliasesForSession(activeSessionId);
    const timer = window.setTimeout(() => {
      void listMessages(port, targetId)
        .then((loaded) => {
          if (cancelled) return;
          const normalized = loaded
            .map(normalizeConversationMessage)
            .filter((message): message is ConversationMessage => Boolean(message));
          if (normalized.length === 0) return;
          const currentCount = sessionMessagesRef.current.get(activeSessionId)?.length || 0;
          if (normalized.length > currentCount) {
            updateMessagesForAliases(aliases, () => normalized);
          }
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeSessionId, aliasesForSession, port, sessionRuns, updateMessagesForAliases]);

  const resolveApproval = useCallback(async (approvalId: string, verdict: "ALLOW_ONCE" | "ALLOW_SESSION" | "DENY") => {
    if (!port || resolvingApprovalId) return;
    setResolvingApprovalId(approvalId);
    setError("");
    try {
      await resolveRuntimeApproval(port, approvalId, verdict);
      await loadWorkspaceData(port);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setResolvingApprovalId("");
    }
  }, [loadWorkspaceData, port, resolvingApprovalId]);

  // 当前会话归属项目下挂载的工程；归属缺失时退回激活项目
  const sessionSelectedProjects = useMemo(() => {
    const sessionProjectPath = sessionProjectMap[activeSessionId] ?? activeProjectPath;
    return localProjects.filter((project) => project.parentPath === sessionProjectPath);
  }, [activeProjectPath, activeSessionId, localProjects, sessionProjectMap]);

  // 输入框中 @ 引用的工程（优先于"归属项目下挂载工程"作为对话上下文）
  const [draftMentions, setDraftMentions] = useState<WorkspaceEntry[]>([]);
  const contextProjects = draftMentions.length > 0 ? draftMentions : sessionSelectedProjects;

  const outgoingMessage = useMemo(() => {
    const cleanDraft = stripInvisibleChars(draft).trim();
    if (contextProjects.length === 0) return cleanDraft;
    const context = contextProjects
      .map((project) => `- ${project.name}: ${project.path}`)
      .join("\n");
    return `${cleanDraft}\n\n${HIDDEN_CONTEXT_OPEN}\n[当前选择的工程]\n${context}\n\n[重要] 上述工程目录已被用户授权为本项目的工作目录。所有文件读取、写入、编辑都必须在这些工程目录内进行，请使用绝对路径（如 ${contextProjects[0]?.path ?? ""}/...），不要使用用户主目录、桌面或其他无关路径。${HIDDEN_CONTEXT_CLOSE}`;
  }, [contextProjects, draft]);

  const sendMessage = useCallback(async () => {
    const text = stripInvisibleChars(draft).trim();
    const originSessionId = activeSessionId;
    if (!port || !text || sessionRunsRef.current[originSessionId]) return;
    if (!activeModel) {
      setActiveView("settings");
      setError("请先配置并激活一个可用模型");
      return;
    }

    const runAgentId = activeSession?.agentId || originSessionId;
    const runTitle = truncateSessionTitle(visibleMessageText(visibleUserMessage(text))) || text;

    const controller = new AbortController();
    abortControllersRef.current.set(originSessionId, controller);
    let resolvedSessionId = "";
    // 用 ref 避免 watchdog 回调和 finally 块之间的竞态：
    // abort() 是同步触发 fetch reject，如果 done 事件刚好在 abort 前到达，
    // 普通变量可能读到错误的 timedOut 值
    const timedOutRef = { current: false };
    const watchdog = window.setTimeout(() => {
      timedOutRef.current = true;
      controller.abort();
    }, 300_000);
    const startedAt = Date.now();
    const run: SessionRunState = { startedAt, title: runTitle, agentId: runAgentId };
    setSessionRuns((current) => ({ ...current, [originSessionId]: run }));
    setLastRunDurations((current) => ({ ...current, [originSessionId]: 0 }));
    setError("");
    setDraft("");
    setApprovals([]);
    // 会话归属以其创建时记录的项目为准（sessionProjectMap），而不是发送瞬间的激活项目，
    // 否则切过项目下拉框后发消息会把服务端 workspaceId 写错，loadWorkspaceData 回填时会话被挪走
    const sessionProjectPath = sessionProjectMapRef.current[originSessionId] ?? activeProjectPath;
    setSessionProjectMap((current) => ({ ...current, [originSessionId]: sessionProjectPath }));
    const createdAt = new Date().toISOString();
    const userMessage: ConversationMessage = {
      role: "user",
      content: text,
      createdAt,
      mentions: draftMentions.length > 0 ? draftMentions : undefined,
    };
    setDraftMentions([]);
    const assistantMessage: ConversationMessage = { role: "assistant", content: "", reasoning: "", createdAt };
    updateMessagesForAliases([originSessionId], (current) => [...current, userMessage, assistantMessage]);

    try {
      await streamAgentMessage(
        port,
        {
          agentId: runAgentId,
          message: outgoingMessage,
          channelCode: activeModel.channelCode,
          cwd: sessionProjectPath || undefined,
          approvalMode,
          reasoningEffort,
          // @ 引用工程（无引用时退回会话归属项目下挂载的工程）作为沙箱额外可写根
          sandboxRoots: contextProjects.length > 0
            ? contextProjects.map((project) => project.path)
            : undefined,
        },
        (event) => {
          const aliases = aliasesForSession(originSessionId);
          if (event.type === "chunk" || event.type === "reasoning") {
            const delta = payloadText(event.payload);
            updateMessagesForAliases(aliases, (current) => {
              let targetIndex = -1;
              for (let index = current.length - 1; index >= 0; index -= 1) {
                if (current[index].role === "assistant") {
                  targetIndex = index;
                  break;
                }
              }
              if (targetIndex < 0) return current;
              return current.map((message, index) => {
                if (index !== targetIndex) return message;
                return event.type === "chunk"
                  ? { ...message, content: mergeStreamText(message.content, delta) }
                  : { ...message, reasoning: mergeStreamText(message.reasoning || "", delta) };
              });
            });
          } else if (event.type === "step_break") {
            const payload = payloadRecord(event.payload);
            const toolName = typeof payload.toolName === "string" ? payload.toolName : "工具";
            const callId = typeof payload.callId === "string" ? payload.callId : `${toolName}-${Date.now()}`;
            updateMessagesForAliases(aliases, (current) => {
              const next = [...current];
              const toolMessage: ConversationMessage = {
                role: "tool",
                content: "",
                toolName,
                callId,
                arguments: payloadArguments(payload),
                status: typeof payload.status === "string" ? payload.status : "running",
              };
              const last = next[next.length - 1];
              // 复用尾部已有的空 assistant 占位，避免每步都新加一个导致后续文字被多份累加/重复
              if (last?.role === "assistant" && !last.content.trim() && !last.reasoning?.trim()) {
                next.splice(next.length - 1, 0, toolMessage);
              } else {
                next.push(toolMessage, { role: "assistant", content: "", reasoning: "" });
              }
              return next;
            });
          } else if (event.type === "tool_result") {
            const payload = payloadRecord(event.payload);
            const callId = typeof payload.callId === "string" ? payload.callId : "";
            const failed = payload.status === "error" || payload.status === "failed";
            updateMessagesForAliases(aliases, (current) => current.map((message) => (
              message.role === "tool" && (!callId || message.callId === callId)
                ? {
                    ...message,
                    result: typeof payload.result === "string" ? payload.result : payloadText(payload),
                    status: failed ? "error" : typeof payload.status === "string" ? payload.status : "success",
                    durationMs: typeof payload.durationMs === "number" ? payload.durationMs : message.durationMs,
                  }
                : message
            )));
          } else if (event.type === "done") {
            const payload = payloadRecord(event.payload);
            const sessionId = payloadString(payload, "sessionId");
            if (sessionId) resolvedSessionId = sessionId;
            const normalized = messagesFromPayload(event.payload);
            if (normalized && normalized.length > 0) {
              updateMessagesForAliases(aliases, (current) => {
                // 服务端 done 载荷经常不完整（缺中间文字/工具行），直接替换会把内容"吞掉"。
                // 只有当它比当前内容更丰富（条数更多或总文本更长）时才采用，否则保留流式累计的结果。
                const richness = (list: ConversationMessage[]) => list.reduce(
                  (sum, message) => sum
                    + (message.content?.length || 0)
                    + (message.reasoning?.length || 0)
                    + (message.result?.length || 0),
                  0,
                );
                if (normalized.length > current.length || richness(normalized) > richness(current)) {
                  return normalized;
                }
                // 保留本地累计内容，但把仍在 running 的工具标记为完成，避免永久"执行中"
                return current.map((message) => (
                  message.role === "tool" && message.status === "running"
                    ? { ...message, status: "success" }
                    : message
                ));
              });
            }
          } else if (event.type === "error") {
            throw new Error(payloadText(event.payload) || "智能体返回错误");
          }
        },
        controller.signal,
      );
      const persistedSessionId = resolvedSessionId || originSessionId;
      setSessionProjectMap((current) => {
        const inherited = current[originSessionId];
        // 优先沿用会话创建时已记录的归属项目；仅在缺失时退回当前激活项目。
        // 这样重启后 loadWorkspaceData 自动选中首个项目，也不会误改已有会话的归属。
        const projectPath = inherited !== undefined ? inherited : activeProjectPath;
        return {
          ...current,
          [runAgentId]: projectPath,
          [persistedSessionId]: projectPath,
        };
      });
      setDraftSessions((current) => current.map((session) => (
        sessionKey(session) === runAgentId || session.sessionId === resolvedSessionId
          ? {
              ...session,
              agentId: session.agentId || runAgentId,
              sessionId: resolvedSessionId || session.sessionId,
              title: runTitle,
              updatedAt: new Date().toISOString(),
            }
          : session
      )));
      if (resolvedSessionId && resolvedSessionId !== originSessionId) {
        // 服务端分配了新 sessionId：迁移该会话的运行状态与消息缓存到新 id，
        // 并把所有别名指向同一份消息列表，后续切回任一 id 都能看到完整内容。
        const sharedMessages = sessionMessagesRef.current.get(originSessionId) || [];
        sessionMessagesRef.current.set(resolvedSessionId, sharedMessages);
        writeSessionMessages(resolvedSessionId, sharedMessages);
        setSessionRuns((current) => {
          if (!current[originSessionId]) return current;
          const next = { ...current };
          next[resolvedSessionId] = { ...next[originSessionId], sessionId: resolvedSessionId };
          return next;
        });
        const controllerForRun = abortControllersRef.current.get(originSessionId);
        if (controllerForRun) {
          abortControllersRef.current.set(resolvedSessionId, controllerForRun);
        }
        if (activeSessionRef.current === originSessionId) {
          setActiveSessionId(resolvedSessionId);
        }
      }
      await loadWorkspaceData(port);
      notifyRunFinished(originSessionId, sessionRunsRef.current[originSessionId], false);
    } catch (caught) {
      const isAbort = caught instanceof DOMException && caught.name === "AbortError";
      const message = caught instanceof Error ? caught.message : String(caught);
      if (isAbort && !timedOutRef.current) {
        // 用户手动停止：静默结束，不报错、不通知
      } else {
        const finalMessage = isAbort ? "智能体长时间未返回结果，已自动停止" : message;
        if (activeSessionRef.current === originSessionId || activeSessionRef.current === resolvedSessionId) {
          setError(finalMessage);
        }
        notifyRunFinished(originSessionId, sessionRunsRef.current[originSessionId], true, finalMessage);
      }
    } finally {
      window.clearTimeout(watchdog);
      // 兜底：无论 done 载荷是否完整，结束时都不允许有工具停留在"执行中"
      updateMessagesForAliases(aliasesForSession(originSessionId), (current) => current.map((message) => (
        message.role === "tool" && message.status === "running"
          ? { ...message, status: "success" }
          : message
      )));
      const duration = Date.now() - startedAt;
      setLastRunDurations((current) => {
        const next = { ...current, [originSessionId]: duration };
        if (resolvedSessionId) next[resolvedSessionId] = duration;
        return next;
      });
      setSessionRuns((current) => {
        const next = { ...current };
        delete next[originSessionId];
        if (resolvedSessionId) delete next[resolvedSessionId];
        return next;
      });
      abortControllersRef.current.delete(originSessionId);
      if (resolvedSessionId) abortControllersRef.current.delete(resolvedSessionId);
    }
  }, [
    activeModel,
    contextProjects,
    draftMentions,
    activeSession,
    activeProjectPath,
    activeSessionId,
    aliasesForSession,
    approvalMode,
    draft,
    loadWorkspaceData,
    notifyRunFinished,
    outgoingMessage,
    port,
    reasoningEffort,
    updateMessagesForAliases,
  ]);

  const createProject = useCallback(async () => {
    const name = projectName.trim();
    if (!port || !name || creatingProject) return;
    setCreatingProject(true);
    setError("");
    try {
      const latest = await createWorkspace(port, name);
      setProjects(latest);
      setActiveProjectPath(latest.find((project) => project.name === name)?.path || latest[0]?.path || "");
      setProjectModalOpen(false);
      setProjectName("");
      setActiveView("conversation");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreatingProject(false);
    }
  }, [creatingProject, port, projectName]);

  const renameProject = useCallback(async (project: ProjectEditTarget, nextName: string) => {
    const name = nextName.trim();
    if (!name || project.name === name) return true;
    if (!port || project.local) {
      setLocalProjects((current) => current.map((item) => (
        item.path === project.path ? { ...item, name } : item
      )));
      return true;
    }
    setSavingProject(true);
    setError("");
    try {
      const latest = await renameWorkspace(port, project.name, name);
      setProjects(latest);
      const renamedProject = latest.find((item) => item.name === name) || latest[0];
      const nextParentPath = renamedProject?.path || project.path;
      setActiveProjectPath(nextParentPath);
      setLocalProjects((current) => current.map((item) => (
        item.parentPath === project.path ? { ...item, parentPath: nextParentPath } : item
      )));
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setSavingProject(false);
    }
  }, [port]);

  const syncAvailableModels = useCallback(async () => {
    if (!port) return;
    if (!modelDraft.baseUrl.trim()) {
      setError("同步模型前请先填写 Base URL");
      return;
    }
    setSyncingModels(true);
    setError("");
    try {
      const models = await discoverModels(port, {
        baseUrl: modelDraft.baseUrl.trim(),
        apiKeyRef: modelDraft.apiKeyRef.trim(),
        protocol: modelDraft.protocol,
      });
      setDiscoveredModels(models);
      if (models.length > 0 && !modelDraft.modelCode) {
        setModelDraft((current) => ({ ...current, modelCode: models[0] }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSyncingModels(false);
    }
  }, [modelDraft, port]);

  const submitModel = useCallback(async (): Promise<boolean> => {
    if (!port) return false;
    if (!modelDraft.displayName.trim()) {
      setError("请填写渠道名称");
      return false;
    }
    if (!modelDraft.modelCode.trim()) {
      setError("请选择或输入模型");
      return false;
    }
    if (!modelDraft.baseUrl.trim()) {
      setError("请填写 Base URL");
      return false;
    }
    if (modelDraft.protocol !== "ollama" && !modelDraft.apiKeyRef.trim()) {
      setError("请填写 API Key");
      return false;
    }

    setSavingModel(true);
    setError("");
    try {
      const saved = await saveModelSetting(port, { ...modelDraft });
      if (saved.channelCode) {
        await activateModelSetting(port, saved.channelCode);
      }
      setModelDraft(emptyModelDraft);
      setDiscoveredModels([]);
      await loadWorkspaceData(port, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingModel(false);
    }
    return true;
  }, [loadWorkspaceData, modelDraft, port]);

  const toggleModel = useCallback(async (model: ModelSetting) => {
    if (!port || !model.channelCode) return;
    setError("");
    try {
      await saveModelSetting(port, {
        ...model,
        enabled: model.enabled === false,
      });
      await loadWorkspaceData(port);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadWorkspaceData, port]);

  const activateModel = useCallback(async (channelCode: string) => {
    if (!port || !channelCode) return;
    setError("");
    try {
      await activateModelSetting(port, channelCode);
      await loadWorkspaceData(port);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadWorkspaceData, port]);

  const removeModel = useCallback(async (channelCode: string) => {
    if (!port || !channelCode) return;
    setError("");
    try {
      await deleteModelSetting(port, channelCode);
      if (modelDraft.channelCode === channelCode) setModelDraft(emptyModelDraft);
      await loadWorkspaceData(port, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadWorkspaceData, modelDraft.channelCode, port]);

  const editModel = useCallback((model: ModelSetting) => {
    setModelDraft({
      channelCode: model.channelCode,
      displayName: model.displayName || "",
      providerCode: model.providerCode || "",
      modelCode: model.modelCode || "",
      baseUrl: model.baseUrl || "",
      apiKeyRef: model.apiKeyRef || "",
      protocol: model.protocol || "openai",
      enabled: model.enabled !== false,
    });
    setActiveView("settings");
  }, []);

  const startConversation = useCallback((project?: WorkspaceEntry) => {
    // 顶部「新对话」不传 project 时，归属当前激活项目；项目行的 + 号则明确归属该项目
    const projectPath = project ? project.path : activeProjectPathRef.current;
    // 仅复用「真正空白且可见」的新对话：没有 sessionId（从未持久化到服务端）、
    // 标题仍是占位文案（发过消息的会话 title 会被替换成消息摘要）、
    // 且确实在会话列表中展示（僵尸 draft——id 与服务端会话撞车被去重过滤、
    // 永远不可见——不能复用，否则点了就像没反应）。
    const existingEmptyDraft = draftSessionsRef.current.find((session) => {
      const id = session.agentId || "";
      if (!id || session.sessionId) return false;
      const belongsTo = sessionProjectMapRef.current[id] ?? "";
      const untouched = (session.title || "新对话") === "新对话";
      const visible = combinedSessionsRef.current.some((item) => item.agentId === id);
      return belongsTo === projectPath && untouched && visible;
    });
    if (existingEmptyDraft) {
      const existingId = existingEmptyDraft.agentId || "";
      setActiveSessionId(existingId);
      setMessages(sessionMessagesRef.current.get(existingId) || []);
      setActiveView("conversation");
      return;
    }
    const sessionId = newSessionId();
    const draftSession: SessionSummary = {
      agentId: sessionId,
      title: "新对话",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setActiveSessionId(sessionId);
    setMessages([]);
    sessionMessagesRef.current.set(sessionId, []);
    writeSessionMessages(sessionId, []);
    setDraftSessions((current) => [draftSession, ...current]);
    setSessionProjectMap((current) => ({ ...current, [sessionId]: projectPath }));
    setActiveView("conversation");
  }, []);

  const removeProject = useCallback(async (project: WorkspaceEntry) => {
    if (project.local) {
      setLocalProjects((current) => current.filter((item) => item.path !== project.path));
      return;
    }
    if (!port) return;
    setError("");
    try {
      const latest = await deleteWorkspace(port, project.name);
      setProjects(latest);
      setLocalProjects((current) => current.filter((item) => item.parentPath !== project.path));
      const nextActive = latest[0]?.path || "";
      if (activeProjectPath === project.path) {
        setActiveProjectPath(nextActive);
        startConversation(latest[0]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [activeProjectPath, port, startConversation]);

  const renameSession = useCallback((session: SessionSummary, nextTitle: string) => {
    const title = nextTitle.trim();
    if (!title) return;
    setCustomSessionTitles((current) => {
      const next = { ...current };
      // 同一会话的所有别名都写入，保证按任一 id 都能查到自定义标题
      for (const id of [session.sessionId, session.agentId]) {
        if (id) next[id] = title;
      }
      return next;
    });
    // 草稿会话同步改 title，避免重新加载时旧标题盖回展示
    setDraftSessions((current) => current.map((item) => (
      (item.sessionId && item.sessionId === session.sessionId)
        || (item.agentId && item.agentId === session.agentId)
        ? { ...item, title, updatedAt: new Date().toISOString() }
        : item
    )));
  }, []);

  const deleteSession = useCallback((session: SessionSummary) => {
    const ids = [session.sessionId, session.agentId].filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const isActive = idSet.has(activeSessionRef.current);

    // 运行中的会话先停止
    for (const id of ids) {
      abortControllersRef.current.get(id)?.abort();
      abortControllersRef.current.delete(id);
    }
    setSessionRuns((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });

    // 草稿会话直接移除；服务端会话记入隐藏列表（服务端暂无删除接口）
    setDraftSessions((current) => current.filter((item) => !(
      (item.sessionId && idSet.has(item.sessionId)) || (item.agentId && idSet.has(item.agentId))
    )));
    setSessions((current) => current.filter((item) => !(
      (item.sessionId && idSet.has(item.sessionId)) || (item.agentId && idSet.has(item.agentId))
    )));
    setHiddenSessionIds((current) => [...new Set([...current, ...ids])]);

    // 清理本地缓存与归属映射
    setCustomSessionTitles((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
    setSessionProjectMap((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
    try {
      const cache = JSON.parse(localStorage.getItem("dsh-session-messages") || "{}") as Record<string, unknown>;
      let changed = false;
      for (const id of ids) {
        if (id in cache) {
          delete cache[id];
          changed = true;
        }
      }
      if (changed) localStorage.setItem("dsh-session-messages", JSON.stringify(cache));
    } catch {
      // 缓存清理失败不影响主流程
    }
    for (const id of ids) sessionMessagesRef.current.delete(id);

    // 删除的是当前会话时，切到剩余会话里的第一个；没有则开新对话
    if (isActive) {
      const remaining = combinedSessions.find((item) => {
        const itemIds = [item.sessionId, item.agentId].filter((id): id is string => Boolean(id));
        return itemIds.length > 0 && !itemIds.some((id) => idSet.has(id));
      });
      const nextId = remaining?.sessionId || remaining?.agentId;
      if (nextId) {
        setActiveSessionId(nextId);
        setMessages(sessionMessagesRef.current.get(nextId) || readSessionMessages(nextId));
      } else {
        const freshId = newSessionId();
        setActiveSessionId(freshId);
        setMessages([]);
        setSessionProjectMap((current) => ({ ...current, [freshId]: activeProjectPath }));
      }
    }
  }, [activeProjectPath, combinedSessions]);

  const pickLocalProject = useCallback(async (parentPath: string) => {
    try {
      const selected = await invoke<WorkspaceEntry[]>("pick_local_directory");
      const entries = (selected || [])
        .filter((entry) => Boolean(entry?.path))
        .map((entry) => ({
          name: entry.name || entry.path.split("/").filter(Boolean).pop() || "本地项目",
          path: entry.path,
          local: true,
          parentPath,
        }));
      if (entries.length === 0) return;
      setLocalProjects((current) => [
        ...current.filter((project) => !entries.some((entry) => entry.path === project.path)),
        ...entries,
      ]);
      setActiveView("conversation");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const removeLocalProject = useCallback((project: WorkspaceEntry) => {
    setLocalProjects((current) => current.filter((item) => item.path !== project.path));
  }, []);

  const selectProject = useCallback((project: WorkspaceEntry) => {
    setActiveProjectPath(project.path);
    setActiveView("conversation");
    startConversation(project);
  }, [startConversation]);

  const selectDefaultWorkspace = useCallback(() => {
    setActiveProjectPath("");
    setActiveView("conversation");
    startConversation(undefined);
  }, [startConversation]);

  const modelChoices = useMemo(() => {
    if (availableModels.length > 0) {
      return availableModels.map((model) => ({
        ...model,
        active: modelSettings.some((setting) => (
          setting.channelCode === model.channelCode
          && setting.channelCode
          && setting.enabled !== false
          && setting.active
        )),
      }));
    }
    return modelSettings.filter((model) => model.enabled !== false);
  }, [availableModels, modelSettings]);
  const combinedProjects = useMemo(() => {
    const byPath = new Map<string, WorkspaceEntry>();
    for (const project of projects) byPath.set(project.path, project);
    for (const project of localProjects) {
      byPath.set(project.path, project);
    }
    return [...byPath.values()];
  }, [localProjects, projects]);
  const activeProject = combinedProjects.find((project) => project.path === activeProjectPath);
  const switchProjectBranch = useCallback(async (project: WorkspaceEntry, branch: string) => {
    if (projectBranches[project.path] === branch) return;
    setSwitchingBranchPath(project.path);
    try {
      const state = await invoke<GitBranchesState>("switch_project_git_branch", {
        path: project.path,
        branch,
      });
      setProjectBranches((current) => ({ ...current, [project.path]: state.current }));
      setProjectBranchOptions((current) => ({ ...current, [project.path]: state.branches }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSwitchingBranchPath("");
    }
  }, [projectBranches]);

  useEffect(() => {
    let cancelled = false;
    for (const project of combinedProjects) {
      if (!project.path) continue;
      void invoke<GitBranchesState>("project_git_branches", { path: project.path })
        .then((state) => {
          if (cancelled) return;
          setProjectBranches((current) => ({ ...current, [project.path]: state.current }));
          setProjectBranchOptions((current) => ({ ...current, [project.path]: state.branches }));
        })
        .catch(() => {
          if (cancelled) return;
          setProjectBranches((current) => ({ ...current, [project.path]: "" }));
          setProjectBranchOptions((current) => ({ ...current, [project.path]: [] }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [combinedProjects]);

  const editProject = useCallback((project: WorkspaceEntry) => {
    setProjectModalOpen(true);
    setProjectName(project.name);
    setEditingProject(project);
  }, []);

  if (activeView === "settings") {
    return (
      <SettingsView
        service={service}
        serviceStatus={serviceStatus}
        serviceError={serviceError}
        error={error}
        activeSection={settingsSection}
        onSectionChange={setSettingsSection}
        onBack={() => setActiveView("conversation")}
        approvalMode={approvalMode}
        reasoningEffort={reasoningEffort}
        onApprovalModeChange={setApprovalMode}
        onReasoningEffortChange={setReasoningEffort}
        draft={modelDraft}
        modelSettings={modelSettings}
        availableModels={availableModels}
        discoveredModels={discoveredModels}
        savingModel={savingModel}
        syncingModels={syncingModels}
        onDraftChange={setModelDraft}
        onDiscover={() => void syncAvailableModels()}
        onSave={() => submitModel()}
        onCancelEdit={() => setModelDraft(emptyModelDraft)}
        onActivate={(channelCode) => void activateModel(channelCode)}
        onDelete={(channelCode) => void removeModel(channelCode)}
        onEdit={editModel}
        onToggleModel={(model) => void toggleModel(model)}
        onReconnect={() => void startService()}
      />
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        activeSessionId={activeSessionId}
        activeProjectPath={activeProjectPath}
        streaming={streaming}
        runningSessionIds={Object.keys(sessionRuns)}
        projects={combinedProjects}
        sessions={combinedSessions}
        sessionProjectMap={sessionProjectMap}
        creatingProject={creatingProject}
        projectModalOpen={projectModalOpen}
        projectName={projectName}
        onViewChange={setActiveView}
        onSelectDefaultWorkspace={selectDefaultWorkspace}
        onSelectSession={(id) => void selectSession(id)}
        sessionCustomTitles={customSessionTitles}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onNewConversation={() => startConversation(activeProject)}
        editingProject={editingProject}
        savingProject={savingProject}
        onProjectModalChange={(open, name, project) => {
          setProjectModalOpen(open);
          setProjectName(name || "");
          setEditingProject(project || null);
        }}
        onCreateProject={() => void createProject()}
        onPickLocalProject={(parentPath) => void pickLocalProject(parentPath)}
        onAddLocalProject={(parentPath) => void pickLocalProject(parentPath)}
        onEditProject={(project) => {
          editProject(project);
        }}
        onRenameProject={(name) => {
          if (!editingProject) return;
          void renameProject(editingProject, name).then((closed) => {
            if (closed) {
              setProjectModalOpen(false);
              setProjectName("");
              setEditingProject(null);
            }
          });
        }}
        onRemoveProject={(project) => void removeProject(project)}
        onRemoveLocalProject={removeLocalProject}
      />

      <main className="main-panel">
        <div className="main-panel-content">
        {!(activeView === "conversation" && messages.length === 0) ? (
          <header className="topbar">
            <div>
              <h1>
                {activeView === "conversation"
                  ? sessionTitle(activeSession || { agentId: activeSessionId }, customSessionTitles)
                  : "工作台"}
              </h1>
              <p>
                {activeProject ? `${activeProject.name} · ` : ""}
                {modelChoices.length > 0 ? `${modelChoices.length} 个模型可用` : "未配置模型"}
              </p>
            </div>
            <div className="topbar-actions">
              <button
                type="button"
                className={railOpen ? "topbar-icon-btn active" : "topbar-icon-btn"}
                onClick={() => setRailOpen((open) => !open)}
                title="信息栏"
                aria-label="信息栏"
              >
                <SlidersIcon className="topbar-icon" />
                {anyStreaming ? <span className="topbar-icon-dot" /> : null}
              </button>
            </div>
          </header>
        ) : (
          <button
            type="button"
            className={railOpen ? "topbar-icon-btn rail-trigger active" : "topbar-icon-btn rail-trigger"}
            onClick={() => setRailOpen((open) => !open)}
            title="信息栏"
            aria-label="信息栏"
          >
            <SlidersIcon className="topbar-icon" />
            {anyStreaming ? <span className="topbar-icon-dot" /> : null}
          </button>
        )}

        {error ? <div className="error-banner">{error}</div> : null}

        {activeView === "conversation" ? (
          <ConversationView
            serviceReady={serviceReady}
            streaming={streaming}
            draft={draft}
            messages={messages}
            activeModel={activeModel}
            modelChoices={modelChoices}
            activeProject={activeProject}
            projects={combinedProjects}
            projectBranches={projectBranches}
            projectBranchOptions={projectBranchOptions}
            switchingBranchPath={switchingBranchPath}
            streamStartedAt={sessionRuns[activeSessionId]?.startedAt ?? null}
            runDurationMs={lastRunDurations[activeSessionId]}
            onSelectProject={selectProject}
            onSelectDefaultWorkspace={selectDefaultWorkspace}
            onSwitchProjectBranch={(project, branch) => void switchProjectBranch(project, branch)}
            onCreateSession={() => startConversation(activeProject)}
            onDraftChange={setDraft}
            onSend={() => void sendMessage()}
            mentions={draftMentions}
            onMentionsChange={setDraftMentions}
            sentHistory={promptHistory}
            onHistoryEntry={appendPromptHistory}
            onStopGeneration={() => abortControllersRef.current.get(activeSessionId)?.abort()}
            approvalMode={approvalMode}
            onApprovalModeChange={setApprovalMode}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={setReasoningEffort}
            onActivateModel={(channelCode) => void activateModel(channelCode)}
            onOpenSettings={() => setActiveView("settings")}
            approvals={approvals.filter((approval) =>
              !approval.sessionId || approval.sessionId === activeSessionId)}
            resolvingApprovalId={resolvingApprovalId}
            onResolveApproval={(approvalId, verdict) => void resolveApproval(approvalId, verdict)}
          />
        ) : null}
        </div>

        <InfoRail
          open={railOpen}
          onClose={() => setRailOpen(false)}
          servicePort={port}
          serviceReady={serviceReady}
          sessions={combinedSessions}
          activeProject={activeProject}
          activeBranch={activeProject ? projectBranches[activeProject.path] : undefined}
        />
      </main>
    </div>
  );
}
