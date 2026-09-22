# DSH-Java-Desktop 全量测试用例集（生产就绪度验证）

> 版本：v1.0（2026-09-22）
> 范围：DSH-Java-Desktop 桌面壳（Tauri + React）+ 内嵌服务端 deepseek-harness-java（standalone · H2 · 内置 JRE 17）
> 目标：验证该产品具备对标 Codex CLI / WorkBuddy 的生产级能力，重点覆盖**长对话、长任务**。

---

## 0. 测试环境与约定

| 项 | 值 |
| --- | --- |
| 服务端 | `deepseek-harness-java-app.jar`，`--spring.profiles.active=standalone`，H2 文件库 |
| 模型侧 | `tests/harness/fake-llm-server.mjs`（OpenAI 兼容可控桩：分片数/延迟/工具轮次/5xx/静默均可注入） |
| 执行器 | `tests/harness/run-e2e.mjs`（12 个自动化场景，证据落 `tests/evidence/e2e-results.json`） |
| 优先级 | P0=发布阻塞 / P1=重要 / P2=一般 |
| 结果标记 | ✅ 通过 · ⚠️ 有保留通过 · ❌ 未通过 · ➖ 未执行（需人工/桌面端） |

**关键约定**：审批类场景必须显式带 `approvalMode=AUTO_APPROVE`（默认 REQUEST_APPROVAL 会阻塞最长 600s）；服务端 Agent SSE 心跳 15s、无总超时；前端空闲看门狗 120s。

---

## 1. 对话与会话（TC-100 系列）

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-101 | 单轮 SSE 全链路 | 发 1 条消息，监听全部 SSE 事件 | 顺序收到 meta→chunk*→finish→done；done 含 sessionId/messages/totalChunks；会话与消息落库可回读 | P0 | ✅ S1 |
| TC-102 | 会话列表/分页/置顶/重命名 | 桌面端侧边栏操作 | 列表分页 10/页；置顶与标题持久化（localStorage） | P1 | ➖ 桌面端 |
| TC-103 | 停止生成 | 长输出中点「停止」 | SSE 读取立即中断；UI 收尾；服务端把当前 turn 跑完（已知设计限制，README 有声明） | P1 | ✅ S5（API 层）；UI ➖ |
| TC-104 | 多会话并发流式 | 6 个会话同时流式 | 全部成功、sessionId 不串、内容不交叉 | P0 | ✅ S4 |
| TC-105 | 消息 Markdown/GFM 渲染 | 发送表格/代码块/脚注 | 渲染正确（react-markdown + GFM 插件） | P2 | ➖ 桌面端 |
| TC-106 | 图片输入 | 附带 base64 图片消息 | 上游 messages 收到 image_url 结构 | P2 | ➖（桩未启用多模态断言） |

## 2. 长对话（TC-200 系列）★重点

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-201 | 40 轮 × 12KB 回复连续对话 | 连发 40 轮，每轮观测上游上下文 | 全部成功；上下文单调增长后触发压缩回落（实测第 35 轮 404k→124k 字符）；单轮延迟不劣化（实测 ×1.04） | P0 | ✅ S2 |
| TC-202 | 压缩机制生效 | 低 `pressure-threshold-tokens` 实例连发 | 达阈值后旧消息被摘要替换（Replace 事件），保留最近 1/4；后续轮次正常 | P0 | ⚠️ 默认阈值下 40 轮已触发一次压缩；低阈值实例复测待补 |
| TC-203 | 超长单条输入 | 单条 ≈200KB 消息 | 请求成功；上游实收 222k 字符（按预算送达/裁剪）；无 OOM | P0 | ✅ S3 |
| TC-204 | 上下文窗口预算裁剪 | 超过 128k 窗口 | `buildRequest` 按 budget 从最新向前保留 ≥6 条；不爆上游 | P1 | ✅（S3 未爆）+ 代码走查 |
| TC-205 | 步数上限保护 | 模型无限索要工具调用 | MAX_STEPS_PER_TURN=50 收口，回合正常 done | P0 | ✅ S6（实测 50 次收口，618ms） |
| TC-206 | done 全量历史回包 | 40 轮后看回包体积 | ⚠️ 回包体积线性增长（实测 ×40.57，≈499KB）；带宽敏感场景是隐患，属已知架构债 | P1 | ⚠️ S2 记录在案 |
| TC-207 | 会话切换/恢复 | 切走再切回、重启后恢复 | localStorage 别名迁移正确；服务端按 sessionId 恢复历史 | P1 | ✅ S9（API 层）；UI ➖ |
| TC-208 | 极长对话（200 轮+）soak | 长时间连续对话 | 无内存泄漏（`liveAgents` 不淘汰、每会话 WAL 线程不回收是已知风险） | P2 | ❌ 未执行（见缺陷 D-06） |

