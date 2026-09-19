import { invoke } from "@tauri-apps/api/core";
import { fetch as pluginFetch } from "@tauri-apps/plugin-http";
import { httpFetch } from "./http";
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
  // 原生 fetch 优先（服务端已开 CORS）；被 CORS 拦下或网络异常时自动回退
  // plugin-http（外部数字人 Runtime 等未开 CORS 的远端保持历史行为）。
  // 此前全量走 plugin-http，其 IPC 流转发有已知缺陷，偶发静默挂死，
  // 是房间协作"生成中"永久卡死（含 SSE、对账轮询同时失效）的直接推手。
  const response = await httpFetch(`${baseUrl(port)}${path}`, {
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

/** 探测远端 Agent Card：DSH 走 dsh-agent-card，A2A 走 agent.json */
export async function discoverDigitalHuman(
  port: number | null,
  remoteBaseUrl: string,
  endpointType: DigitalHumanEndpoint["type"] = "remote-dsh",
  credentialRef?: string,
): Promise<DiscoverResult> {
  const normalized = remoteBaseUrl.trim().replace(/\/+$/, "");
  if (!normalized) return { reachable: false, error: { kind: "network", message: "请填写服务地址" } };

  // 本地 Runtime 就绪时走服务端探测（统一鉴权与协议判断）
  if (port) {
    try {
      return await request<DiscoverResult>(port, "/api/digital-humans/discover", {
        method: "POST",
        body: JSON.stringify({ baseUrl: normalized, endpointType, credentialRef }),
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
    const cardPath = endpointType === "a2a" ? "/.well-known/agent.json" : "/.well-known/dsh-agent-card";
    // 远端 Agent Card 探测保持 plugin-http：目标端点不受我们控制、未必开 CORS，
    // 桌面进程直连不被 CORS 限制（见 request() 内注释了解为何本地服务不用这条通道）
    const response = await pluginFetch(`${normalized}${cardPath}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      connectTimeout: 8_000,
    } as RequestInit);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { reachable: false, latencyMs, error: classifyError(response.status, null) };
    }
    const card = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (endpointType === "a2a") {
      if (!card || (typeof card.name !== "string" && typeof card.description !== "string" && !Array.isArray(card.skills))) {
        return { reachable: false, latencyMs, error: { kind: "incompatible", message: "响应不是有效的 A2A Agent Card" } };
      }
      const skills = Array.isArray(card.skills) ? card.skills as Array<Record<string, unknown>> : [];
      const tags = skills.flatMap((skill) => [
        typeof skill.name === "string" ? skill.name : "",
        ...(Array.isArray(skill.tags) ? skill.tags.filter((tag): tag is string => typeof tag === "string") : []),
      ]).filter(Boolean);
      return {
        reachable: true,
        protocolVersion: typeof card.protocolVersion === "string" ? card.protocolVersion : "a2a.v1",
        latencyMs,
        suggested: {
          displayName: typeof card.name === "string" ? card.name : "A2A Agent",
          avatarRef: "🤝",
          purpose: typeof card.description === "string" ? card.description : "通过 A2A 协议接入的外部智能体",
          roleTags: [...new Set(tags)].slice(0, 8),
          approvalPolicy: "WRITE_REQUIRES_APPROVAL",
          maxConcurrentTasks: 1,
        },
      };
    }
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
  const result = await discoverDigitalHuman(port, human.endpoint.baseUrl, human.endpoint.type, human.endpoint.credentialRef);
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

/**
 * 为一次协作调度临时读取远端数字人的凭据。
 * 返回值只随本次 HTTP 请求发送给本地 Runtime，不写入 localStorage / 服务端数据库。
 */
export async function digitalHumanTokensFor(humans: DigitalHuman[]): Promise<Record<string, string>> {
  const entries = await Promise.all(humans.map(async (human) => {
    const credentialRef = human.endpoint.credentialRef;
    // 远端数字人（DSH 与 A2A）均按需携带凭据，供服务端网关转发时鉴权
    if ((human.endpoint.type !== "remote-dsh" && human.endpoint.type !== "a2a") || !credentialRef) return null;
    const token = await readCredential(credentialRef).catch(() => "");
    return token ? [human.id, token] as const : null;
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
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
  digitalHumanTokens?: Record<string, string>,
  /** 会话归属项目路径：数字人执行时的工作目录（直连路径同款语义） */
  cwd?: string,
  /** 用户授权的额外可写根：@ 引用工程目录 + 资源文件所在目录 */
  sandboxRoots?: string[],
): Promise<{ accepted: boolean; mode?: string }> {
  return collabRequest(port, `/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, mentions, channelCode, approvalMode, digitalHumanTokens, cwd, sandboxRoots }),
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
  digitalHumanTokens?: Record<string, string>,
): Promise<void> {
  await collabRequest(port, `/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: "POST",
    body: JSON.stringify({ roomId, channelCode, approvalMode, digitalHumanTokens }),
  });
}

export async function retryRoomTask(
  port: number,
  roomId: string,
  taskId: string,
  channelCode?: string,
  approvalMode?: string,
  digitalHumanTokens?: Record<string, string>,
): Promise<void> {
  await collabRequest(port, `/tasks/${encodeURIComponent(taskId)}/retry`, {
    method: "POST",
    body: JSON.stringify({ roomId, channelCode, approvalMode, digitalHumanTokens }),
  });
}

export async function reassignRoomTask(
  port: number,
  roomId: string,
  taskId: string,
  targetDigitalHumanId: string,
  channelCode?: string,
  approvalMode?: string,
  digitalHumanTokens?: Record<string, string>,
): Promise<void> {
  await collabRequest(port, `/tasks/${encodeURIComponent(taskId)}/reassign`, {
    method: "POST",
    body: JSON.stringify({ roomId, targetDigitalHumanId, channelCode, approvalMode, digitalHumanTokens }),
  });
}

/** 服务端房间事件单页上限（CollaborationService.EVENT_PAGE_SIZE），翻页时用于判断是否取满 */
const ROOM_EVENT_PAGE_SIZE = 500;
/** 房间事件最大翻页数：防御性上限（40 页 = 2 万条），避免异常情况下无限循环 */
const ROOM_EVENT_MAX_PAGES = 40;

/**
 * 拉取房间事件（自动翻页取满）。
 *
 * 服务端按 `seq > afterSeq ORDER BY seq ASC LIMIT 500` 返回单页，
 * 活跃协作房间很容易超过 500 条——只取一页会把后面成员的消息/交付物
 * 永远落在窗口外（表现为"多人协作最后只剩一个数字人的消息"）。
 * 这里循环翻页直到短页（不足一页即到头）。
 */
export async function fetchRoomEvents(port: number, roomId: string, afterSeq = 0): Promise<RoomEvent[]> {
  const all: RoomEvent[] = [];
  const seen = new Set<string>();
  let cursor = afterSeq;
  for (let page = 0; page < ROOM_EVENT_MAX_PAGES; page += 1) {
    const batch = await collabRequest<RoomEvent[]>(port, `/rooms/${encodeURIComponent(roomId)}/events?afterSeq=${cursor}`);
    for (const event of batch) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      all.push(event);
      cursor = Math.max(cursor, event.seq || 0);
    }
    if (batch.length < ROOM_EVENT_PAGE_SIZE) break;
  }
  return all;
}

/** 房间事件流空闲超时：房间流空闲是常态（服务端无心跳），只兜底 plugin-http 静默挂死，别设太小 */
const ROOM_STREAM_IDLE_MS = 600_000;

/**
 * 订阅房间统一事件流：补历史 + 实时推 + 断线自动重连，返回取消函数。
 *
 * 房间事件流是常驻连接，`running` 状态与消息渲染全靠它；此前连接一旦静默断掉
 * （Tauri plugin-http 已知缺陷，见 agent-client.ts 顶部注释），TASK_STATE_CHANGED
 * 永远收不到，UI 会永久"生成中"。因此这里做三层防护：
 * 1. 流正常结束 / 出错 → 指数退避自动重连，按最新 seq 续传（服务端订阅时会重放 backlog）；
 * 2. 长时间无字节（reader 挂死）→ 空闲看门狗强制断开走重连；
 * 3. 调用方（RoomCollaborationView）在任务运行期另有 REST 对账轮询兜底。
 *
 * @param afterSeq 初始 seq，也可传 getter（每次重连时取最新值，避免整段历史重放）
 */
export function subscribeRoomEvents(
  port: number,
  roomId: string,
  afterSeq: number | (() => number),
  onEvent: (event: RoomEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const controller = new AbortController();
  const getStartSeq = typeof afterSeq === "function" ? afterSeq : () => afterSeq;
  let disposed = false;

  void (async () => {
    let attempt = 0;
    while (!disposed && !controller.signal.aborted) {
      let idleTimer = 0;
      let idleReject: ((error: Error) => void) | null = null;
      const armIdleWatchdog = () => {
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => {
          idleReject?.(new Error("房间事件流空闲超时（连接可能已静默断开）"));
        }, ROOM_STREAM_IDLE_MS);
      };
      try {
        const startSeq = Math.max(0, getStartSeq());
        // 连接阶段加超时：plugin-http 偶发把 fetch 挂死（永不 resolve），
        // 不加超时会让重连循环永久停摆，空闲看门狗只在连接建立后才起作用
        const response = await Promise.race([
          httpFetch(
            `${baseUrl(port)}/api/collaboration/rooms/${encodeURIComponent(roomId)}/events/stream?afterSeq=${startSeq}`,
            { signal: controller.signal },
          ),
          new Promise<never>((_, reject) => window.setTimeout(
            () => reject(new Error("事件流连接超时（15s）")), 15_000,
          )),
        ]);
        if (!response.ok || !response.body) {
          throw new Error(`事件流连接失败：HTTP ${response.status}`);
        }
        attempt = 0;
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
        armIdleWatchdog();
        for (;;) {
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              idleReject = reject;
            }),
          ]);
          if (done) {
            if (dataLines.length > 0) dispatch();
            break;
          }
          armIdleWatchdog();
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
        // 服务端主动关流：视为断链，走重连
      } catch (caught) {
        window.clearTimeout(idleTimer);
        if (controller.signal.aborted || disposed) return;
        onError?.(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        window.clearTimeout(idleTimer);
      }
      if (disposed || controller.signal.aborted) return;
      // 指数退避重连：1s、2s、4s… 封顶 15s；连接成功过则重置
      const delay = Math.min(15_000, 1_000 * 2 ** attempt);
      attempt += 1;
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
  })();
  return () => {
    disposed = true;
    controller.abort();
  };
}
