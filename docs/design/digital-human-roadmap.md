# DSH 数字人协作 — 开发任务拆解

> 依据：`docs/design/digital-human-implementation.md`（实现设计）、`docs/prototype/digital-human-prototype.html`（UI 原型）。
> 原则：**价值优先**——先打通「远端数字人真的在干活」的闭环，再做协作编排，最后做治理与开放。每个阶段结束都是可用产品。

## S1 数字人目录（MVP-1）

目标：数字人可见、可加、可持久化。

| # | 任务 | 改动位置 | 验收标准 |
| --- | --- | --- | --- |
| 1.1 | 建表 `digital_human` / `digital_human_endpoint` + 持久层 | JAR `digitalhuman/store` | 迁移脚本在 standalone H2 执行成功 |
| 1.2 | 目录 CRUD API：`GET/POST/PUT/DELETE /api/digital-humans` | JAR `digitalhuman/api` | Postman 全流程通过，响应走 ApiEnvelope |
| 1.3 | Tauri 凭据命令 `save/read/delete_credential` | `src-tauri/src/lib.rs` | Token 不出现在业务表与日志 |
| 1.4 | 前端目录页：列表 + 详情双栏（按原型） | `DigitalHumanCatalog.tsx` 新增 | 增删改查可用，头像/用途/状态展示正确 |
| 1.5 | 添加向导 5 步（来源→连接→身份→权限→确认） | `AddDigitalHumanWizard.tsx` 新增 | 3 步内可添加本地数字人；表单校验与错误提示完整 |
| 1.6 | 左侧导航「数字人」入口 + 路由 | `Sidebar.tsx` / `App.tsx` | 对话/目录/设置三视图切换正常 |

**退出标准**：重启桌面端后数字人目录仍在；目录中能看到本地服务对应的默认数字人。

## S2 远端接入闭环（MVP-2，价值核心）

目标：远端 DSH 服务变成数字人，`@它` 能干活，全过程可归属。

| # | 任务 | 改动位置 | 验收标准 |
| --- | --- | --- | --- |
| 2.1 | 远端暴露 `/.well-known/dsh-agent-card` | JAR（对远端而言是本服务新端点） | 浏览器可访问，结构符合 §5.1 |
| 2.2 | `POST /api/digital-humans/discover` 探测 + 错误分类 | JAR `directory` | DNS/TLS/401/404/协议不兼容各自返回可区分错误 |
| 2.3 | 健康检查 `POST /{id}/health-check` + 定时巡检 | JAR `directory` | 端点状态 online/offline/degraded 正确翻转 |
| 2.4 | 建表 `room_event` + 事件追加/序号/查询 | JAR `store` | seq 房间内单调递增，可按 afterSeq 补拉 |
| 2.5 | RemoteAgentGateway：远端 SSE 客户端 + 归一化映射（§5.2 表） | JAR `gateway` | 远端 chunk/tool/finish/error 全部转为 RoomEvent 落表 |
| 2.6 | `GET /rooms/{id}/events` SSE 聚合流 | JAR `api` | UI 只连本地这一条流即可收到远端事件 |
| 2.7 | 断线重连：指数退避 + remote_session_id 恢复 | JAR `gateway` | 杀远端重启后会话恢复；5 次失败置 degraded |
| 2.8 | 前端：多角色消息流（头像+名称+状态点+工具卡归属） | `ConversationView.tsx` 改造 | 每条消息/工具卡可看出是谁、哪个任务、什么时间 |
| 2.9 | 前端：`@` 唤起成员选择器 + mention chips | `ConversationView.tsx` | `@服务器管家 xxx` 正确生成派发请求 |

**退出标准（MVP 总验收）**：添加远端「服务器管家」→ 加入对话 → `@它` 巡检 → 主对话看到它的思考/工具/结果，全部带归属 → 完成后显示完成态；远端不可达时目录置灰、任务提示可重试。

## S3 多成员房间

目标：多个数字人在同一房间并存，互不串台。

| # | 任务 | 改动位置 | 验收标准 |
| --- | --- | --- | --- |
| 3.1 | 建表 `collaboration_room` / `room_participant` / `collaboration_task` | JAR `store` | 唯一约束 (room_id, digital_human_id) 生效 |
| 3.2 | 房间 API：建房/加人/发消息/快照 | JAR `api` | 重复加入幂等；快照含 participants+tasks |
| 3.3 | 任务派发：mention → READY → ASSIGNED → RUNNING | JAR `room` | 并发多任务各自独立推进 |
| 3.4 | 右侧协作面板：目标/参与者/任务/产物四组 | `CollabPanel.tsx` 新增 | 3 个数字人并行时面板状态各自正确 |
| 3.5 | 成员栏 + 成员详情 Popover（暂停/移出） | `ParticipantChip.tsx` 新增 | 移出进行中有二次确认 |
| 3.6 | 消息分组规则：同数字人 chunk 合并、状态变化不插消息 | `ConversationView.tsx` | 并行 3 人时主对话仍可读 |

**退出标准**：3 个数字人在同一房间并行执行任务，消息、状态、审批互不混淆；刷新页面后按快照+事件恢复现场。

## S4 编排与审批

目标：从「手动派单」升级到「自动分工 + 安全执行」。

| # | 任务 | 改动位置 | 验收标准 |
| --- | --- | --- | --- |
| 4.1 | Orchestrator：AUTO_PLAN 计划生成（用 purpose+roleTags 路由） | JAR `orchestrator` | `PLAN_CREATED` 计划合理，可确认/调整 |
| 4.2 | 任务 DAG：depends_on 调度、无依赖并行 | JAR `orchestrator` | 依赖未完成不派发；并行受并发上限约束 |
| 4.3 | HANDOFF：数字人完成 → 交接下游（带 artifactIds） | JAR `orchestrator` | 交接条在对话可见，下游任务自动创建 |
| 4.4 | 审批归属：`collaboration_approval` 关联运行时审批 | JAR `api` | 审批条/审批卡显示归属数字人，不会落错会话 |
| 4.5 | 超时/取消/重试/换人 | JAR `orchestrator` | 失败任务三选一操作均生效 |
| 4.6 | 产物系统：`collaboration_artifact` + 产物卡 + 版本 | JAR + 前端 | 产物可追溯到生产者、任务、TraceId |

**退出标准**：输入「分析线上异常并出公告」→ 自动出计划 → 并行执行 → 交接流转 → 危险操作逐次审批 → 最终产物归档可复用。

## S5 治理与开放

| # | 任务 | 验收标准 |
| --- | --- | --- |
| 5.1 | 每端点限流 + 熔断 | 远端风暴不拖垮本地 |
| 5.2 | 审计日志 `digital_human_audit_log` | 所有变更与审批可追溯 |
| 5.3 | 敏感数据脱敏（日志/事件流） | 无明文 Token、无敏感命令输出 |
| 5.4 | 数字人导入导出 + 角色模板 | 配置可分享复用 |
| 5.5 | A2A Agent Card 映射层（预留实现） | 外部 A2A Agent 可只读接入 |

## 建议节奏

- **MVP（S1+S2）优先全力投入**：这是验证「数字人是不是真价值」的最小集合，也是 UI 体验打磨的重点（多角色消息流、@ 交互、审批条都出现在这里）。
- S3/S4 可以并行设计，但实现严格按顺序——编排依赖房间与任务的稳定语义。
- 每个阶段结束后用真实场景回归 MVP 验收用例（服务器巡检），防止后面阶段破坏核心闭环。