## 3. 长任务与工具（TC-300 系列）★重点

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-301 | 多步工具循环 | 模型连续 3 次 shell_execute 后汇总 | 3 个 tool_result 事件，最终 done | P0 | ✅ S6 |
| TC-302 | 长耗时工具（8s） | `sleep 8 && echo` | 工具执行成功；执行期间 SSE 连接保持 | P0 | ✅ S6（8068ms 完成；⚠️ 期间 0 心跳，仅靠 TCP 存活） |
| TC-303 | 服务端心跳 | 任意 >15s 静默期 | 15s 间隔 SSE comment 心跳 | P1 | ✅ S8（40s 静默收到 2 次心跳） |
| TC-304 | 工具超时 | 挂死工具（如 `sleep 99999`） | 应有超时中断 | **P0** | ✅ **D-01 已修复**（2026-09-22）：`harness.agent.tool-timeout-ms` 默认 300s；5s 实例实测挂死工具 5.28s 判 TOOL_TIMEOUT、回合正常 idle 收尾；长工具（sleep 8，默认超时）8.1s 完整执行不受影响 |
| TC-305 | 任务队列语义 | 提交后台任务 | 调度/并发度/超时/取消/重试预算 | P1 | ❌ **D-02：harness 任务队列仅落库，无调度器** |
| TC-306 | 协作任务取消级联 | 房间内取消上游任务 | 下游级联置 FAILED，状态不被覆盖 | P1 | ➖ 桌面端（API 已暴露 cancel/resume/retry/reassign） |
| TC-307 | 失败自动恢复 | 任务失败 | 每任务 1 次恢复预算：改派→重试→级联终止 | P1 | ➖ 桌面端 |
| TC-308 | 并发审批 | 两个会话同时触发审批 | 各自独立阻塞，互不影响 | P1 | ✅（代码走查：RuntimeApprovalBroker per-call Future）；UI ➖ |
| TC-309 | 审批超时 | 审批 10 分钟不处理 | 默认 600s 超时 → DENY，回合继续 | P1 | ✅（配置与代码走查） |

## 4. 流式稳定性（TC-400 系列）★重点

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-401 | 模型静默挂死 | 上游只发 1 片后永久静默 | 服务端不主动断（无总超时），靠心跳维持；前端 120s 看门狗触发 StreamIdleError 后走 REST 对账静默补齐 | P0 | ✅ S8 + 前端代码走查（agent-client.ts armIdleWatchdog） |
| TC-402 | 空闲看门狗触发后对账 | 前端断开后 | 按 agentId 拉 sessions+messages，采纳条数/richness 更大的一方，UI 不报错 | P0 | ✅（代码走查 App.tsx L2790-2824） |
| TC-403 | AbortSignal 打断 | 看门狗/停止按钮 | 立即中断挂起的 reader.read() | P0 | ✅ S5（API 层） |
| TC-404 | 房间流重连 | 杀掉房间 SSE | 1s→15s 指数退避重连，afterSeq 续传不丢事件 | P1 | ✅（代码走查 room-feed/digital-human-client） |
| TC-405 | 上游 5xx | 模型侧返回 503 | 错误显式进入消息流（⚠️ LLM 调用失败: …），回合立即收尾，恢复后同会话可继续 | P0 | ✅ S7 |
| TC-406 | 上游连接拒绝 | 假模型服务整体下线 | 重试预算（仅未吐内容时）退避重试后报错，不静默 | P1 | ✅（代码走查 ResolvedRetryPolicy） |
| TC-407 | Gateway/Workflow/A2A 无心跳流 | 300s/600s 超时边界 | ⚠️ 这三类流无心跳，长任务在 NAT/代理环境可能被中间设备掐断 | P1 | ✅ **D-03 已修复（2026-09-22）**：三处流均有 15s 心跳 |

