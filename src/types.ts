export type ServiceStatus = "stopped" | "running" | "starting" | "stopping";

export type ApprovalMode =
  | "REQUEST_APPROVAL"
  | "AUTO_APPROVE"
  | "FULL_OPEN";

export type ReasoningEffort = "low" | "medium" | "high";

export type AgentServiceState = {
  status: string;
  port: number | null;
  jarPath: string | null;
  message: string;
  runtimeStatus: "unknown" | "missing" | "too_old" | "invalid" | "ready";
  runtimeSource: "bundled" | "system" | "custom" | null;
  javaPath: string | null;
  javaVersion: string | null;
};

export type ApiEnvelope<T> = {
  code?: string;
  info?: string;
  data?: T;
};

export type SessionSummary = {
  agentId?: string;
  sessionId?: string;
  title?: string;
  lastMessage?: string;
  modelCode?: string;
  updatedAt?: string;
  createdAt?: string;
  workspaceId?: string;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  local?: boolean;
  parentPath?: string;
};

export type ResourcePluginKind = "word" | "excel" | "md" | "echart" | "drawio";

export type ComposerResource = {
  id: string;
  kind: "folder" | "file" | "project" | "plugin";
  name: string;
  path?: string;
  pluginKind?: ResourcePluginKind;
  mimeType?: string;
  dataUrl?: string;
  /** 文档类附件（如 .docx）在前端提取的纯文本，随隐藏上下文注入对话 */
  textContent?: string;
};

export type ConversationMessage = {
  role: string;
  content: string;
  reasoning?: string;
  /** 用户消息中 @ 提及的工程（本地缓存与展示用） */
  mentions?: WorkspaceEntry[];
  /** 用户消息中通过 + 添加的资源（本地缓存与展示用） */
  resources?: ComposerResource[];
  toolName?: string;
  callId?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  status?: string;
  durationMs?: number;
  createdAt?: string;
  /** 数字人归属：assistant/tool 消息由哪个数字人产生（多数字人房间展示用） */
  attribution?: MessageAttribution;
};

export type AgentActivity = {
  id: string;
  label: string;
  detail?: string;
  state: "running" | "done" | "error";
};

export type PendingApproval = {
  approvalId?: string;
  sessionId?: string;
  toolName?: string;
  reason?: string;
  status?: string;
};

export type RuntimeApproval = {
  approvalId: string;
  sessionId?: string;
  toolName?: string;
  displayCommand?: string;
  arguments?: Record<string, unknown>;
  createdAt?: string;
};

export type ModelSetting = {
  channelCode?: string;
  displayName?: string;
  providerCode?: string;
  modelCode?: string;
  baseUrl?: string;
  apiKeyRef?: string;
  protocol?: string;
  enabled?: boolean;
  active?: boolean;
  updatedAt?: string;
};

export type AvailableModel = {
  channelCode?: string;
  displayName?: string;
  providerCode?: string;
  modelCode?: string;
};

export type ChannelPreset = {
  id: string;
  displayName?: string;
  protocol?: string;
  baseUrl?: string;
  authScheme?: string;
  modelSuggestions?: string[];
  regionGroup?: string;
};

export type PluginStatus =
  | "REGISTERED"
  | "ACTIVE"
  | "FAILED"
  | "DISABLED"
  | "UNINSTALLED";

export type HarnessPlugin = {
  pluginId: string;
  displayName?: string;
  pluginVersion?: string;
  runtimeType?: string;
  installMode?: string;
  sourcePath?: string;
  entrypoint?: string;
  status?: PluginStatus;
  installedAt?: string;
};

export type PluginCandidate = {
  valid?: boolean;
  pluginId?: string;
  displayName?: string;
  pluginVersion?: string;
  runtimeType?: string;
  sourcePath?: string;
  entrypoint?: string;
  artifactId?: string;
  author?: string;
  description?: string;
  message?: string;
};

export type PluginConfigItem = {
  key?: string;
  value?: string;
};

export type ModelDraft = {
  channelCode?: string;
  displayName: string;
  providerCode: string;
  modelCode: string;
  baseUrl: string;
  apiKeyRef: string;
  protocol: string;
  enabled: boolean;
};

// ── 数字人协作 ───────────────────────────────

/** 数字人健康/在场状态 */
export type DigitalHumanHealth = "online" | "offline" | "unauthorized" | "degraded" | "unknown";

/** 数字人在房间中的在场状态 */
export type ParticipantPresence =
  | "idle" | "thinking" | "working" | "waiting_input"
  | "waiting_approval" | "blocked" | "done" | "error";

export type DigitalHumanEndpointType = "local-dsh" | "remote-dsh" | "a2a";

export type DigitalHumanEndpoint = {
  type: DigitalHumanEndpointType;
  baseUrl?: string;
  /** 凭据引用，指向 Tauri 安全存储，绝不存明文 */
  credentialRef?: string;
  protocolVersion?: string;
  healthState?: DigitalHumanHealth;
  lastCheckedAt?: string;
  latencyMs?: number;
};

export type DigitalHuman = {
  id: string;
  displayName: string;
  /** emoji 字符或本地资源引用 */
  avatarRef: string;
  /** 用途描述：给用户看，也给 Planner 当能力摘要 */
  purpose: string;
  roleTags: string[];
  /** 头像环/任务条主题色 */
  themeColor: string;
  approvalPolicy: "AUTO_ALLOW" | "WRITE_REQUIRES_APPROVAL" | "ALWAYS_CONFIRM";
  concurrencyLimit: number;
  endpoint: DigitalHumanEndpoint;
  createdAt: string;
  /**
   * 归属项目路径：有值表示该数字人挂在某个项目下（侧边栏项目行会展示其头像与数量）；
   * 缺省为全局数字人，所有项目都可用。纯前端归属，服务端未知晓此字段也无影响。
   */
  projectPath?: string;
};

/** 远端 Agent Card 探测结果 */
export type DiscoverResult = {
  reachable: boolean;
  protocolVersion?: string;
  latencyMs?: number;
  suggested?: {
    displayName?: string;
    avatarRef?: string;
    purpose?: string;
    roleTags?: string[];
    approvalPolicy?: DigitalHuman["approvalPolicy"];
    maxConcurrentTasks?: number;
  };
  error?: {
    kind: "dns" | "tls" | "unauthorized" | "not-found" | "incompatible" | "network";
    message: string;
  };
};

/** 协作房间参与者（挂在会话上的轻量投影） */
export type RoomParticipant = {
  digitalHumanId: string;
  presence: ParticipantPresence;
  /** 当前任务简述，如 "#T-12 收集服务日志" */
  activeTaskLabel?: string;
  joinedAt: string;
};

/** 会话 ↔ 数字人房间的关联（本地投影，房间事实源后续在 JAR） */
export type RoomProjection = {
  /** 复用 sessionId 作为房间标识 */
  roomId: string;
  objective?: string;
  participants: RoomParticipant[];
};

/** 消息归属：标注该条消息由哪个数字人产生 */
export type MessageAttribution = {
  digitalHumanId: string;
  displayName: string;
  avatarRef: string;
  themeColor: string;
  taskLabel?: string;
};
