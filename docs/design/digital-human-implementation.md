# DSH 数字人协作 — 实现设计文档

> 配套文档：`docs/architecture/digital-human-agent-architecture.md`（总体架构，方向不变）。
> 本文档回答「具体怎么落地」：表怎么建、API 长什么样、前后端各改哪里、按什么顺序做。

## 0. 核心决策速览

| 决策点 | 结论 |
| --- | --- |
| 数字人是什么 | 「身份（名称/头像/用途/能力/权限）」与「Runtime 连接（Base URL/凭据）」的绑定，二者解耦存储 |
| 协作协议 | DSH v1：`/.well-known/dsh-agent-card` 能力发现 + 既有 `/api/agent/stream` 任务执行 + SSE 事件归一化。**不直接实现 A2A**，结构向其对齐，阶段 5 做映射 |
| 控制面位置 | 本地 DSH Runtime（JAR）内新增数字人模块，前端不直连远端（CORS / Token 暴露 / 事件统一都难做） |
| 协作主控 | 房间（Room）+ 任务（Task）+ 统一 RoomEvent 事件日志。聊天是事件的投影，不是事实源。**拒绝自由群聊主控** |
| 并发模型 | 每数字人有并发上限；无依赖任务可并行；危险操作走审批 |
| 存储 | 本地 standalone H2 新增 8 张表；凭据走 Tauri 安全存储，业务表只存引用 |
| 第一阶段范围 | 目录 + 远端接入 + `@` 派单 + 多角色消息流 + 审批归属。Planner 自动分工放阶段 3 |

## 1. 模块划分与改动清单

### 1.1 本地 DSH Runtime（`deepseek-harness-java` JAR，改动最大）

新增包 `digitalhuman`：

```text
digitalhuman/
├─ domain/            DigitalHuman, Room, Participant, CollabTask, Artifact, RoomEvent
├─ store/             H2 表访问（jOOQ/MyBatis，沿用现有持久层风格）
├─ directory/         目录 CRUD + Agent Card 探测 + 健康检查调度
├─ gateway/           RemoteAgentGateway：远端 HTTP/SSE 客户端、事件归一化、断线重连
├─ room/              RoomService：参与者管理、消息命令、事件追加、投影查询
├─ orchestrator/      Orchestrator：计划生成、任务分派、依赖调度、交接处理、超时/取消
└─ api/               Controller：/api/digital-humans/** 与 /api/collaboration/**
```

**关键复用**：任务执行直接复用远端（或本地）既有 `/api/agent/stream`；审批复用 `/api/harness/approvals/runtime`；持久层与 SSE 基础设施沿用现有实现，不重造轮子。

### 1.2 桌面前端（`src/`，本仓库）

| 新增/修改 | 内容 |
| --- | --- |
| `src/lib/digital-human-client.ts` | 数字人目录 / 房间 / 事件流 API 客户端（新增） |
| `src/lib/agent-client.ts` | 不改远端调用，仅类型对齐 |
| `src/types.ts` | 新增 `DigitalHuman`、`RoomEvent`、`CollabTask`、`Participant` 等类型 |
| `src/components/DigitalHumanCatalog.tsx` | 数字人目录页（列表 + 详情双栏） |
| `src/components/AddDigitalHumanWizard.tsx` | 添加向导（来源 → 连接 → 身份 → 权限 → 确认） |
| `src/components/ConversationView.tsx` | 改造：多角色消息流、成员栏、工具卡归属、审批条归属 |
| `src/components/CollabPanel.tsx` | 右侧协作面板：目标/参与者/任务/产物/审批 |
| `src/components/ParticipantChip.tsx` | 头像 chip、状态点、成员详情 Popover |
| `src/components/Sidebar.tsx` | 左侧导航新增「数字人」入口 |
| `src/App.tsx` | 路由：conversation / catalog / settings；RoomEvent SSE 订阅与状态投影 |

### 1.3 Tauri 壳（`src-tauri/`）

| 改动 | 内容 |
| --- | --- |
| 凭据存储 | 远端 Token 用 `tauri-plugin-store` 或 keyring 存安全区；业务表只存 `credentialRef` |
| 命令 | 新增 `save_credential(ref, secret)` / `read_credential(ref)` / `delete_credential(ref)` |
| 其余 | 进程托管、端口选择不变 |

## 2. 数据表设计（H2，standalone）