## 5. 模型渠道（TC-500 系列）

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-501 | 自定义 baseUrl 渠道 | 保存任意 OpenAI 兼容地址并激活 | 保存/激活成功，运行时模型列表更新 | P0 | ✅（本测试全程即依赖该能力） |
| TC-502 | baseUrl 版本段兼容 | 带 /v1 /v2 /v1beta 后缀 | URI 解析不重复追加版本段 | P1 | ✅（OpenAiCompatibleUriResolver 单测已有 + 走查） |
| TC-503 | 同步上游模型列表 | discover | /models 解析为渠道模型 | P1 | ✅（桩提供 /v1/models） |
| TC-504 | 渠道删除/切换运行时模型 | 设置页操作 | 激活渠道即时生效 | P2 | ➖ 桌面端 |
| TC-505 | API Key 兜底 | 渠道无 Key | 使用环境变量/文件兜底并告警 | P2 | ✅ 启动日志告警 |

## 6. 扩展与插件（TC-600 系列）

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-601 | Skills/MCP/CLI/插件查询面 | 各 GET 端点 | 全部 200 | P1 | ✅ S11 |
| TC-602 | Skills Git 安装/启停/删除 | 设置页 + extension_* 工具 | 安装成功且热生效；extension_skill_* 对话工具可代操作 | P1 | ➖ 桌面端 |
| TC-603 | MCP 保存前测连 | 新增 stdio/SSE server | 测连发现工具；运行期热连接/断开 | P1 | ➖ 桌面端 |
| TC-604 | MCP preset 同名覆盖 | custom 与 preset 同名 | custom 优先 | P2 | ✅（代码走查） |
| TC-605 | 插件 jar 分析/安装 | analyze-jar + install | 元数据解析正确，热加载（PluginHotReloader 日志证实已启动） | P2 | ➖ |
| TC-606 | 扩展配置持久化 | 重启后 | `~/.dsh/extensions.json` 状态保留 | P1 | ➖ |

## 7. 数字人协作（TC-700 系列）

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-701 | 数字人目录 CRUD + 健康检查 | 目录页操作 | 列表/新增/删除/health-check 正常 | P1 | ✅ S12（列表）；CRUD ➖ |
| TC-702 | 双协议探测发现 | 添加向导填远端地址 | 自动探测 DSH v1 / A2A 0.3.x 卡片并预填 | P1 | ➖ 桌面端（服务端卡片段 ✅ S10） |
| TC-703 | 房间创建/成员/消息 | POST rooms + participants + messages | 房间创建成功、事件流可查 | P0 | ✅ S12 |
| TC-704 | Planner 任务 DAG | 群聊描述目标 | 自动分工、无依赖并行、有依赖续跑 | P1 | ➖ 需真实多智能体 |
| TC-705 | ASK 协议定向问答 | 成员执行中提问 | QuestionCard 弹出，答复注入续跑 | P1 | ➖ 桌面端（前后端链路 2026-09-22 已联调通过，见项目笔记） |
| TC-706 | 房间事件归一化 | 混合 DSH/A2A 成员事件 | RoomEvent 统一投影到消息流/协作面板 | P1 | ➖ |
| TC-707 | A2A message/send | JSON-RPC 调用自身卡片 | 返回 task 结构（state=completed + artifacts） | P0 | ✅ S10 |

