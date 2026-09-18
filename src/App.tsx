import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationView from "./components/ConversationView";
import Sidebar, { type WorkspaceView } from "./components/Sidebar";
import SettingsView, { type SettingsSection } from "./components/SettingsView";
import InfoRail from "./components/InfoRail";
import DigitalHumanCatalog from "./components/DigitalHumanCatalog";
import AddDigitalHumanWizard from "./components/AddDigitalHumanWizard";
import CollabPanel from "./components/CollabPanel";
import { ParticipantPicker } from "./components/ParticipantPicker";
import RoomCollaborationView from "./components/RoomCollaborationView";
import ArtifactPreview from "./components/ArtifactPreview";
import RightDock, { DockTabBar } from "./components/RightDock";
import UpdatePrompt from "./components/UpdatePrompt";
import { FilePreview } from "./components/FilePreview";
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
import {
  assignDigitalHumanToProject,
  boundRoomId,
  createDigitalHuman,
  cancelRoomTask,
  digitalHumanTokensFor,
  ensureRoomObjective,
  ensureServerRoom,
  fetchServerRoom,
  joinRoom,
  joinServerRoom,
  leaveServerRoom,
  listDigitalHumans,
  postRoomMessage,
  readRoom,
  updatePresence,
  type ServerRoomView,
} from "./lib/digital-human-client";
import type {
  AgentServiceState,
  ApprovalMode,
  AvailableModel,
  ConversationMessage,
  DigitalHuman,
  ModelDraft,
  ModelSetting,
  ReasoningEffort,
  RoomProjection,
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

function readActiveProjectPath(): string {
  return localStorage.getItem("dsh-active-project-path") || "";
}

function readProjectOrder(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem("dsh-project-order") || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function readSessionOrder(): Record<string, string[]> {
  try {
    const value = JSON.parse(localStorage.getItem("dsh-session-order") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const next: Record<string, string[]> = {};
    for (const [projectPath, ids] of Object.entries(value)) {
      if (typeof projectPath !== "string" || !Array.isArray(ids)) continue;
      const cleanIds = ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
      if (cleanIds.length > 0) next[projectPath] = cleanIds;
    }
    return next;
  } catch {
    return {};
  }
}

function readSessionProjectMap(): Record<string, string> {
  try {
    const storedMap = JSON.parse(localStorage.getItem("dsh-session-project-map") || "{}") as Record<string, unknown>;
    if (!storedMap || typeof storedMap !== "object" || Array.isArray(storedMap)) return {};
    const cleanedMap: Record<string, string> = {};
    for (const [id, path] of Object.entries(storedMap)) {
      if (typeof id !== "string" || !id.trim() || typeof path !== "string") continue;
      const normalized = normalizedProjectPath(path);
      if (normalized) cleanedMap[id] = normalized;
      else if (path === "default") cleanedMap[id] = "default";
    }
    if (Object.keys(cleanedMap).length !== Object.keys(storedMap).length) {
      localStorage.setItem("dsh-session-project-map", JSON.stringify(cleanedMap));
    }
    return cleanedMap;
  } catch {
    return {};
  }
}

function normalizedProjectPath(value?: string): string {
  return value && value !== "default" ? value : "";
}

function storedProjectPath(value?: string): string {
  return normalizedProjectPath(value) || "default";
}

function projectPathFromMap(map: Record<string, string>, sessionId: string, fallback = ""): string {
  if (Object.prototype.hasOwnProperty.call(map, sessionId) && map[sessionId] === "default") return "";
  return normalizedProjectPath(map[sessionId]) || fallback;
}

function idsOfSession(session?: SessionSummary | null): string[] {
  if (!session) return [];
  return [session.sessionId, session.agentId].filter((id): id is string => Boolean(id));
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

/** 项目当前没有可用数字人时，历史消息里的归属信息也不再展示 */
function stripDigitalHumanAttribution(
  list: ConversationMessage[],
  humans: DigitalHuman[],
): ConversationMessage[] {
  if (humans.length > 0 || !list.some((message) => message.attribution)) return list;
  return list.map((message) => (
    message.attribution ? { ...message, attribution: undefined } : message
  ));
}

/**
 * 归属回填：服务端持久化的消息没有数字人归属（本地投影），
 * 从本地缓存里按内容把归属补回来——同一轮对话 assistant 消息内容一致即视为同源，
 * 其间的 tool 消息继承该轮归属。
 */
function mergeAttributionFromCache(
  loaded: ConversationMessage[],
  cached: ConversationMessage[],
): ConversationMessage[] {
  if (!loaded.some((message) => message.role === "assistant") || !cached.length) return loaded;
  // 缓存中所有带归属的 assistant 内容 → 归属
  const attributionByContent = new Map<string, NonNullable<ConversationMessage["attribution"]>>();
  for (const message of cached) {
    if (message.role === "assistant" && message.attribution && message.content.trim()) {
      attributionByContent.set(message.content.trim(), message.attribution);
    }
  }
  if (attributionByContent.size === 0) return loaded;

  const result: ConversationMessage[] = [];
  let currentAttribution: ConversationMessage["attribution"];
  for (const message of loaded) {
    if (message.attribution) {
      // 已有归属（本地流式刚写进去的）：直接保留，并更新当前轮归属
      currentAttribution = message.attribution;
      result.push(message);
      continue;
    }
    if (message.role === "assistant") {
      const found = attributionByContent.get(message.content.trim());
      if (found) {
        currentAttribution = found;
        result.push({ ...message, attribution: found });
        continue;
      }
      // 无内容的 assistant 占位（工具间过渡）继承当前轮归属
      if (!message.content.trim() && currentAttribution) {
        result.push({ ...message, attribution: currentAttribution });
        continue;
      }
      result.push(message);
      continue;
    }
    if (message.role === "tool" && currentAttribution) {
      result.push({ ...message, attribution: currentAttribution });
      continue;
    }
    if (message.role === "user") {
      // 新一轮用户消息：重置当前归属，避免跨轮误挂
      currentAttribution = undefined;
    }
    result.push(message);
  }
  return result;
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
  const [activeProjectPath, setActiveProjectPath] = useState(readActiveProjectPath);
  const [sessionProjectMap, setSessionProjectMap] = useState<Record<string, string>>(readSessionProjectMap);
  const [localProjects, setLocalProjects] = useState<WorkspaceEntry[]>([]);
  const [projectOrder, setProjectOrder] = useState<string[]>(readProjectOrder);
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(readSessionOrder);
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
  // ── 数字人协作 ──
  const [digitalHumans, setDigitalHumans] = useState<DigitalHuman[]>([]);
  const [digitalHumansLoaded, setDigitalHumansLoaded] = useState(false);
  const [selectedHumanId, setSelectedHumanId] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  // 数字人向导的归属项目（从项目行「添加数字人」进入时带上）
  const [wizardProjectPath, setWizardProjectPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [room, setRoom] = useState<RoomProjection | null>(null);
  const [serverRoom, setServerRoom] = useState<ServerRoomView | null>(null);
  const [serverRoomId, setServerRoomId] = useState("");
  const [roomRunning, setRoomRunning] = useState(false);
  // 右侧群聊点击摘要 → 中间区域滚动定位（nonce 保证同一条目可重复聚焦）
  const [focusRequest, setFocusRequest] = useState<{ seq: number; nonce: number } | null>(null);
  // 右侧标签栏面板：activeDockTab = "collab" | "info" | "artifact:<id>"
  const [dockOpen, setDockOpen] = useState(false);
  const [activeDockTab, setActiveDockTab] = useState<string>("collab");
  /** 顶部快捷按钮：激活同一 Tab 时收起，否则切到对应 Tab 并展开 */
  const toggleDockTab = useCallback((tab: "collab" | "info") => {
    setActiveDockTab(tab);
    setDockOpen((open) => !(open && activeDockTab === tab));
  }, [activeDockTab]);
  const [artifactTabs, setArtifactTabs] = useState<Array<{ id: string; label: string; kind?: "artifact" | "file" }>>([]);
  const [humanMentions, setHumanMentions] = useState<DigitalHuman[]>([]);
  const [activeHumanId, setActiveHumanId] = useState("");
  const humanMentionsRef = useRef<DigitalHuman[]>([]);
  const digitalHumansRef = useRef<DigitalHuman[]>([]);
  const outgoingMessageRef = useRef("");
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

  const activeHuman = useMemo(
    () => digitalHumans.find((human) => human.id === activeHumanId) || null,
    [activeHumanId, digitalHumans],
  );

  // 右侧协作面板可见性：房间有数字人参与者，或输入框已加入数字人 chips
  const hasCollab = Boolean(
    (room?.participants.length || 0) > 0 || humanMentions.length > 0,
  );

  // 普通对话里消息带数字人归属时，也自动建立服务端房间，让右侧能展示群聊；
  // 但项目当前没有任何可用数字人时，忽略历史归属，不再带出协作入口。
  const sessionHasAttributed = useMemo(
    () => digitalHumansLoaded && digitalHumans.length > 0
      && messages.some((message) => Boolean(message.attribution)),
    [digitalHumans, digitalHumansLoaded, messages],
  );
  useEffect(() => {
    if (!port || !sessionHasAttributed || serverRoomId || !activeSessionId) return;
    let cancelled = false;
    void ensureServerRoom(
      port,
      activeSessionId,
      sessionTitle(activeSession || { agentId: activeSessionId }, customSessionTitles),
      projectPathFromMap(sessionProjectMapRef.current, activeSessionId, activeProjectPathRef.current) || "default",
    ).then(async (ensured) => {
      if (cancelled) return;
      // 把消息里出现过的数字人也登记进房间参与者，右侧群聊/参与者列表才能完整
      const attributionIds = new Set(
        messages.map((message) => message.attribution?.digitalHumanId).filter((id): id is string => Boolean(id)),
      );
      let snapshot = ensured;
      for (const id of attributionIds) {
        if ((snapshot.participants || []).some((p) => p.digitalHumanId === id)) continue;
        try {
          snapshot = await joinServerRoom(port, ensured.id, id);
        } catch {
          // 单个加入失败不阻断房间建立
        }
      }
      if (cancelled) return;
      setServerRoomId(snapshot.id);
      setServerRoom(snapshot);
      setRoom(serverRoomToProjection(snapshot));
    }).catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionHasAttributed, port, activeSessionId, serverRoomId]);

  // 输入框胶囊上叠加的项目数字人（仅显式归属当前项目的，最多堆 3 个头像）
  const activeProjectOwnedHumans = useMemo(() => (
    digitalHumans.filter((human) => human.projectPath && human.projectPath === activeProjectPath)
  ), [activeProjectPath, digitalHumans]);

  // 协作运行态在发送瞬间先乐观置为 true；会话切换和房间视图回调会负责复位。
  const roomStreamingEffective = roomRunning && Boolean(port);

  const stopCurrentRun = useCallback(() => {
    abortControllersRef.current.get(activeSessionId)?.abort();
    if (!port) return;
    const roomId = serverRoomId || boundRoomId(activeSessionId) || "";
    if (!roomId) return;
    void (async () => {
      const snapshot = serverRoom?.id === roomId ? serverRoom : await fetchServerRoom(port, roomId);
      const activeTaskIds = (snapshot.tasks || [])
        .filter((task) => ["READY", "ASSIGNED", "RUNNING", "WAITING_APPROVAL"].includes(task.state))
        .map((task) => task.taskId);
      if (activeTaskIds.length === 0) return;
      await Promise.allSettled(activeTaskIds.map((taskId) => cancelRoomTask(port, roomId, taskId)));
      const refreshed = await fetchServerRoom(port, roomId);
      setServerRoom(refreshed);
      setRoom(serverRoomToProjection(refreshed));
    })().catch(() => undefined).finally(() => setRoomRunning(false));
  }, [activeSessionId, port, serverRoom, serverRoomId]);

  const refreshDigitalHumans = useCallback(async (servicePort: number | null) => {
    try {
      const humans = await listDigitalHumans(servicePort);
      setDigitalHumans(humans);
      setDigitalHumansLoaded(true);
      setSelectedHumanId((current) => current || humans[0]?.id || "");
      // 首次启动且目录为空时，自动登记一个指向本地 Runtime 的默认数字人，
      // 让「数字人」能力开箱可见，而非空目录
      if (humans.length === 0 && servicePort) {
        const seeded = await createDigitalHuman(servicePort, {
          displayName: "本地助手",
          avatarRef: "🤖",
          purpose: "使用本机智能体服务的通用数字人，可承担开发、分析与文档任务",
          roleTags: ["local", "general"],
          themeColor: "#4160f0",
          approvalPolicy: "WRITE_REQUIRES_APPROVAL",
          concurrencyLimit: 1,
          endpoint: { type: "local-dsh", protocolVersion: "dsh.v1", healthState: "online" },
        });
        setDigitalHumans([seeded]);
        setSelectedHumanId(seeded.id);
      }
    } catch {
      setDigitalHumansLoaded(true);
    }
  }, []);

  useEffect(() => {
    humanMentionsRef.current = humanMentions;
  }, [humanMentions]);

  useEffect(() => {
    digitalHumansRef.current = digitalHumans;
  }, [digitalHumans]);

  // 数字人目录：服务就绪后加载
  useEffect(() => {
    if (serviceReady && port) void refreshDigitalHumans(port);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceReady, port]);

  // 房间：会话切换时解析服务端房间（已绑定则复用），并保留本地投影兜底
  useEffect(() => {
    setHumanMentions([]);
    setServerRoom(null);
    setServerRoomId("");
    // 切会话必须复位协作运行态：旧会话的 RoomCollaborationView 卸载后不会再回调
    // onRunningChange(false)，残留的 roomRunning 会把新会话的输入框永久禁用
    setRoomRunning(false);
    if (!port) {
      setRoom(readRoom(activeSessionId));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bound = boundRoomId(activeSessionId);
        if (bound) {
          const snapshot = await fetchServerRoom(port, bound);
          if (cancelled) return;
          setServerRoom(snapshot);
          setServerRoomId(snapshot.id);
          setRoom(serverRoomToProjection(snapshot));
        } else {
          setRoom(readRoom(activeSessionId));
        }
      } catch {
        if (!cancelled) setRoom(readRoom(activeSessionId));
      }
    })();
    return () => { cancelled = true; };
  }, [activeSessionId, port]);

  /** 服务端房间快照 → 本地投影（成员栏/协作面板复用同一投影模型） */
  const serverRoomToProjection = (snapshot: ServerRoomView): RoomProjection => ({
    roomId: snapshot.id,
    objective: snapshot.objective,
    participants: (snapshot.participants || []).map((p) => ({
      digitalHumanId: p.digitalHumanId,
      presence: (p.presence || "idle") as RoomProjection["participants"][number]["presence"],
      activeTaskLabel: p.activeTaskLabel,
      joinedAt: "",
    })),
  });

  // 打开产物：新增/激活对应标签并展开面板
  const openArtifactTab = useCallback((artifact: { artifactId?: string; title: string; producerName?: string }) => {
    const id = artifact.artifactId || artifact.title;
    setArtifactTabs((current) => (
      current.some((tab) => tab.id === id) ? current : [...current, { id, label: artifact.title }]
    ));
    setActiveDockTab(`artifact:${id}`);
    setDockOpen(true);
  }, []);

  /** 独立文件渲染：任意本地文件（md/word/excel/pdf/图片）在右侧面板打开 */
  const openFileTab = useCallback((filePath: string) => {
    const label = filePath.split("/").filter(Boolean).pop() || filePath;
    setArtifactTabs((current) => (
      current.some((tab) => tab.id === filePath) ? current : [...current, { id: filePath, label, kind: "file" }]
    ));
    setActiveDockTab(`file:${filePath}`);
    setDockOpen(true);
  }, []);

  const closeArtifactTab = useCallback((id: string) => {
    const [kind, ...rest] = id.split(":");
    const targetId = rest.join(":");
    const prefix = kind === "file" ? "file" : "artifact";
    setArtifactTabs((current) => {
      const next = current.filter((tab) => tab.id !== targetId || (tab.kind === "file") !== (prefix === "file"));
      // 关掉的是激活标签时，回退到协作/信息
      setActiveDockTab((active) => (
        active === `${prefix}:${targetId}` ? (next.length > 0 ? `${next[next.length - 1].kind === "file" ? "file" : "artifact"}:${next[next.length - 1].id}` : "collab") : active
      ));
      return next;
    });
  }, []);

  // Dock Esc 关闭（原 RightDock 内部逻辑，Tab 栏上移到顶栏后由 App 接管）
  useEffect(() => {
    if (!dockOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeDockTab.startsWith("artifact:") || activeDockTab.startsWith("file:")) closeArtifactTab(activeDockTab);
      else setDockOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dockOpen, activeDockTab, closeArtifactTab]);

  const joinCurrentRoom = useCallback((human: DigitalHuman) => {
    setPickerOpen(false);
    if (!port) return;
    void (async () => {
      try {
        // 确保房间存在（未绑定则以当前会话标题创建），再加入
        const title = sessionTitle(activeSession || { agentId: activeSessionId }, customSessionTitles);
        const ensured = await ensureServerRoom(
          port,
          activeSessionId,
          title,
          projectPathFromMap(sessionProjectMapRef.current, activeSessionId, activeProjectPathRef.current) || "default",
        );
        const snapshot = await joinServerRoom(port, ensured.id, human.id);
        setServerRoom(snapshot);
        setServerRoomId(snapshot.id);
        setRoom(serverRoomToProjection(snapshot));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, port]);

  const leaveCurrentRoom = useCallback((digitalHumanId: string) => {
    setHumanMentions((current) => current.filter((human) => human.id !== digitalHumanId));
    if (!port || !serverRoomId) return;
    void (async () => {
      try {
        const snapshot = await leaveServerRoom(port, serverRoomId, digitalHumanId);
        setServerRoom(snapshot);
        setRoom(serverRoomToProjection(snapshot));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [port, serverRoomId]);

  const loadWorkspaceData = useCallback(async (servicePort: number, focusModelsIfEmpty = false) => {
    const sessionsPromise = listSessions(servicePort);
    const projectsPromise = listWorkspaces(servicePort);
    const modelSettingsPromise = listModelSettings(servicePort);
    const runtimeModelsPromise = listAvailableModels(servicePort);
    const approvalsPromise = listRuntimeApprovals(servicePort);
    const primaryLoad = Promise.allSettled([sessionsPromise, projectsPromise]);
    const secondaryLoad = Promise.allSettled([modelSettingsPromise, runtimeModelsPromise, approvalsPromise]);

    // 会话/项目决定左侧列表首屏，优先落状态；模型和审批等相对慢的接口随后再补齐。
    const [sessionsResult, projectsResult] = await primaryLoad;

    if (sessionsResult.status === "fulfilled") {
      const loadedSessions = sessionsResult.value;
      setSessions(loadedSessions);
      // 重启/刷新后服务端返回的会话可能只有 sessionId，而映射当初只按草稿阶段的 agentId 记录，
      // 导致分组时按 sessionId 查不到项目、被错误归入"默认工作区"。这里做两级回填：
      // 1) 服务端 SessionHeader 持久化的 workspaceId（即会话创建时的 cwd / 项目路径）是权威来源；
      // 2) 本地映射里已存在的归属则补齐到同会话的其他 ID（agentId <-> sessionId）。
      setSessionProjectMap((current) => {
        let changed = false;
        const next: Record<string, string> = {};
        for (const [id, path] of Object.entries(current)) {
          const normalized = normalizedProjectPath(path);
          if (normalized) next[id] = normalized;
          else if (path === "default") next[id] = "default";
          else changed = true;
        }
        for (const session of loadedSessions) {
          const ids = [session.sessionId, session.agentId].filter((id): id is string => Boolean(id));
          // 本地映射优先（发送消息时已按会话归属写入并与服务端 cwd 对齐）；
          // 服务端 workspaceId 仅作兜底，用于补齐本地缺失的老会话归属
          const localProjectPath = ids.map((id) => next[id]).find((value) => value === "default" || Boolean(normalizedProjectPath(value)));
          const projectPath = localProjectPath || normalizedProjectPath(session.workspaceId);
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
      const latestProjects = projectsResult.value;
      setProjects(latestProjects);
      // 不主动切换激活项目：空值代表「默认工作区」，应保留用户的显式选择，
      // 否则每次刷新都会把用户从默认工作区悄悄挪到第一个项目上，
      // 新建的对话也会因此挂错归属，看起来就像「新对话没反应」。
      setActiveProjectPath((current) => (
        current && !latestProjects.some((project) => project.path === current) ? "" : current
      ));
    }
    const [modelSettingsResult, runtimeModelsResult, approvalsResult] = await secondaryLoad;
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
    setLocalProjects(JSON.parse(localStorage.getItem("dsh-local-projects") || "[]"));
    // 启动时如果 activeSessionId 不在草稿列表里（比如上次是点项目/会话后直接退出的，
    // 或 localStorage 被清过但 active id 还留着），补登记一条归属默认工作区的草稿。
    // 否则这个 id 在侧栏里不可见，「新对话」的复用判断也找不到它，点了就像没反应。
    setDraftSessions((current) => {
      if (current.some((session) => session.agentId === activeSessionId || session.sessionId === activeSessionId)) {
        return current;
      }
      return [{
        agentId: activeSessionId,
        title: "新对话",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, ...current];
    });
  }, []);

  useEffect(() => {
    localStorage.setItem("dsh-active-session-id", activeSessionId);
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    activeProjectPathRef.current = activeProjectPath;
    localStorage.setItem("dsh-active-project-path", activeProjectPath);
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
    localStorage.setItem("dsh-project-order", JSON.stringify(projectOrder));
  }, [projectOrder]);

  useEffect(() => {
    localStorage.setItem("dsh-session-order", JSON.stringify(sessionOrder));
  }, [sessionOrder]);

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
      setService(existingState);
      if (existingState.status === "running" && existingState.port) {
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
    const sessionId = session?.sessionId || activeSessionId;
    let cancelled = false;
    const targetIds = new Set(idsOfSession(session));
    targetIds.add(activeSessionId);
    void listMessages(port, sessionId)
      .then((loaded) => {
        if (cancelled || !targetIds.has(activeSessionRef.current)) return;
        const normalized = loaded
          .map(normalizeConversationMessage)
          .filter((message): message is ConversationMessage => Boolean(message));
        // 本地缓存里可能已有归属信息（流式时写入），服务端拉回时回填
        const cached = [...targetIds]
          .map((id) => sessionMessagesRef.current.get(id) || readSessionMessages(id))
          .find((items) => items.length > 0) || [];
        const merged = mergeAttributionFromCache(normalized, cached);
        if (merged.length > 0) {
          for (const id of targetIds) {
            sessionMessagesRef.current.set(id, merged);
            writeSessionMessages(id, merged);
          }
          setMessages(merged);
        }
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
    const session = combinedSessionsRef.current.find((item) => idsOfSession(item).includes(sessionId));
    const aliases = idsOfSession(session);
    if (!aliases.includes(sessionId)) aliases.push(sessionId);
    const canonicalSessionId = session?.sessionId || sessionId;
    const cachedMessages = aliases
      .map((id) => sessionMessagesRef.current.get(id) || readSessionMessages(id))
      .find((items) => items.length > 0) || [];
    const currentHumans = digitalHumansRef.current;
    // 先立即展示本地缓存，避免等待接口时先清空成首页、再二次闪回消息
    for (const id of aliases) sessionMessagesRef.current.set(id, cachedMessages);
    activeSessionRef.current = sessionId;
    setMessages(stripDigitalHumanAttribution(cachedMessages, currentHumans));
    setActiveSessionId(sessionId);
    setActiveView("conversation");
    // 同步输入框项目选择器到该会话所属项目；无归属（默认工作区）时回退为空
    const hasDefaultProject = aliases.some((id) => sessionProjectMapRef.current[id] === "default");
    const sessionProject = hasDefaultProject ? "" : aliases.map((id) => normalizedProjectPath(sessionProjectMapRef.current[id])).find(Boolean)
      || normalizedProjectPath(session?.workspaceId);
    setActiveProjectPath(sessionProject || "");

    try {
      const loadedMessages = (await listMessages(port, canonicalSessionId))
        .map(normalizeConversationMessage)
        .filter((message): message is ConversationMessage => Boolean(message));
      // 服务端消息没有归属（本地投影），从本地缓存回填后展示
      const withAttribution = mergeAttributionFromCache(loadedMessages, cachedMessages);
      const nextMessages = stripDigitalHumanAttribution(withAttribution, currentHumans);
      for (const id of aliases) {
        sessionMessagesRef.current.set(id, nextMessages);
        writeSessionMessages(id, nextMessages);
      }
      if (activeSessionRef.current === sessionId) {
        setMessages(nextMessages);
      }
    } catch {
      // 服务端不可用时保留本地缓存即可
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
          const cached = sessionMessagesRef.current.get(activeSessionId) || [];
          const merged = mergeAttributionFromCache(normalized, cached);
          const currentCount = cached.length;
          if (merged.length > currentCount) {
            updateMessagesForAliases(aliases, () => merged);
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
    const sessionProjectPath = projectPathFromMap(sessionProjectMap, activeSessionId, activeProjectPath);
    return localProjects.filter((project) => project.parentPath === sessionProjectPath);
  }, [activeProjectPath, activeSessionId, localProjects, sessionProjectMap]);

  // 输入框中 @ 引用的工程（优先于"归属项目下挂载工程"作为对话上下文）
  const [draftMentions, setDraftMentions] = useState<WorkspaceEntry[]>([]);
  const contextProjects = draftMentions.length > 0 ? draftMentions : sessionSelectedProjects;

  const outgoingMessage = useMemo(() => {
    const cleanDraft = stripInvisibleChars(draft).trim();
    if (contextProjects.length === 0) {
      outgoingMessageRef.current = cleanDraft;
      return cleanDraft;
    }
    const context = contextProjects
      .map((project) => `- ${project.name}: ${project.path}`)
      .join("\n");
    const value = `${cleanDraft}\n\n${HIDDEN_CONTEXT_OPEN}\n[当前选择的工程]\n${context}\n\n[重要] 上述工程目录已被用户授权为本项目的工作目录。所有文件读取、写入、编辑都必须在这些工程目录内进行，请使用绝对路径（如 ${contextProjects[0]?.path ?? ""}/...），不要使用用户主目录、桌面或其他无关路径。${HIDDEN_CONTEXT_CLOSE}`;
    outgoingMessageRef.current = value;
    return value;
  }, [contextProjects, draft]);

  const sendMessage = useCallback(async () => {
    const text = stripInvisibleChars(draft).trim();
    const originSessionId = activeSessionId;
    if (!text || sessionRunsRef.current[originSessionId]) return;
    if (!port || !serviceReady) {
      setError("智能体服务未就绪，请等待启动完成或查看服务日志");
      return;
    }
    if (!activeModel) {
      setActiveView("settings");
      setError("请先配置并激活一个可用模型");
      return;
    }
    const runTitle = truncateSessionTitle(visibleMessageText(visibleUserMessage(text))) || text;

    // ── 项目配置的数字人：会话归属项目下的显式归属数字人（发消息前就解析一次，
    // 同时决定「走房间编排（多人）还是直连（单人）」与直连时的归属）
    const sessionProjectPathForHumans = projectPathFromMap(sessionProjectMapRef.current, originSessionId, activeProjectPathRef.current);
    const projectHumans = sessionProjectPathForHumans
      ? digitalHumansRef.current.filter((human) => human.projectPath === sessionProjectPathForHumans)
      : [];

    // ── 房间协作消息：房间有参与者、输入框 @/卡片加入了数字人，
    // 或项目配置了数字人时，交给服务端 Orchestrator（含单个远端数字人的真实执行）
    const roomHasParticipants = Boolean(
      (serverRoom?.participants?.length || 0) > 0
      || (room?.participants.length || 0) > 0
      || humanMentionsRef.current.length > 0
      || projectHumans.length > 0,
    );
    if (roomHasParticipants) {
      const mentionedHumans = humanMentionsRef.current;
      const createdAt = new Date().toISOString();
      const userMessage: ConversationMessage = {
        role: "user",
        content: text,
        createdAt,
        mentions: draftMentions.length > 0 ? draftMentions : undefined,
      };
      try {
        setError("");
        setRoomRunning(true);
        setDraft("");
        setDraftMentions([]);
        setHumanMentions([]);
        setSessionProjectMap((current) => ({ ...current, [originSessionId]: storedProjectPath(sessionProjectPathForHumans) }));
        setDraftSessions((current) => {
          const updated = current.map((session) => (
            session.agentId === originSessionId || session.sessionId === originSessionId
              ? { ...session, title: runTitle, updatedAt: createdAt }
              : session
          ));
          return updated.some((session) => session.agentId === originSessionId || session.sessionId === originSessionId)
            ? updated
            : [{ agentId: originSessionId, title: runTitle, createdAt, updatedAt: createdAt }, ...updated];
        });
        updateMessagesForAliases([originSessionId], (current) => [...current, userMessage]);
        // 确保 @chips 与项目配置的数字人都已加入房间
        const title = sessionTitle(activeSession || { agentId: originSessionId, title: runTitle }, customSessionTitles);
        const ensured = await ensureServerRoom(port, originSessionId, title === "新对话" ? runTitle : title, sessionProjectPathForHumans || "default");
        let snapshot = ensured;
        const toJoin = [...mentionedHumans, ...projectHumans];
        for (const human of toJoin) {
          const alreadyIn = (snapshot.participants || []).some((p) => p.digitalHumanId === human.id);
          if (!alreadyIn) {
            try {
              snapshot = await joinServerRoom(port, ensured.id, human.id);
            } catch {
              // 单个加入失败不阻断主流程
            }
          }
        }
        // @ 提及优先作为派发目标；否则项目多数字人由 Orchestrator 自行分工
        const mentionIds = mentionedHumans.map((human) => human.id);
        const tokenHumans = digitalHumansRef.current.filter((human) => (
          (snapshot.participants || []).some((participant) => participant.digitalHumanId === human.id)
        ));
        const digitalHumanTokens = await digitalHumanTokensFor(tokenHumans);
        await postRoomMessage(port, ensured.id, text, mentionIds, activeModel.channelCode, approvalMode, digitalHumanTokens);
        setServerRoomId(ensured.id);
        // 协作开始：自动展开右侧协作面板
        setActiveDockTab("collab");
        setDockOpen(true);
        // 房间快照刷新（事件流会持续推进，这里补一次即时同步）
        const refreshed = await fetchServerRoom(port, ensured.id);
        setServerRoom(refreshed);
        setRoom(serverRoomToProjection(refreshed));
      } catch (caught) {
        setRoomRunning(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      return;
    }
    const runAgentId = activeSession?.agentId || originSessionId;

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
    const sessionProjectPath = projectPathFromMap(sessionProjectMapRef.current, originSessionId, activeProjectPath);
    setSessionProjectMap((current) => ({ ...current, [originSessionId]: storedProjectPath(sessionProjectPath) }));
    const createdAt = new Date().toISOString();

    // 数字人归属解析（直连路径，此时项目数字人至多 1 个，多人已在上方走房间编排）：
    // 1. 输入框 @ 提及的数字人；
    // 2. 房间唯一参与者；
    // 3. 会话归属项目下配置的数字人（提示词带角色设定）
    const roomNow = readRoom(originSessionId);
    const mentionedHumans = humanMentionsRef.current;
    let actingHuman: DigitalHuman | null = mentionedHumans[0] || null;
    if (!actingHuman && roomNow?.participants.length === 1) {
      actingHuman = digitalHumansRef.current.find((h) => h.id === roomNow.participants[0].digitalHumanId) || null;
    }
    if (!actingHuman && projectHumans.length > 0) {
      actingHuman = projectHumans.find((human) => human.endpoint.healthState !== "offline") || projectHumans[0];
    }
    const attribution = actingHuman
      ? {
          digitalHumanId: actingHuman.id,
          displayName: actingHuman.displayName,
          avatarRef: actingHuman.avatarRef,
          themeColor: actingHuman.themeColor,
          taskLabel: truncateSessionTitle(text) || undefined,
        }
      : undefined;
    setActiveHumanId(actingHuman?.id || "");
    if (actingHuman) {
      // 归属确定时同步写本地房间投影：右侧协作面板据此出现（群聊/参与者）
      joinRoom(originSessionId, actingHuman);
      ensureRoomObjective(originSessionId, truncateSessionTitle(text) || text);
      updatePresence(originSessionId, actingHuman.id, "working", truncateSessionTitle(text) || undefined);
      setRoom(readRoom(originSessionId));
    }

    const userMessage: ConversationMessage = {
      role: "user",
      content: text,
      createdAt,
      mentions: draftMentions.length > 0 ? draftMentions : undefined,
    };
    setDraftMentions([]);
    setHumanMentions([]);
    const assistantMessage: ConversationMessage = {
      role: "assistant", content: "", reasoning: "", createdAt, attribution,
    };
    updateMessagesForAliases([originSessionId], (current) => [...current, userMessage, assistantMessage]);

    // 有数字人时，提示词前加角色指令：让本地 Runtime 以该数字人身份与职责执行
    const finalOutgoing = actingHuman
      ? `[角色设定] 你是「${actingHuman.displayName}」，职责：${actingHuman.purpose}。请以该身份完成任务，回复时保持其专业视角。\n\n${outgoingMessageRef.current}`
      : outgoingMessageRef.current;

    try {
      await streamAgentMessage(
        port,
        {
          agentId: runAgentId,
          message: finalOutgoing,
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
                attribution,
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
                const adopt = normalized.length > current.length || richness(normalized) > richness(current);
                const base = adopt ? normalized : current;
                // 服务端不知道数字人归属（本地投影），无论采用哪份内容都要把归属补回去
                return base.map((message) => {
                  if (message.attribution || !attribution) return message;
                  return (message.role === "assistant" || message.role === "tool")
                    ? { ...message, attribution }
                    : message;
                }).map((message) => (
                  // 采用本地累计内容时，把仍在 running 的工具标记为完成，避免永久"执行中"
                  !adopt && message.role === "tool" && message.status === "running"
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
      const message = caught instanceof Error ? caught.message : String(caught);
      // Tauri plugin-http 取消请求时不一定抛标准 AbortError，
      // 常见文案还有 "Request cancelled" / "canceled" 等，需要一并识别，
      // 否则用户手动停止会被当成普通错误显示出来。
      const isAbort =
        (caught instanceof DOMException && caught.name === "AbortError")
        || /request cancell?ed|\babort(?:ed)?\b/i.test(message);
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
      // 数字人任务结束：在场状态复位为空闲，归属头像收起
      if (actingHuman) {
        updatePresence(originSessionId, actingHuman.id, "idle");
        setRoom(readRoom(originSessionId));
        setActiveHumanId("");
      }
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
    customSessionTitles,
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
    room,
    serverRoom,
    serviceReady,
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
      setProjectOrder((current) => current.map((path) => (path === project.path ? nextParentPath : path)));
      setActiveProjectPath(nextParentPath);
      setSessionProjectMap((current) => {
        let changed = false;
        const next = { ...current };
        for (const [sessionId, projectPath] of Object.entries(next)) {
          if (projectPath === project.path) {
            next[sessionId] = nextParentPath;
            changed = true;
          }
        }
        return changed ? next : current;
      });
      setDigitalHumans((current) => current.map((human) => {
        if (human.projectPath !== project.path) return human;
        assignDigitalHumanToProject(human.id, nextParentPath);
        return { ...human, projectPath: nextParentPath };
      }));
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

  const startConversation = useCallback((project?: WorkspaceEntry, options?: { reuseEmptyDraft?: boolean; projectPath?: string }) => {
    // 顶部「新对话」不传 project 时，归属当前激活项目；项目行的 + 号则明确归属该项目
    const projectPath = project ? project.path : options?.projectPath ?? activeProjectPathRef.current;
    setActiveProjectPath(projectPath);
    // 仅复用「真正空白且可见」的新对话：没有 sessionId（从未持久化到服务端）、
    // 标题仍是占位文案（发过消息的会话 title 会被替换成消息摘要）、
    // 且确实在会话列表中展示（僵尸 draft——id 与服务端会话撞车被去重过滤、
    // 永远不可见——不能复用，否则点了就像没反应）。
    const existingEmptyDraft = options?.reuseEmptyDraft ? draftSessionsRef.current.find((session) => {
      const id = session.agentId || "";
      if (!id || session.sessionId) return false;
      const belongsTo = sessionProjectMapRef.current[id] ?? "";
      const untouched = (session.title || "新对话") === "新对话";
      const visible = combinedSessionsRef.current.some((item) => item.agentId === id);
      return belongsTo === projectPath && untouched && visible;
    }) : undefined;
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
    setSessionProjectMap((current) => ({ ...current, [sessionId]: storedProjectPath(projectPath) }));
    setActiveView("conversation");
  }, []);

  const removeProject = useCallback(async (project: WorkspaceEntry) => {
    if (project.local) {
      setLocalProjects((current) => current.filter((item) => item.path !== project.path));
      setProjectOrder((current) => current.filter((path) => path !== project.path));
      return;
    }
    if (!port) return;
    setError("");
    try {
      const latest = await deleteWorkspace(port, project.name);
      setProjects(latest);
      setProjectOrder((current) => current.filter((path) => path !== project.path));
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
    setSessionOrder((current) => {
      let changed = false;
      const next: Record<string, string[]> = {};
      for (const [projectPath, orderedIds] of Object.entries(current)) {
        const filtered = orderedIds.filter((id) => !idSet.has(id));
        if (filtered.length !== orderedIds.length) changed = true;
        next[projectPath] = filtered;
      }
      return changed ? next : current;
    });

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
        setSessionProjectMap((current) => ({ ...current, [freshId]: storedProjectPath(activeProjectPath) }));
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
    setProjectOrder((current) => current.filter((path) => path !== project.path));
  }, []);

  const reorderSessions = useCallback((dragIds: string[], targetIds: string[], projectPath: string, position: "before" | "after" = "before") => {
    const dragId = dragIds.find(Boolean);
    const targetId = targetIds.find(Boolean);
    if (!dragId || !targetId || dragId === targetId) return;
    const normalizedPath = normalizedProjectPath(projectPath);
    const sessionsInProject = combinedSessions.filter((session) => {
      const ids = idsOfSession(session);
      const mappedPath = ids.some((id) => sessionProjectMapRef.current[id] === "default")
        ? ""
        : ids.map((id) => normalizedProjectPath(sessionProjectMapRef.current[id])).find(Boolean)
          || normalizedProjectPath(session.workspaceId)
          || "";
      return mappedPath === normalizedPath;
    });
    setSessionOrder((current) => {
      const projectKey = normalizedPath || "default";
      const knownIds = sessionsInProject.map((session) => idsOfSession(session)[0]).filter((id): id is string => Boolean(id));
      const ordered = [
        ...(current[projectKey] || []).filter((id) => knownIds.includes(id)),
        ...knownIds.filter((id) => !(current[projectKey] || []).includes(id)),
      ];
      const fromIndex = ordered.indexOf(dragId);
      const toIndex = ordered.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) return current;
      const nextOrder = [...ordered];
      const [moved] = nextOrder.splice(fromIndex, 1);
      const targetIndexAfterRemoval = nextOrder.indexOf(targetId);
      if (targetIndexAfterRemoval < 0) return current;
      nextOrder.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, moved);
      return { ...current, [projectKey]: nextOrder };
    });
  }, [combinedSessions]);

  const moveSessionToProject = useCallback((sessionIds: string[], projectPath: string) => {
    const normalizedPath = storedProjectPath(projectPath);
    const ids = [...new Set(sessionIds.filter(Boolean))];
    if (ids.length === 0) return;
    setSessionProjectMap((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of ids) {
        if (next[id] !== normalizedPath) {
          next[id] = normalizedPath;
          changed = true;
        }
      }
      return changed ? next : current;
    });
    if (ids.includes(activeSessionRef.current)) {
      setActiveProjectPath(normalizedProjectPath(projectPath));
    }
    setSessionOrder((current) => {
      const destinationKey = normalizedProjectPath(projectPath) || "default";
      let changed = false;
      const next: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(current)) {
        const filtered = value.filter((id) => !ids.includes(id));
        if (filtered.length !== value.length) changed = true;
        next[key] = filtered;
      }
      const existing = next[destinationKey] || [];
      const movedIds = ids.filter((id) => !existing.includes(id));
      if (movedIds.length > 0) {
        next[destinationKey] = [...movedIds, ...existing];
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  const reorderProjects = useCallback((dragPath: string, targetPath: string, position: "before" | "after" = "before") => {
    if (!dragPath || !targetPath || dragPath === targetPath) return;
    setProjectOrder((current) => {
      const allProjects = [...projects, ...localProjects];
      const topLevelPaths = [...new Map(allProjects.map((project) => [project.path, project])).values()]
        .filter((project) => !project.local || !project.parentPath)
        .map((project) => project.path);
      const ordered = [
        ...current.filter((path) => topLevelPaths.includes(path)),
        ...topLevelPaths.filter((path) => !current.includes(path)),
      ];
      const fromIndex = ordered.indexOf(dragPath);
      const toIndex = ordered.indexOf(targetPath);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...ordered];
      const [moved] = next.splice(fromIndex, 1);
      const targetIndexAfterRemoval = next.indexOf(targetPath);
      const insertIndex = position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
      next.splice(insertIndex, 0, moved);
      return next;
    });
  }, [localProjects, projects]);

  const selectProject = useCallback((project: WorkspaceEntry) => {
    setActiveProjectPath(project.path);
    setActiveView("conversation");
    startConversation(project, { reuseEmptyDraft: true });
  }, [startConversation]);

  const selectDefaultWorkspace = useCallback(() => {
    setActiveProjectPath("");
    setActiveView("conversation");
    startConversation(undefined, { reuseEmptyDraft: true, projectPath: "" });
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
    const allProjects = [...byPath.values()];
    const topLevelPaths = allProjects
      .filter((project) => !project.local || !project.parentPath)
      .map((project) => project.path);
    const orderedPaths = [
      ...projectOrder.filter((path) => topLevelPaths.includes(path)),
      ...topLevelPaths.filter((path) => !projectOrder.includes(path)),
    ];
    const orderIndex = new Map(orderedPaths.map((path, index) => [path, index]));
    return allProjects.sort((a, b) => {
      const aTopLevel = !a.local || !a.parentPath;
      const bTopLevel = !b.local || !b.parentPath;
      if (aTopLevel && bTopLevel) {
        return (orderIndex.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.path) ?? Number.MAX_SAFE_INTEGER);
      }
      if (aTopLevel !== bTopLevel) return aTopLevel ? -1 : 1;
      const aParentIndex = orderIndex.get(a.parentPath || "") ?? Number.MAX_SAFE_INTEGER;
      const bParentIndex = orderIndex.get(b.parentPath || "") ?? Number.MAX_SAFE_INTEGER;
      if (aParentIndex !== bParentIndex) return aParentIndex - bParentIndex;
      return a.name.localeCompare(b.name, "zh-CN");
    });
  }, [localProjects, projectOrder, projects]);
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
      {/* 顶部全局操作栏：跨侧栏与主区，右侧承载 协作/信息/产物 Tab */}
      <header className="app-toolbar" data-tauri-drag-region>
        <div className="app-toolbar-title" data-tauri-drag-region>DSH Java Desktop</div>
        <div className="app-toolbar-actions">
          <DockTabBar
            activeTab={activeDockTab}
            artifactTabs={artifactTabs}
            hasCollab={hasCollab}
            dockOpen={dockOpen}
            onSelectTab={setActiveDockTab}
            onToggle={toggleDockTab}
            onCloseArtifact={closeArtifactTab}
            onClose={() => setDockOpen(false)}
          />
        </div>
      </header>

      <div className="app-body">
      <Sidebar
        activeView={activeView}
        activeSessionId={activeSessionId}
        activeProjectPath={activeProjectPath}
        streaming={streaming}
        runningSessionIds={Object.keys(sessionRuns)}
        projects={combinedProjects}
        sessions={combinedSessions}
        sessionProjectMap={sessionProjectMap}
        sessionOrder={sessionOrder}
        creatingProject={creatingProject}
        projectModalOpen={projectModalOpen}
        projectName={projectName}
        onViewChange={setActiveView}
        onSelectDefaultWorkspace={selectDefaultWorkspace}
        onSelectSession={(id) => void selectSession(id)}
        sessionCustomTitles={customSessionTitles}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onMoveSessionToProject={moveSessionToProject}
        onReorderSessions={reorderSessions}
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
        onReorderProjects={reorderProjects}
        onRemoveProject={(project) => void removeProject(project)}
        onRemoveLocalProject={removeLocalProject}
        digitalHumans={digitalHumans}
        onAssignDigitalHuman={(humanId, projectPath, checked) => {
          void assignDigitalHumanToProject(humanId, checked ? projectPath : "");
          void refreshDigitalHumans(port);
        }}
        onCreateDigitalHuman={(project) => {
          setWizardProjectPath(project.path);
          setWizardOpen(true);
        }}
      />

      <main className="main-panel">
        <div className="main-panel-content">
        {!(activeView === "conversation" && messages.length === 0) ? (
          <header className="topbar">
            <div>
              <h1>
                {activeView === "conversation"
                  ? sessionTitle(activeSession || { agentId: activeSessionId }, customSessionTitles)
                  : activeView === "digital-humans" ? "数字人" : "工作台"}
              </h1>
              <p>
                {activeProject ? `${activeProject.name} · ` : ""}
                {modelChoices.length > 0 ? `${modelChoices.length} 个模型可用` : "未配置模型"}
              </p>
            </div>
          </header>
        ) : (
          <header className="topbar topbar-compact">
            <div>
              <h1>新对话</h1>
              <p>
                {activeProject ? `${activeProject.name} · ` : ""}
                {modelChoices.length > 0 ? `${modelChoices.length} 个模型可用` : "未配置模型"}
              </p>
            </div>
          </header>
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
            onStopGeneration={stopCurrentRun}
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
            room={room}
            // 传全量目录：消息归属头像的信息卡需要按 id 查完整档案，
            // 只传项目子集会导致全局/其他项目数字人显示「角色详情不可用」
            digitalHumans={digitalHumans}
            projectHumans={activeProjectOwnedHumans}
            onRemoveParticipant={leaveCurrentRoom}
            humanMentions={humanMentions}
            onHumanMentionsChange={setHumanMentions}
            activeHuman={activeHuman}
            roomContent={serverRoomId && port && (room?.participants.length || 0) > 0 ? (
              <RoomCollaborationView
                port={port}
                roomId={serverRoomId}
                humans={digitalHumans}
                channelCode={activeModel?.channelCode}
                approvalMode={approvalMode}
                onRoomChange={(snapshot) => {
                  setServerRoom(snapshot);
                  setRoom(serverRoomToProjection(snapshot));
                }}
                onRunningChange={setRoomRunning}
                onOpenArtifact={openArtifactTab}
                onOpenFile={openFileTab}
                starting={roomStreamingEffective}
                focusRequest={focusRequest}
              />
            ) : null}
            onOpenFile={openFileTab}
            roomStreaming={roomStreamingEffective}
          />
        ) : activeView === "digital-humans" ? (
          <DigitalHumanCatalog
            humans={digitalHumans}
            loading={!digitalHumansLoaded}
            selectedId={selectedHumanId}
            onSelect={setSelectedHumanId}
            onAdd={() => {
              setWizardProjectPath("");
              setWizardOpen(true);
            }}
            onChanged={() => void refreshDigitalHumans(port)}
            port={port}
            projects={combinedProjects.filter((project) => !project.local || !project.parentPath)}
          />
        ) : null}
        </div>

        {/* 右侧面板：只承载内容，Tab 栏统一在顶部 app-toolbar */}
        {dockOpen ? (
          <RightDock>
            {activeDockTab === "collab" ? (
              <CollabPanel
                room={room}
                humans={digitalHumans}
                objective={room?.objective || sessionTitle(activeSession || { agentId: activeSessionId }, customSessionTitles)}
                streaming={streaming}
                approvals={approvals.filter((approval) =>
                  !approval.sessionId || approval.sessionId === activeSessionId)}
                resolvingApprovalId={resolvingApprovalId}
                onResolveApproval={(approvalId, verdict) => void resolveApproval(approvalId, verdict)}
                onInvite={() => setPickerOpen(true)}
                onRemoveParticipant={leaveCurrentRoom}
                onOpenCatalog={() => setActiveView("digital-humans")}
                groupChat={serverRoomId && port ? {
                  port,
                  roomId: serverRoomId,
                  serverRoom,
                  channelCode: activeModel?.channelCode,
                  approvalMode,
                  onFocusItem: (seq) => setFocusRequest({ seq, nonce: Date.now() }),
                  onOpenArtifact: openArtifactTab,
                } : undefined}
              />
            ) : activeDockTab === "info" ? (
              <InfoRail
                open
                onClose={() => setDockOpen(false)}
                servicePort={port}
                serviceReady={serviceReady}
                sessions={combinedSessions}
                activeProject={activeProject}
                activeBranch={activeProject ? projectBranches[activeProject.path] : undefined}
              />
            ) : activeDockTab.startsWith("artifact:") ? (
              <ArtifactPreview
                artifact={{ artifactId: activeDockTab.slice(9), title: artifactTabs.find((tab) => tab.id === activeDockTab.slice(9))?.label || activeDockTab.slice(9) }}
                room={serverRoom}
                onClose={() => closeArtifactTab(activeDockTab)}
                onOpenFile={openFileTab}
              />
            ) : activeDockTab.startsWith("file:") ? (
              <FilePreview
                path={activeDockTab.slice(5)}
                onClose={() => closeArtifactTab(activeDockTab)}
              />
            ) : null}
          </RightDock>
        ) : null}
      </main>
      </div>{/* /.app-body */}

      <AddDigitalHumanWizard
        open={wizardOpen}
        port={port}
        projectPath={wizardProjectPath || undefined}
        projectName={wizardProjectPath ? combinedProjects.find((project) => project.path === wizardProjectPath)?.name : undefined}
        onClose={() => {
          setWizardOpen(false);
          setWizardProjectPath("");
        }}
        onCreated={(human) => {
          setDigitalHumans((current) => [...current, human]);
          setSelectedHumanId(human.id);
          // 归属项目的创建完成后留在当前视图；全局创建回目录查看详情
          if (!wizardProjectPath) setActiveView("digital-humans");
        }}
      />
      <UpdatePrompt />
      <ParticipantPicker
        open={pickerOpen}
        humans={digitalHumans}
        room={room}
        onClose={() => setPickerOpen(false)}
        onJoin={joinCurrentRoom}
        onOpenCatalog={() => {
          setPickerOpen(false);
          setActiveView("digital-humans");
        }}
      />    </div>
  );
}
