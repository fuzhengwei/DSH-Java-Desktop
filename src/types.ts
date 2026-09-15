export type ServiceStatus = "stopped" | "running" | "starting" | "stopping";

export type ApprovalMode = "REQUEST_APPROVAL" | "AUTO_APPROVE" | "FULL_OPEN";

export type AgentServiceState = {
  status: string;
  port: number | null;
  jarPath: string | null;
  message: string;
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
  updatedAt?: string;
  createdAt?: string;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  local?: boolean;
};

export type ConversationMessage = {
  role: string;
  content: string;
  reasoning?: string;
  toolName?: string;
  callId?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  status?: string;
  durationMs?: number;
  createdAt?: string;
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