统一主键策略：`varchar(40)` 存 `dh_xxx` / `room_xxx` / `task_xxx` / `evt_xxx` / `art_xxx` 前缀 ULID。

```sql
-- 2.1 数字人身份（展示与策略，与连接解耦）
CREATE TABLE digital_human (
  id                VARCHAR(40) PRIMARY KEY,
  display_name      VARCHAR(64)  NOT NULL,
  avatar_ref        VARCHAR(255),                -- 本地缓存路径或 emoji
  purpose           VARCHAR(512) NOT NULL,       -- 用途描述：给用户看 + 给 Planner 当能力摘要
  role_tags         VARCHAR(255),                -- 逗号分隔：server-ops,copywriting
  theme_color       VARCHAR(16),                 -- 头像环/任务条主题色
  tool_policy       CLOB,                        -- JSON: 可用工具白名单/黑名单
  approval_policy   VARCHAR(32)  NOT NULL DEFAULT 'WRITE_REQUIRES_APPROVAL',
  concurrency_limit INT          NOT NULL DEFAULT 1,
  created_at        TIMESTAMP    NOT NULL,
  updated_at        TIMESTAMP    NOT NULL
);

-- 2.2 服务端点（连接配置，一个数字人一个端点）
CREATE TABLE digital_human_endpoint (
  id                VARCHAR(40) PRIMARY KEY,
  digital_human_id  VARCHAR(40)  NOT NULL REFERENCES digital_human(id),
  endpoint_type     VARCHAR(24)  NOT NULL,       -- local-dsh / remote-dsh / mcp-tool / a2a(预留)
  base_url          VARCHAR(255),                -- local 可为空
  credential_ref    VARCHAR(64),                 -- 指向 Tauri 安全存储，不存明文
  protocol_version  VARCHAR(16),
  agent_card        CLOB,                        -- 探测到的 Agent Card JSON 快照
  health_state      VARCHAR(16)  NOT NULL DEFAULT 'unknown', -- online/offline/unauthorized/degraded
  last_checked_at   TIMESTAMP,
  UNIQUE (base_url, digital_human_id)
);

-- 2.3 协作房间
CREATE TABLE collaboration_room (
  id                VARCHAR(40) PRIMARY KEY,
  workspace_id      VARCHAR(64)  NOT NULL,
  title             VARCHAR(128) NOT NULL,
  objective         CLOB,
  orchestration_mode VARCHAR(24) NOT NULL DEFAULT 'MANUAL', -- MANUAL / AUTO_PLAN / STEP
  run_state         VARCHAR(16)  NOT NULL DEFAULT 'idle',   -- idle/running/paused/done/error
  created_at        TIMESTAMP    NOT NULL
);

-- 2.4 房间参与者
CREATE TABLE room_participant (
  id                VARCHAR(40) PRIMARY KEY,
  room_id           VARCHAR(40)  NOT NULL REFERENCES collaboration_room(id),
  digital_human_id  VARCHAR(40)  NOT NULL REFERENCES digital_human(id),
  room_role         VARCHAR(16)  NOT NULL DEFAULT 'member',  -- member/planner/reviewer/observer
  presence          VARCHAR(20)  NOT NULL DEFAULT 'idle',    -- idle/thinking/working/waiting_input/waiting_approval/blocked/done/error
  joined_at         TIMESTAMP    NOT NULL,
  UNIQUE (room_id, digital_human_id)
);

-- 2.5 协作任务（DAG 节点）
CREATE TABLE collaboration_task (
  id                VARCHAR(40) PRIMARY KEY,
  room_id           VARCHAR(40)  NOT NULL,
  parent_task_id    VARCHAR(40),
  title             VARCHAR(128) NOT NULL,
  instruction       CLOB         NOT NULL,
  assigned_to       VARCHAR(40),               -- room_participant.id
  requested_by      VARCHAR(24)  NOT NULL,     -- user / digitalHuman:{id} / orchestrator
  state             VARCHAR(20)  NOT NULL DEFAULT 'READY',
  -- READY/ASSIGNED/RUNNING/WAITING_INPUT/WAITING_APPROVAL/REVIEWING/COMPLETED/FAILED/CANCELED/TIMEOUT
  depends_on        VARCHAR(512),              -- 逗号分隔 task id（DAG 边）
  input_artifacts   VARCHAR(512),
  output_artifacts  VARCHAR(512),
  remote_session_id VARCHAR(64),               -- 远端 Runtime 会话 id（断线恢复用）
  trace_id          VARCHAR(40)  NOT NULL,
  timeout_sec       INT,
  error_summary     VARCHAR(512),
  created_at        TIMESTAMP    NOT NULL,
  updated_at        TIMESTAMP    NOT NULL
);
CREATE INDEX idx_task_room_state ON collaboration_task(room_id, state);

-- 2.6 统一事件日志（核心：一切展示与恢复的源头）
CREATE TABLE room_event (
  id                VARCHAR(40) PRIMARY KEY,
  room_id           VARCHAR(40)  NOT NULL,
  task_id           VARCHAR(40),
  participant_id    VARCHAR(40),
  digital_human_id  VARCHAR(40),
  type              VARCHAR(40)  NOT NULL,     -- 见 §5 枚举
  occurred_at       TIMESTAMP    NOT NULL,
  visibility        VARCHAR(16)  NOT NULL DEFAULT 'room', -- room / participant / owner
  payload           CLOB,                      -- JSON，按 type 解析
  rendering         CLOB,                      -- JSON: kind/title/severity 渲染提示
  trace_id          VARCHAR(40),
  seq               BIGINT       NOT NULL      -- 房间内单调递增序号，断线补齐用
);
CREATE INDEX idx_event_room_seq ON room_event(room_id, seq);
CREATE INDEX idx_event_task ON room_event(task_id);

-- 2.7 产物
CREATE TABLE collaboration_artifact (
  id                VARCHAR(40) PRIMARY KEY,
  room_id           VARCHAR(40)  NOT NULL,
  task_id           VARCHAR(40),
  producer_id       VARCHAR(40),               -- participant id
  kind              VARCHAR(24)  NOT NULL,     -- text/markdown/code-patch/report/command-result/file
  title             VARCHAR(128) NOT NULL,
  version           INT          NOT NULL DEFAULT 1,
  content_ref       VARCHAR(255) NOT NULL,     -- 文件路径或大字段表引用
  provenance        CLOB,                      -- JSON: traceId + source event ids
  risk_level        VARCHAR(16)  DEFAULT 'low',
  created_at        TIMESTAMP    NOT NULL
);

-- 2.8 审批记录（与运行时审批关联）
CREATE TABLE collaboration_approval (
  id                VARCHAR(40) PRIMARY KEY,
  room_id           VARCHAR(40)  NOT NULL,
  task_id           VARCHAR(40)  NOT NULL,
  participant_id    VARCHAR(40)  NOT NULL,
  runtime_approval_id VARCHAR(64),             -- 关联 /api/harness/approvals/runtime
  tool_name         VARCHAR(64),
  summary           VARCHAR(255),
  risk_level        VARCHAR(16),
  verdict           VARCHAR(20),               -- ALLOW_ONCE/ALLOW_SESSION/DENY/EXPIRED
  created_at        TIMESTAMP    NOT NULL,
  resolved_at       TIMESTAMP
);
```

