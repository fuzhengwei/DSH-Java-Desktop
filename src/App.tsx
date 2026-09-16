import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationView from "./components/ConversationView";
import Sidebar, { type WorkspaceView } from "./components/Sidebar";
import SettingsView, { type SettingsSection } from "./components/SettingsView";
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

function normalizeConversationMessage(message: unknown): ConversationMessage | null {
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
        normalized.arguments = args && typeof args === "object" && !Array.isArray(args)
          ? args as Record<string, unknown>
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

function visibleMessageText(value: string): string {
  let text = value;
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

function sessionTitle(session: SessionSummary): string {
  const rawTitle = session.title || session.lastMessage || session.agentId || session.sessionId || "新对话";
  return visibleMessageText(visibleUserMessage(rawTitle)) || "新对话";
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
  const [streaming, setStreaming] = useState(false);
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
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
  const messageListRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const connectingRef = useRef<Promise<void> | null>(null);
  const activeSessionRef = useRef(activeSessionId);

  const port = service?.port ?? null;
  const serviceReady = serviceStatus === "running" && Boolean(port);
  const combinedSessions = useMemo(() => {
    const persistedIds = new Set(sessions.map(sessionKey));
    return [
      ...sessions,
      ...draftSessions.filter((session) => sessionKey(session) && !persistedIds.has(sessionKey(session))),
    ];
  }, [draftSessions, sessions]);
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

    if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value);
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
    setSessionProjectMap(JSON.parse(localStorage.getItem("dsh-session-project-map") || "{}"));
    setLocalProjects(JSON.parse(localStorage.getItem("dsh-local-projects") || "[]"));
    setDraftSessions(readDraftSessions());
  }, []);

  useEffect(() => {
    localStorage.setItem("dsh-active-session-id", activeSessionId);
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

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
    if (!port || !streaming) return;
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
  }, [port, streaming]);

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
      const cachedMessages = readSessionMessages(sessionId);
      setMessages(cachedMessages);
      setActiveSessionId(sessionId);
      setActiveView("conversation");
    }
  }, [port]);

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

  const activeSelectedProjects = useMemo(() => (
    localProjects.filter((project) => project.parentPath === activeProjectPath)
  ), [activeProjectPath, localProjects]);

  const outgoingMessage = useMemo(() => {
    if (activeSelectedProjects.length === 0) return draft.trim();
    const context = activeSelectedProjects
      .map((project) => `- ${project.name}: ${project.path}`)
      .join("\n");
    return `${draft.trim()}\n\n${HIDDEN_CONTEXT_OPEN}\n[当前选择的工程]\n${context}\n${HIDDEN_CONTEXT_CLOSE}`;
  }, [activeSelectedProjects, draft]);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!port || !text || streaming) return;
    if (!activeModel) {
      setActiveView("settings");
      setError("请先配置并激活一个可用模型");
      return;
    }

    const runAgentId = activeSession?.agentId || activeSessionId;

    const controller = new AbortController();
    abortRef.current = controller;
    let resolvedSessionId = "";
    let timedOut = false;
    const watchdog = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 300_000);
    setStreaming(true);
    const startedAt = Date.now();
    setStreamStartedAt(startedAt);
    setLastRunDurations((current) => ({ ...current, [activeSessionId]: 0 }));
    setError("");
    setDraft("");
    setApprovals([]);
    setSessionProjectMap((current) => ({
      ...current,
      [activeSessionId]: activeProjectPath,
    }));
    const createdAt = new Date().toISOString();
    const userMessage: ConversationMessage = { role: "user", content: text, createdAt };
    const assistantMessage: ConversationMessage = { role: "assistant", content: "", reasoning: "", createdAt };
    setMessages((current) => [...current, userMessage, assistantMessage]);

    try {
      await streamAgentMessage(
        port,
        {
          agentId: runAgentId,
          message: outgoingMessage,
          channelCode: activeModel.channelCode,
          cwd: activeProjectPath || undefined,
          approvalMode,
          reasoningEffort,
        },
        (event) => {
          if (event.type === "chunk" || event.type === "reasoning") {
            const delta = payloadText(event.payload);
            setMessages((current) => {
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
            setMessages((current) => {
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
            setMessages((current) => current.map((message) => (
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
              setMessages((current) => {
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
      const persistedSessionId = resolvedSessionId || activeSessionId;
      setSessionProjectMap((current) => ({
        ...current,
        [runAgentId]: activeProjectPath,
        [persistedSessionId]: activeProjectPath,
      }));
      setDraftSessions((current) => current.map((session) => (
        sessionKey(session) === runAgentId || session.sessionId === resolvedSessionId
          ? {
              ...session,
              agentId: session.agentId || runAgentId,
              sessionId: resolvedSessionId || session.sessionId,
              title: text.length > 42 ? `${text.slice(0, 42)}…` : text,
              updatedAt: new Date().toISOString(),
            }
          : session
      )));
      if (resolvedSessionId && resolvedSessionId !== activeSessionId) {
        setActiveSessionId(resolvedSessionId);
      }
      await loadWorkspaceData(port);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        if (timedOut) {
          setError("智能体长时间未返回结果，已自动停止");
        }
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      window.clearTimeout(watchdog);
      setStreaming(false);
      setStreamStartedAt(null);
      // 兜底：无论 done 载荷是否完整，结束时都不允许有工具停留在"执行中"
      setMessages((current) => current.map((message) => (
        message.role === "tool" && message.status === "running"
          ? { ...message, status: "success" }
          : message
      )));
      setLastRunDurations((current) => ({
        ...current,
        [resolvedSessionId || activeSessionId]: Date.now() - startedAt,
      }));
      abortRef.current = null;
    }
  }, [
    activeModel,
    activeSession,
    activeProjectPath,
    activeSelectedProjects,
    activeSessionId,
    draft,
    loadWorkspaceData,
    outgoingMessage,
    port,
    streaming,
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
        item.path === project.path && item.parentPath === project.path ? { ...item, name } : item
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
    const sessionId = newSessionId();
    const draftSession: SessionSummary = {
      agentId: sessionId,
      title: "新对话",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setActiveSessionId(sessionId);
    setMessages([]);
    setDraftSessions((current) => [draftSession, ...current]);
    setSessionProjectMap((current) => ({
      ...current,
      [sessionId]: project ? project.path : "",
    }));
    setActiveView("conversation");
  }, []);

  const removeProject = useCallback(async (project: WorkspaceEntry) => {
    if (project.local) {
      setLocalProjects((current) => current.filter((item) => item.path !== project.path));
      return;
    }
    if (!port || !window.confirm(`确定删除项目「${project.name}」吗？项目目录将被删除。`)) return;
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

  const pickLocalProject = useCallback(async (
    parentPath: string,
    options?: { keepModalOpen?: boolean },
  ) => {
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
      if (!options?.keepModalOpen) {
        setActiveProjectPath(entries[0].path);
        setProjectModalOpen(false);
        setActiveView("conversation");
        startConversation(entries[0]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [startConversation]);

  const removeLocalProject = useCallback((project: WorkspaceEntry) => {
    setLocalProjects((current) => current.filter((item) => item.path !== project.path));
    if (activeProjectPath === project.path) {
      setActiveProjectPath(projects[0]?.path || "");
      startConversation(projects[0]);
    }
  }, [activeProjectPath, projects, startConversation]);

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
        projects={combinedProjects}
        sessions={combinedSessions}
        sessionProjectMap={sessionProjectMap}
        creatingProject={creatingProject}
        projectModalOpen={projectModalOpen}
        projectName={projectName}
        onViewChange={setActiveView}
        onSelectProject={selectProject}
        onSelectDefaultWorkspace={selectDefaultWorkspace}
        onSelectSession={(id) => void selectSession(id)}
        onNewConversation={() => startConversation(activeProject)}
        editingProject={editingProject}
        savingProject={savingProject}
        onProjectModalChange={(open, name, project) => {
          setProjectModalOpen(open);
          setProjectName(name || "");
          setEditingProject(project || null);
        }}
        onCreateProject={() => void createProject()}
        onPickLocalProject={(parentPath) => void pickLocalProject(parentPath, { keepModalOpen: true })}
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
        {!(activeView === "conversation" && messages.length === 0) ? (
          <header className="topbar">
            <div>
              <h1>
                {activeView === "conversation"
                  ? sessionTitle(activeSession || { agentId: activeSessionId })
                  : "工作台"}
              </h1>
              <p>
                {activeProject ? `${activeProject.name} · ` : ""}
                {modelChoices.length > 0 ? `${modelChoices.length} 个模型可用` : "未配置模型"}
              </p>
            </div>
          </header>
        ) : null}

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
            streamStartedAt={streamStartedAt}
            runDurationMs={lastRunDurations[activeSessionId]}
            onSelectProject={selectProject}
            onSelectDefaultWorkspace={selectDefaultWorkspace}
            onSwitchProjectBranch={(project, branch) => void switchProjectBranch(project, branch)}
            onCreateSession={() => startConversation(activeProject)}
            onDraftChange={setDraft}
            onSend={() => void sendMessage()}
            onStopGeneration={() => abortRef.current?.abort()}
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

      </main>
    </div>
  );
}
