import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import type {
  ApiEnvelope,
  DigitalHuman,
  DigitalHumanEndpoint,
  DigitalHumanHealth,
  DiscoverResult,
  RoomProjection,
} from "../types";

/**
 * 数字人数据层。
 *
 * 双通道策略：
 * 1. 优先调本地 Runtime 的 /api/digital-humans/**（JAR 实现后即成为事实源）；
 * 2. 接口 404 / 服务不可用时自动降级到 localStorage 持久化，
 *    接口形状保持一致，JAR 就绪后无需改 UI。
 *
 * 远端健康检查通过 Tauri plugin-http 直连（桌面进程不受 CORS 限制），
 * 凭据读写走 Tauri 安全存储命令，前端永不落明文。
 */

const STORE_KEY = "dsh-digital-humans";
const ROOM_STORE_KEY = "dsh-rooms";
/** 数字人 → 项目 归属映射（本地投影）：{ digitalHumanId: projectPath }，空串表示全局 */
const PROJECT_BIND_KEY = "dsh-digital-human-projects";

// ── 本地持久化（降级通道） ─────────────────────

function readLocal(): DigitalHuman[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((item): item is DigitalHuman => Boolean(item && item.id)) : [];
  } catch {
    return [];
  }
}

function writeLocal(humans: DigitalHuman[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(humans));
  } catch {
    // 存储失败不阻断主流程
  }
}

function readLocalRooms(): Record<string, RoomProjection> {
  try {
    const raw = JSON.parse(localStorage.getItem(ROOM_STORE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw as Record<string, RoomProjection> : {};
  } catch {
    return {};
  }
}

function writeLocalRooms(rooms: Record<string, RoomProjection>) {
  try {
    localStorage.setItem(ROOM_STORE_KEY, JSON.stringify(rooms));
  } catch {
    // 忽略
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── 数字人 ↔ 项目 归属（本地投影） ──────────────

function readProjectBindings(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECT_BIND_KEY) || "{}");
    return raw && typeof raw === "object" ? raw as Record<string, string> : {};
  } catch {
    return {};
  }
}

function writeProjectBindings(bindings: Record<string, string>) {
  try {
    localStorage.setItem(PROJECT_BIND_KEY, JSON.stringify(bindings));
  } catch {
    // 忽略
  }
}

/** 把本地归属映射叠加到数字人列表上（服务端列表与本地降级列表都适用） */
function applyProjectBindings(humans: DigitalHuman[]): DigitalHuman[] {
  const bindings = readProjectBindings();
  return humans.map((human) => ({
    ...human,
    projectPath: bindings[human.id] || undefined,
  }));
}

/** 设置数字人的项目归属；传空串表示改回全局 */
export function assignDigitalHumanToProject(id: string, projectPath: string): void {
  const bindings = readProjectBindings();
  if (projectPath) bindings[id] = projectPath;
  else delete bindings[id];
  writeProjectBindings(bindings);
  // 本地降级通道里的副本也同步一份，避免刷新后错位
  const humans = readLocal();
  if (humans.some((human) => human.id === id)) {
    writeLocal(humans.map((human) => (
      human.id === id ? { ...human, projectPath: projectPath || undefined } : human
    )));
  }
}

// ── Runtime 通道探测 ──────────────────────────

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function request<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl(port)}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 404) throw new RuntimeUnavailableError();
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || payload?.code !== "00000") {
    throw new Error(payload?.info || `请求失败：HTTP ${response.status}`);
  }
  return payload.data as T;
}

class RuntimeUnavailableError extends Error {
  constructor() { super("runtime-unavailable"); }
}

function isRuntimeUnavailable(error: unknown): boolean {
  return error instanceof RuntimeUnavailableError
    || (error instanceof Error && /fetch|network|连接|unavailable/i.test(error.message));
}

// ── 目录 CRUD ─────────────────────────────────

export async function listDigitalHumans(port: number | null): Promise<DigitalHuman[]> {
  if (port) {
    try {
      const remote = await request<DigitalHuman[]>(port, "/api/digital-humans");
      return applyProjectBindings(remote);
    } catch (error) {
      if (!isRuntimeUnavailable(error)) throw error;
    }
  }
  return applyProjectBindings(readLocal());
}

export type DigitalHumanDraft = {
  displayName: string;
  avatarRef: string;
  purpose: string;
  roleTags: string[];
  themeColor: string;
  approvalPolicy: DigitalHuman["approvalPolicy"];
  concurrencyLimit: number;
  endpoint: DigitalHumanEndpoint;
};