## 3. API 契约（本地 Runtime 新增）

统一沿用既有 `ApiEnvelope{code, info, data}` 包裹。

### 3.1 数字人目录

```http
GET  /api/digital-humans
→ data: DigitalHumanView[]   # 身份 + 端点 + 健康状态联查

POST /api/digital-humans/discover
← { "baseUrl": "https://ops.internal:8080", "credentialRef": "cred_ops" }
→ data: { "reachable": true, "protocolVersion": "dsh.v1",
          "agentCard": { ... },               # 预填名称/头像/用途/能力
          "suggested": { "displayName": "...", "purpose": "...", "roleTags": [...] },
          "error": null }                     # 失败时 error: {kind: dns|tls|401|404|incompatible, message}

POST /api/digital-humans
← { "displayName": "服务器管家", "avatarRef": "emoji:🛠", "purpose": "...",
    "roleTags": ["server-ops"], "themeColor": "#4160f0",
    "endpoint": { "type": "remote-dsh", "baseUrl": "...", "credentialRef": "cred_ops" },
    "toolPolicy": {...}, "approvalPolicy": "WRITE_REQUIRES_APPROVAL", "concurrencyLimit": 2 }
→ data: DigitalHumanView

PUT    /api/digital-humans/{id}          # 仅本地接入策略可改，不能改远端配置
DELETE /api/digital-humans/{id}
POST   /api/digital-humans/{id}/health-check → data: { healthState, latencyMs }
```

### 3.2 房间与协作