## 8. 桌面壳与 Tauri（TC-800 系列）

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-801 | 服务进程托管 | 启动/停止/异常退出 | 随机端口拉起 JAR；上次异常退出先清理遗留进程（防 H2 锁） | P0 | ✅（lib.rs 走查 + 本机日志佐证） |
| TC-802 | 内置 JRE 选择顺序 | DSH_AGENT_JAVA → 内置 runtime → 系统 java | 版本 ≥17，不污染用户 JAVA_HOME | P0 | ✅（本次用系统 17.0.9 + 桌面端日志走查） |
| TC-803 | 文件卡片右键菜单 | 打开/打开文件夹/另存为/复制路径 | 四项均生效；失效路径置灰 | P1 | ➖ 桌面端 |
| TC-804 | 资源插件五件套 | Word/Excel/Markdown/ECharts/draw.io 生成与预览 | 专属图标 + 预览正确；draw.io 编辑 800ms 防抖落盘 | P1 | ➖ 桌面端 |
| TC-805 | 系统通知与提示音 | 未聚焦会话完成 | send_notification + Web Audio 双音 | P2 | ➖ 桌面端 |
| TC-806 | 自动更新 | 启动检查 latest.json | 发现新版本可下载安装重启（四平台 tag 构建） | P1 | ➖ CI 环境 |
| TC-807 | Git 面板 | 分支下拉切换、变更查看 | checkout 生效 | P2 | ➖ 桌面端 |
| TC-808 | 安全面 | 前端不暴露执行命令 | 仅 22 个白名单 invoke 命令 | P0 | ✅（lib.rs 走查） |

## 9. 非功能（TC-900 系列）

| 用例 | 场景 | 步骤 | 预期 | 优先级 | 结果 |
| --- | --- | --- | --- | --- | --- |
| TC-901 | 鉴权 | `harness.auth.api-keys` 配置后访问 | 未带 Key 被拒 | **P0** | ⚠️ 默认 `[]` 全放行（**D-04**）；配置后为静态等值校验 |
| TC-902 | 可观测性 | /actuator/health、metrics | 有健康检查与指标 | P1 | ✅ **D-05 已修复（2026-09-22）**：health/info 已暴露（health=UP、env=404）；metrics/trace 未做 |
| TC-903 | 数据迁移 | 跨版本升级 H2 | SchemaMigrationRunner 幂等 ALTER（本次启动日志已见执行） | P1 | ⚠️ 仅增量 ALTER，无版本化迁移框架 |
| TC-904 | 崩溃一致性 | kill -9 后重启 | ⚠️ 异步落库（每会话单线程 WAL 队列）崩溃可能丢尾部事件，无重放补偿 | P1 | ❌ **D-07** |
| TC-905 | 资源上限 | 并发+长对话 soak | 线程池/内存有界 | P1 | ❌ **D-06：cachedThreadPool 无界 + liveAgents 不淘汰** |
| TC-906 | CSP 与凭据 | tauri.conf | ⚠️ `csp: null`；凭据存系统 keychain（✅）；capability 仅放行 127.0.0.1（远端探测走降级路径可能被拒，**D-08**） | P1 | ⚠️ |
| TC-907 | 构建门禁 | tsc strict + vite build | 通过；但无 ESLint/测试基础设施（本次已补 vitest） | P1 | ⚠️ tsc ✅，lint ❌ |
| TC-908 | 无 ErrorBoundary | 任意组件抛错 | 白屏风险 | P1 | ❌ **D-09** |

---

## 10. 缺陷与风险登记（按优先级）