export async function createDigitalHuman(port: number | null, draft: DigitalHumanDraft): Promise<DigitalHuman> {
  if (port) {
    try {
      return await request<DigitalHuman>(port, "/api/digital-humans", {
        method: "POST",
        body: JSON.stringify(draft),
      });
    } catch (error) {
      if (!isRuntimeUnavailable(error)) throw error;
    }
  }
  const human: DigitalHuman = {
    ...draft,
    id: newId("dh"),
    createdAt: new Date().toISOString(),
  };
  writeLocal([...readLocal(), human]);
  return human;
}

export async function updateDigitalHuman(
  port: number | null,
  id: string,
  patch: Partial<DigitalHumanDraft>,
): Promise<DigitalHuman> {
  if (port) {
    try {
      return await request<DigitalHuman>(port, `/api/digital-humans/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
    } catch (error) {
      if (!isRuntimeUnavailable(error)) throw error;
    }
  }
  const humans = readLocal();
  const index = humans.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("数字人不存在");
  humans[index] = { ...humans[index], ...patch };
  writeLocal(humans);
  return humans[index];
}

export async function deleteDigitalHuman(port: number | null, id: string): Promise<void> {
  if (port) {
    try {
      await request(port, `/api/digital-humans/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    } catch (error) {
      if (!isRuntimeUnavailable(error)) throw error;
    }
  }
  writeLocal(readLocal().filter((item) => item.id !== id));
  // 同步清理项目归属映射，避免悬空绑定
  const bindings = readProjectBindings();
  if (id in bindings) {
    delete bindings[id];
    writeProjectBindings(bindings);
  }
}

// ── 远端探测与健康检查 ─────────────────────────

function classifyError(status: number, error: unknown): DiscoverResult["error"] {
  if (status === 401 || status === 403) return { kind: "unauthorized", message: "凭据无效或权限不足" };
  if (status === 404) return { kind: "not-found", message: "该服务未暴露 DSH 能力卡（可能不是 deepseek-harness-java）" };
  const message = error instanceof Error ? error.message : String(error);
  if (/certificate|tls|ssl/i.test(message)) return { kind: "tls", message: "TLS 证书校验失败" };
  if (/dns|resolve|name/i.test(message)) return { kind: "dns", message: "域名解析失败" };
  return { kind: "network", message: message || "网络不可达" };
}

/** 探测远端 Agent Card：GET {baseUrl}/.well-known/dsh-agent-card */
export async function discoverDigitalHuman(
  port: number | null,
  remoteBaseUrl: string,
  credentialRef?: string,
): Promise<DiscoverResult> {
  const normalized = remoteBaseUrl.trim().replace(/\/+$/, "");
  if (!normalized) return { reachable: false, error: { kind: "network", message: "请填写服务地址" } };

  // 本地 Runtime 就绪时走服务端探测（统一鉴权与协议判断）
  if (port) {
    try {
      return await request<DiscoverResult>(port, "/api/digital-humans/discover", {
        method: "POST",
        body: JSON.stringify({ baseUrl: normalized, credentialRef }),
      });
    } catch (error) {
      if (!isRuntimeUnavailable(error)) throw error;
    }
  }

  // 降级：桌面进程直连探测
  let token = "";
  if (credentialRef) {
    token = await readCredential(credentialRef).catch(() => "") || "";
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(`${normalized}/.well-known/dsh-agent-card`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      connectTimeout: 8_000,
    } as RequestInit);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { reachable: false, latencyMs, error: classifyError(response.status, null) };
    }
    const card = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!card || typeof card.protocol !== "string") {
      return { reachable: false, latencyMs, error: { kind: "incompatible", message: "响应不是有效的 DSH Agent Card" } };
    }
    return {
      reachable: true,
      protocolVersion: card.protocol,
      latencyMs,
      suggested: {
        displayName: typeof card.displayName === "string" ? card.displayName : undefined,
        avatarRef: typeof card.avatarUrl === "string" ? card.avatarUrl : undefined,
        purpose: typeof card.purpose === "string" ? card.purpose : undefined,
        roleTags: Array.isArray(card.roleTags) ? card.roleTags.filter((t): t is string => typeof t === "string") : undefined,
        approvalPolicy: card.approvalPolicy === "AUTO_ALLOW" || card.approvalPolicy === "ALWAYS_CONFIRM"
          ? card.approvalPolicy : "WRITE_REQUIRES_APPROVAL",
        maxConcurrentTasks: typeof card.maxConcurrentTasks === "number" ? card.maxConcurrentTasks : undefined,
      },
    };
  } catch (error) {
    return { reachable: false, latencyMs: Date.now() - startedAt, error: classifyError(0, error) };
  }
}