```http
POST /api/collaboration/rooms
← { "workspaceId": "...", "title": "线上异常分析", "objective": "...",
    "orchestrationMode": "AUTO_PLAN" }
→ data: RoomView

POST /api/collaboration/rooms/{roomId}/participants
← { "digitalHumanId": "dh_ops", "roomRole": "member" }
→ data: ParticipantView          # 幂等：重复加入返回已有

POST /api/collaboration/rooms/{roomId}/messages
← { "content": "@服务器管家 检查 nginx 为什么 CPU 高",
    "mentions": ["dh_ops"],                       # 空 + 多成员 → AUTO_PLAN
    "orchestration": "MANUAL" }
→ data: { "accepted": true, "taskIds": ["task_..."], "planPreview": [...] }

POST /api/collaboration/tasks/{taskId}/cancel
POST /api/collaboration/approvals/{approvalId}/resolve
← { "verdict": "ALLOW_ONCE" }

GET /api/collaboration/rooms/{roomId}
→ data: RoomDetail   # room + participants + tasks + artifacts 快照（首屏）
```

### 3.3 事件流（UI 只连这一条）

```http
GET /api/collaboration/rooms/{roomId}/events?afterSeq={seq}
→ text/event-stream，每条：
event: room-event
data: {RoomEvent JSON}
```

- `afterSeq`：断线重连后从 `seq` 补齐，前端保存最后收到的 seq。
- 本地 Runtime 内部把远端 SSE → NormalizedRoomEvent → 写 `room_event` 表 → 推给 UI。UI 永远只面对本地这一条流。

## 4. RoomEvent 类型枚举（v1）

| type | payload 关键字段 | UI 渲染 |
| --- | --- | --- |
| `PARTICIPANT_JOINED` | digitalHumanId, displayName | 系统条「xx 加入了协作」 |
| `PARTICIPANT_STATUS_CHANGED` | presence, taskId | 只更新头像状态点，不插消息 |
| `PLAN_CREATED` | steps: [{seq, title, assignTo, dependsOn}] | 计划卡（可确认/调整） |
| `TASK_CREATED` / `TASK_ASSIGNED` | taskId, title, assignedTo | 任务条 |
| `TASK_STATE_CHANGED` | state, errorSummary? | 更新任务卡 |
| `MESSAGE_CREATED` | markdown 文本 | 数字人气泡（头像+名称+时间） |
| `MESSAGE_CHUNK` | text | 追加到当前气泡 |
| `REASONING_CHUNK` | text | 折叠区，按权限可隐藏 |
| `TOOL_CALL` | toolName, argsSummary, callId | 工具卡上半 |
| `TOOL_RESULT` | callId, summary, resultRef? | 工具卡下半 |
| `HANDOFF_REQUESTED` | from, to, taskId, reason, artifactIds | 交接条「A → B：原因」 |
| `APPROVAL_REQUIRED` | approvalId, toolName, summary, riskLevel | 对话内审批条 + 面板审批卡 |
| `APPROVAL_RESOLVED` | approvalId, verdict | 审批条状态翻转 |
| `ARTIFACT_CREATED` | artifactId, kind, title, version | 产物卡 |
| `ERROR` | code, message, recoverable, suggestion | 错误卡（重试/换人/取消） |

所有事件必须带：`id, roomId, seq, occurredAt, traceId`；归属事件必须带 `participantId, digitalHumanId`。

## 5. 远端接入协议（DSH v1）

### 5.1 能力发现

```http
GET {baseUrl}/.well-known/dsh-agent-card
Authorization: Bearer <token>
```

响应结构（对齐 A2A Agent Card 语义，便于将来映射）：

```json
{
  "schemaVersion": "1.0",
  "digitalHumanId": "ops-linux",
  "displayName": "服务器管家",
  "avatarUrl": "/assets/ops.png",
  "purpose": "服务器巡检、日志排查、部署与回滚",
  "roleTags": ["server-ops", "deployment"],
  "capabilities": [{ "name": "server-inspection", "description": "...", "input": "objective", "output": "report" }],
  "tools": ["fs.read", "shell.execute"],
  "approvalPolicy": "WRITE_REQUIRES_APPROVAL",
  "maxConcurrentTasks": 2,
  "protocol": "dsh.v1",
  "endpoints": { "stream": "/api/agent/stream", "approvals": "/api/harness/approvals" }
}
```

### 5.2 任务执行与事件归一化

