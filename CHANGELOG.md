# 更新日志（Changelog）

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 约定。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.1] - 2026-09-23

### 新增
- 侧边栏改版：支持会话跨项目拖拽与组内排序、项目顶层排序（顺序持久化），新增搜索框、筛选弹层（状态/时间）与「对话/项目」列表模式切换，支持折叠收起。
- 智能体主动提问（ask_user_question）：对话流式期间智能体可向用户发起选择题/自定义回答，输入框上方渲染问答卡片，答复后自动唤醒智能体继续执行。
- 代码变更查看（DiffView）：消息内文件产物支持查看变更差异。
- 目录树视图增强（DirTreeView）：工作区目录结构可视化浏览。
- 数字人设置页（DigitalHumansSettings）：数字人目录、来源接入（本地 DSH / 远端 DSH / A2A）与凭据配置集中管理。
- 全局错误边界（ErrorBoundary）：渲染异常不再白屏，提供错误提示与恢复入口。
- 运行信息面板：展示工作区与子工程的 Git 分支，支持下拉切换分支（git checkout）与查看变更。

### 优化
- 文件产物卡片与预览体验增强：按扩展名分类图标/颜色、代码文件带行号查看、右键菜单（打开/打开文件夹/另存为/复制路径）、失效路径置灰标识。
- 对话流式稳定性：空闲看门狗、停止按钮 AbortSignal 立即打断、失败后按 agentId 走 REST 对账静默兜底。
- 房间事件流：指数退避自动重连 + 事件续传（afterSeq）+ 运行期 5s REST 轮询对账。
- SSE 链路统一 15s keepalive 心跳，done 事件瘦身（仅回当前回合消息 + 元信息）。
- 工具执行超时机制：`harness.agent.tool-timeout-ms` 可配置，防止工具卡死阻塞整个回合。

### 测试
- 新增 E2E 测试基建：fake-llm 服务、浏览器 stub（tests/browser-stub-init.js）、E2E 运行器与用例清单。
- 新增单元测试（vitest）覆盖 lib 层。

### 其他
- 更新通道与发布流程不变，仍通过 GitHub Releases + Tauri updater 自动更新。

## [0.1.0] - 2026-09（初版）

首个公开发布版本。

- 桌面壳：Tauri 2 + React 19 + TypeScript，内置 Java 17 Runtime 与 Agent Runtime 服务端 JAR，零依赖装完即用。
- 对话：项目/会话管理、SSE 流式消息、Markdown/GFM 渲染、停止生成、工具审批提示条。
- 模型接入：渠道模板、Base URL + API Key、模型列表同步与运行时切换。
- 资源插件：Word / Excel / Markdown / ECharts / draw.io 五类资源生成与预览。
- 数字人协作：协作房间、Planner 任务编排（DAG）、ASK 定向问答、失败自动恢复、任务取消级联终止。
- 开放协议：DSH v1 Agent Card 与 A2A 0.3.x（JSON-RPC + message/stream SSE），远端智能体可接入协作。
- 扩展管理：Skills（Git 安装）、MCP Servers（测连 + 热更新）、CLI 命令（claude / codex / acp）。
- 桌面体验：系统通知、完成提示音、自动更新（Tauri updater + GitHub Releases）。