/** 健康检查：远端探测 Agent Card；本地数字人看 Runtime 是否就绪 */
export async function healthCheck(
  port: number | null,
  human: DigitalHuman,
): Promise<{ healthState: DigitalHumanHealth; latencyMs?: number }> {
  if (human.endpoint.type === "local-dsh") {
    return { healthState: port ? "online" : "offline" };
  }
  if (!human.endpoint.baseUrl) return { healthState: "unknown" };
  const result = await discoverDigitalHuman(port, human.endpoint.baseUrl, human.endpoint.credentialRef);
  if (result.reachable) return { healthState: "online", latencyMs: result.latencyMs };
  return {
    healthState: result.error?.kind === "unauthorized" ? "unauthorized" : "offline",
    latencyMs: result.latencyMs,
  };
}

// ── 凭据（Tauri 安全存储） ─────────────────────

export async function saveCredential(credentialRef: string, secret: string): Promise<void> {
  await invoke("save_credential", { credentialRef, secret });
}

export async function readCredential(credentialRef: string): Promise<string | null> {
  return invoke<string | null>("read_credential", { credentialRef });
}

export async function deleteCredential(credentialRef: string): Promise<void> {
  await invoke("delete_credential", { credentialRef });
}

// ── 房间投影（会话 ↔ 数字人） ──────────────────

export function readRoom(roomId: string): RoomProjection | null {
  return readLocalRooms()[roomId] || null;
}

export function writeRoom(room: RoomProjection): void {
  const rooms = readLocalRooms();
  rooms[room.roomId] = room;
  writeLocalRooms(rooms);
}

/** 发送消息时，把首条消息摘要写为房间目标（协作面板「当前目标」） */
export function ensureRoomObjective(roomId: string, objective: string): void {
  const existing = readLocalRooms()[roomId];
  if (!existing) return;
  if (existing.objective) return;
  existing.objective = objective;
  writeRoom(existing);
}

export function joinRoom(roomId: string, human: DigitalHuman): RoomProjection {
  const rooms = readLocalRooms();
  const existing = rooms[roomId] || { roomId, participants: [] };
  // 幂等：重复加入返回已有参与者
  if (!existing.participants.some((p) => p.digitalHumanId === human.id)) {
    existing.participants = [
      ...existing.participants,
      { digitalHumanId: human.id, presence: "idle", joinedAt: new Date().toISOString() },
    ];
  }
  rooms[roomId] = existing;
  writeLocalRooms(rooms);
  return existing;
}

export function leaveRoom(roomId: string, digitalHumanId: string): RoomProjection | null {
  const rooms = readLocalRooms();
  const existing = rooms[roomId];
  if (!existing) return null;
  existing.participants = existing.participants.filter((p) => p.digitalHumanId !== digitalHumanId);
  rooms[roomId] = existing;
  writeLocalRooms(rooms);
  return existing;
}

export function updatePresence(
  roomId: string,
  digitalHumanId: string,
  presence: RoomProjection["participants"][number]["presence"],
  activeTaskLabel?: string,
): void {
  const rooms = readLocalRooms();
  const existing = rooms[roomId];
  if (!existing) return;
  existing.participants = existing.participants.map((p) => (
    p.digitalHumanId === digitalHumanId ? { ...p, presence, activeTaskLabel } : p
  ));
  writeLocalRooms(rooms);
}

// ══════════════ 服务端协作房间（JAR 已就绪后为事实源） ══════════════

/** 服务端房间视图（含参与者/任务/产物） */
export type ServerRoomView = {
  id: string;
  workspaceId?: string;
  title?: string;
  objective?: string;
  orchestrationMode?: string;
  runState?: string;
  participants?: Array<{
    participantId: string;
    digitalHumanId: string;
    presence: string;
    activeTaskLabel?: string;
    displayName?: string;
    avatarRef?: string;
    themeColor?: string;
  }>;
  tasks?: Array<{
    taskId: string;
    title: string;
    state: string;
    assignedTo?: string;
    assigneeName?: string;
    assigneeAvatar?: string;
    assigneeColor?: string;
    dependsOn?: string[];
  }>;
  artifacts?: Array<{
    artifactId: string;
    title: string;
    kind: string;
    version: number;
    content?: string;
    filePath?: string;
    mimeType?: string;
    previewMarkdown?: string;
    summary?: string;
    echartsOption?: unknown;
    producerName?: string;
    producerColor?: string;
    createdAt?: string;
  }>;
};

/** 统一房间事件（与服务端 eventView 对齐） */
export type RoomEvent = {
  id: string;
  roomId: string;
  seq: number;
  taskId?: string;
  digitalHumanId?: string;
  type: string;
  occurredAt?: string;
  payload: Record<string, unknown>;
  displayName?: string;
  avatarRef?: string;
  themeColor?: string;
};