| 编号 | 级别 | 描述 | 位置 | 建议 |
| --- | --- | --- | --- | --- |
| D-01 | ~~**P0**~~ ✅已修复 | 工具执行无超时，挂死工具将无限阻塞回合 | ToolCallExecutor（future.join 无 timeout）；ToolTimeoutPolicy/GuardService 死代码 | **已修复（2026-09-22）**：`harness.agent.tool-timeout-ms`（默认 300s）注入 ToolCallExecutor；超时启用时派发走 daemon worker 池（规避同步阻塞型工具）；超时判 TOOL_TIMEOUT 合成失败结果，tool_call/tool_result 保持成对；settled 集合防迟到回调覆盖。实测：5s 实例挂死工具 5.28s 收口；E2E 回归 S1/S3~S8 全过 |
| D-02 | P0 | harness 任务队列只落库不调度（无并发度/超时/取消/重试） | HarnessTaskQueueService | 补调度器或明确降级为「记录」语义 |
| D-03 | P1 | ~~Gateway/Workflow/A2A SSE 无心跳~~ ✅**已修复（2026-09-22）** | WorkflowStreamApi / CollaborationService.subscribe / A2AController.messageStream | **已修复**：三处流均补 15s `:keepalive` comment 心跳（daemon 调度器 + 生命周期取消）。实测房间流 35s 收到 2 次心跳 |
| D-04 | P0 | ~~默认无鉴权~~ ✅**已修复（2026-09-22，桌面单机）** | harness.yml auth 段 + 桌面壳 | **已修复**：start_agent 生成 256-bit 随机 Key 注入 `--harness.auth.api-keys`，前端自动附加 `X-API-Key`（实测 401/200 行为正确）。开放端口部署仍需 RBAC/审计 |
| D-05 | P1 | ~~无 actuator/metrics/health 端点~~ ✅**已修复（2026-09-22）** | pom | **已修复**：spring-boot-starter-actuator，仅暴露 health/info |
| D-06 | P1 | 资源无上限：SSE cachedThreadPool 无界、每 turn 新建线程池、liveAgents 不淘汰、每会话 WAL 线程不回收 | ReactLoopAgent.kick / AgentRunFactory | 引入有界池 + agent 生命周期清理 |
| D-07 | P1 | 异步落库可丢尾部事件，崩溃无 WAL 重放 | PersistingSessionLog | 重启时对账/重放机制 |
| D-08 | P2 | 远端数字人探测走原生 fetch 可能被 Tauri capability 拒绝（仅放行 127.0.0.1） | capabilities/default.json + discoverDigitalHuman 降级路径 | 远端地址加入 capability 或统一走 Rust 侧代理 |
| D-09 | P1 | 前端无 ErrorBoundary，渲染异常白屏；大量静默 catch {} 不可观测 | App.tsx 及组件层 | 顶层 ErrorBoundary + 日志上报 |
| D-10 | P1 | ~~done 事件回传全量历史~~ ✅**已修复（2026-09-22）** | AgentStreamApi / GatewayStreamApi | **已修复**：done 只回当前回合消息（自最后一条 user 起）+ `messageCount` 元信息；完整历史走 `/api/harness/console/sessions/{id}/messages` 兜底。S9 断言同步更新 |
| D-11 | P1 | 超长会话无虚拟滚动 + 每 chunk 全量 markdown 重解析，长对话 UI 卡顿 | ConversationView | react-window + memo |
| D-12 | P2 | `dsh-session-messages` 单 key 全量序列化，长历史易触 localStorage 配额 | App.tsx persistSessionMessages | 按会话分 key 或迁 IndexedDB |
| D-13 | P2 | jobs/schedule/审批 pending 全内存，重启即丢 | InMemory*Repository | 持久化或明确标注易失 |

---

## 11. 执行入口

```bash
# 1) 启动假模型（可控桩）
node tests/harness/fake-llm-server.mjs          # 默认 :8899

# 2) 启动 standalone 服务端
java -jar resources/agent/deepseek-harness-java-app.jar \
  --spring.profiles.active=standalone --server.port=8912 \
  "--spring.datasource.url=jdbc:h2:file:/tmp/dsh-e2e/dsh-e2e;MODE=MySQL;CASE_INSENSITIVE_IDENTIFIERS=TRUE" \
  --harness.agent.default-cwd=/tmp/dsh-e2e/ws

# 3) 配置渠道（指向桩）后跑全量
DSH_CHANNEL=<channelCode> node tests/harness/run-e2e.mjs          # 全部
DSH_CHANNEL=<channelCode> node tests/harness/run-e2e.mjs S2 S6    # 只跑长对话/长任务
```

前端单测（vitest，纯逻辑模块）：`npx vitest run --root tests/unit`