Gateway 对每个远端任务：以 `remote_session_id` 调远端 `/api/agent/stream`（body 带 `agentId`、`message`、`channelCode`、`approvalMode`），把远端 SSE 事件（`meta/chunk/reasoning/tool_result/finish/error`）按下表归一化：

| 远端 SSE | RoomEvent |
| --- | --- |
| `meta`（session 建立） | `TASK_STATE_CHANGED → RUNNING` |
| `chunk` | `MESSAGE_CHUNK` |
| `reasoning` | `REASONING_CHUNK` |
| `tool_result`（发起） | `TOOL_CALL` |
| `tool_result`（返回） | `TOOL_RESULT` |
| `finish` | `MESSAGE_CREATED` + `TASK_STATE_CHANGED → COMPLETED` + `ARTIFACT_CREATED`（若有） |
| `error` | `ERROR` + `TASK_STATE_CHANGED → FAILED` |
| 审批中断 | `APPROVAL_REQUIRED`（本地审批后回写远端 resolve） |

断线策略：指数退避重连（1s/2s/4s/8s，上限 30s）；重连用 `remote_session_id` 恢复会话；连续 5 次失败 → 端点置 `degraded`，任务置 `blocked`，发 `ERROR` 事件给出「重试 / 转交 / 取消」三个选项。

## 6. 协作机制（Orchestrator）

### 6.1 三种触发

1. **手动 @**：`mentions` 非空 → 每 mention 生成一个 READY 任务直接派发。
2. **AUTO_PLAN**：`mentions` 空 + 多成员 → 用各数字人 `purpose + roleTags` 生成计划（`PLAN_CREATED`），用户确认后按 DAG 执行。
3. **HANDOFF**：数字人完成时产出 `HANDOFF_REQUESTED`（带 to/reason/artifactIds），Orchestrator 校验目标在房间内且有空闲并发后创建下游任务。

### 6.2 调度规则

- 每 tick 扫描 READY 任务：依赖全部 COMPLETED 且执行者并发未满 → ASSIGNED → 派发到对应 Runtime。
- 同任务不重复派发（`assigned_to + state` 幂等键）。
- 超时（`timeout_sec`）→ TIMEOUT；失败可选重试（同任务）、换人（重指派）、取消。
- 冲突处理：多数字人对同一问题结论冲突 → 标 `CONFLICT`，生成差异表交 Reviewer 或用户仲裁，仲裁结论写房间共享上下文后才可被下游引用。

### 6.3 上下文传递

不发全量聊天记录。按任务组装：任务上下文（目标/约束/验收）+ 依赖产物引用（artifactId，内容按需拉取）+ 房间摘要（参与者与当前计划）。凭据、未引用历史会话不进提示词。

## 7. 安全要点

1. Token 只进 Tauri 安全存储；Runtime 读凭据通过 `credentialRef` 调 Tauri 命令，业务表、日志、事件流均无明文。
2. 远端连接默认 HTTPS；HTTP 仅本地开发且需显式确认。
3. 审批粒度 = 数字人 × 工具 × 资源；审批卡必须显示：谁、哪个任务、什么工具、访问什么资源、参数摘要、风险、TraceId。
4. 每远端端点独立限流 + 熔断；远端事件校验来源，防止伪造数字人。
5. 日志只落引用/摘要/哈希，不落 API Key、完整文件内容、敏感命令输出。

## 8. 落地顺序（与任务拆解对应）

| 阶段 | 交付 | 退出标准 |
| --- | --- | --- |
| S1 数字人目录 | 表 2.1/2.2、目录 API、目录页 + 添加向导 | 增删改查可用，重启后仍在 |
| S2 远端接入闭环 | discover、健康检查、Gateway、归一化、事件流 | `@` 远端数字人跑通完整任务，消息/工具卡有归属 |
| S3 多成员房间 | Room/Participant/Task 表、房间 API、多角色消息流、右侧协作面板 | 3 个数字人同房间并行不串状态 |
| S4 编排与审批 | Orchestrator、AUTO_PLAN、HANDOFF、DAG、审批归属 | 计划可确认/并行/交接/审批落对数字人 |
| S5 治理与开放 | 限流熔断、审计、脱敏、A2A 映射预留 | 危险操作全审批，断线可恢复 |

**MVP = S1 + S2**。先让「添加服务器管家 → @它巡检服务器 → 看到它干活的全过程」这一件事体验做到极致，再扩协作。