/** 会话 ID -> 服务端房间 ID 的绑定（本地存，房间本身是服务端事实源） */
const ROOM_BIND_KEY = "dsh-session-room-bind";

function readBindings(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ROOM_BIND_KEY) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function boundRoomId(sessionId: string): string | null {
  return readBindings()[sessionId] || null;
}

function bindRoom(sessionId: string, roomId: string) {
  const bindings = readBindings();
  bindings[sessionId] = roomId;
  try {
    localStorage.setItem(ROOM_BIND_KEY, JSON.stringify(bindings));
  } catch { /* 忽略 */ }
}

async function collabRequest<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  return request<T>(port, `/api/collaboration${path}`, init);
}

/** 确保会话有对应的服务端房间：已绑定则复用，否则创建 */
export async function ensureServerRoom(
  port: number,
  sessionId: string,
  title: string,
  workspaceId = "default",
): Promise<ServerRoomView> {
  const bound = boundRoomId(sessionId);
  if (bound) {
    try {
      return await collabRequest<ServerRoomView>(port, `/rooms/${encodeURIComponent(bound)}`);
    } catch {
      // 绑定失效（服务端重启清库）则重建
    }
  }
  const room = await collabRequest<ServerRoomView>(port, "/rooms", {
    method: "POST",
    body: JSON.stringify({ workspaceId: workspaceId || "default", title: title || "协作对话", orchestrationMode: "MANUAL" }),
  });
  bindRoom(sessionId, room.id);
  return room;
}

export async function fetchServerRoom(port: number, roomId: string): Promise<ServerRoomView> {
  return collabRequest<ServerRoomView>(port, `/rooms/${encodeURIComponent(roomId)}`);
}

export async function joinServerRoom(port: number, roomId: string, digitalHumanId: string): Promise<ServerRoomView> {
  return collabRequest<ServerRoomView>(port, `/rooms/${encodeURIComponent(roomId)}/participants`, {
    method: "POST",
    body: JSON.stringify({ digitalHumanId }),
  });
}

export async function leaveServerRoom(port: number, roomId: string, digitalHumanId: string): Promise<ServerRoomView> {
  return collabRequest<ServerRoomView>(
    port,
    `/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(digitalHumanId)}`,
    { method: "DELETE" },
  );
}

export async function postRoomMessage(
  port: number,
  roomId: string,
  content: string,
  mentions: string[],
  channelCode?: string,
  approvalMode?: string,
): Promise<{ accepted: boolean; mode?: string }> {
  return collabRequest(port, `/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, mentions, channelCode, approvalMode }),
  });
}

export async function cancelRoomTask(port: number, roomId: string, taskId: string): Promise<void> {
  await collabRequest(port, `/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ roomId }),
  });
}

export async function resumeRoomTask(
  port: number,
  roomId: string,
  taskId: string,
  channelCode?: string,
  approvalMode?: string,
): Promise<void> {
  await collabRequest(port, `/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: "POST",
    body: JSON.stringify({ roomId, channelCode, approvalMode }),
  });
}

export async function fetchRoomEvents(port: number, roomId: string, afterSeq = 0): Promise<RoomEvent[]> {
  return collabRequest<RoomEvent[]>(port, `/rooms/${encodeURIComponent(roomId)}/events?afterSeq=${afterSeq}`);
}

/** 订阅房间统一事件流：补历史 + 实时推，返回取消函数 */
export function subscribeRoomEvents(
  port: number,
  roomId: string,
  afterSeq: number,
  onEvent: (event: RoomEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(
        `${baseUrl(port)}/api/collaboration/rooms/${encodeURIComponent(roomId)}/events/stream?afterSeq=${afterSeq}`,
        { signal: controller.signal },
      );
      if (!response.ok || !response.body) {
        throw new Error(`事件流连接失败：HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let dataLines: string[] = [];
      const dispatch = () => {
        if (dataLines.length === 0) return;
        const raw = dataLines.join("\n").trim();
        dataLines = [];
        if (!raw) return;
        try {
          onEvent(JSON.parse(raw) as RoomEvent);
        } catch {
          // 单条事件解析失败不中断流
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (dataLines.length > 0) dispatch();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            // 事件名本实现不区分（统一 room-event），仅消费掉该行
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          } else if (line.trim() === "") {
            dispatch();
          }
        }
      }
    } catch (caught) {
      if (!controller.signal.aborted && onError) {
        onError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    }
  })();
  return () => controller.abort();
}
