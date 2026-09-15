import { fetch } from "@tauri-apps/plugin-http";
import type {
  ApiEnvelope,
  ConversationMessage,
  SessionSummary,
  ModelSetting,
  AvailableModel,
  ChannelPreset,
  RuntimeApproval,
  WorkspaceEntry,
} from "../types";

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function readHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl(port)}/api/harness/config/effective`);
    if (response.ok) {
      return true;
    }
  } catch {
  }

  try {
    await window.fetch(`${baseUrl(port)}/api/harness/config/effective`, {
      mode: "no-cors",
    });
    return true;
  } catch {
    return false;
  }
}

export async function waitForService(
  port: number,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await readHealth(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("智能体服务健康检查超时");
}

async function request<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl(port)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || payload?.code !== "00000") {
    throw new Error(payload?.info || `请求失败：HTTP ${response.status}`);
  }
  return payload.data as T;
}

export async function listSessions(
  port: number,
  limit = 30,
): Promise<SessionSummary[]> {
  return request<SessionSummary[]>(port, `/api/harness/console/sessions?limit=${limit}&offset=0`);
}

export async function listWorkspaces(port: number): Promise<WorkspaceEntry[]> {
  return request<WorkspaceEntry[]>(port, "/api/agent/workspaces");
}

export async function createWorkspace(port: number, name: string): Promise<WorkspaceEntry[]> {
  return request<WorkspaceEntry[]>(port, "/api/agent/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function listMessages(
  port: number,
  sessionId: string,
): Promise<ConversationMessage[]> {
  return request<ConversationMessage[]>(
    port,
    `/api/harness/console/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

export async function listRuntimeApprovals(port: number): Promise<RuntimeApproval[]> {
  return request<RuntimeApproval[]>(port, "/api/harness/approvals/runtime/pending");
}

export async function resolveRuntimeApproval(
  port: number,
  approvalId: string,
  verdict: "ALLOW_ONCE" | "ALLOW_SESSION" | "DENY" | "CANCEL",
): Promise<void> {
  await request(port, `/api/harness/approvals/runtime/${encodeURIComponent(approvalId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ verdict }),
  });
}

export async function listModelSettings(port: number): Promise<ModelSetting[]> {
  return request<ModelSetting[]>(port, "/api/harness/settings/models");
}

export async function listAvailableModels(port: number): Promise<AvailableModel[]> {
  return request<AvailableModel[]>(port, "/api/harness/runtime/models");
}

export async function listChannelPresets(port: number): Promise<ChannelPreset[]> {
  return request<ChannelPreset[]>(port, "/api/harness/channels/presets");
}

export async function discoverModels(
  port: number,
  body: { baseUrl: string; apiKeyRef: string; protocol: string },
): Promise<string[]> {
  const result = await request<string[] | { models?: string[] }>(port, "/api/harness/settings/models/discover", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (Array.isArray(result)) return result;
  return result?.models || [];
}

export async function saveModelSetting(port: number, body: ModelSetting): Promise<ModelSetting> {
  return request<ModelSetting>(port, "/api/harness/settings/models", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function activateModelSetting(port: number, channelCode: string): Promise<ModelSetting> {
  return request<ModelSetting>(port, "/api/harness/settings/models/active", {
    method: "POST",
    body: JSON.stringify({ channelCode }),
  });
}

export async function deleteModelSetting(port: number, channelCode: string): Promise<void> {
  await request(port, `/api/harness/settings/models/${encodeURIComponent(channelCode)}`, {
    method: "DELETE",
  });
}

export type StreamEvent =
  | { type: "meta"; payload: unknown }
  | { type: "chunk"; payload: unknown }
  | { type: "reasoning"; payload: unknown }
  | { type: "finish"; payload: unknown }
  | { type: "done"; payload: unknown }
  | { type: "tool_result"; payload: unknown }
  | { type: "step_break"; payload: unknown }
  | { type: "error"; payload: unknown };

export async function streamAgentMessage(
  port: number,
  body: {
    agentId: string;
    message: string;
    channelCode?: string;
    approvalMode?: string;
    cwd?: string;
  },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${baseUrl(port)}/api/agent/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`连接智能体流失败：HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        try {
          const payload = raw ? JSON.parse(raw) : {};
          onEvent({
            type: (eventName || "chunk") as StreamEvent["type"],
            payload,
          });
        } catch {
          onEvent({ type: "chunk", payload: { text: raw } });
        }
      }
    }
  }
}
