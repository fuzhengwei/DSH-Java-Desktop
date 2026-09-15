# DSH Java Desktop

`DSH Java Desktop` 是 `deepseek-harness-java` 的白色主题桌面工作台。它使用 TypeScript + React 构建界面，使用 Tauri 2 负责窗口、进程和本机能力；智能体能力不重复实现，而是由桌面壳启动 `deepseek-harness-java` 的 Spring Boot JAR，并通过本机 HTTP/SSE API 调用。

## 架构

```text
React / TypeScript UI
        |
        | invoke
        v
Tauri Rust Shell  --spawn-->  deepseek-harness-java-app.jar
        |                          |
        |        HTTP/SSE + standalone H2 profile
        v                          v
    Conversation / Approvals / Models
```

## 可以直接启动 JAR 吗？

可以，而且这是当前最合适的复用方式，但前提是必须由 Tauri Rust 层托管进程，而不是前端直接执行：

1. `deepseek-harness-java` 的 `/api/agent/stream`、会话、审批、模型等 Web 端能力都在 Spring Boot JAR 内。
2. `standalone` profile 使用本地 H2 数据库，桌面场景不要求先部署 MySQL。
3. Tauri Rust 层选择空闲端口、捕获日志、记录进程状态，退出时停止子进程，避免前端暴露执行命令的安全面。
4. 运行记录写入 `<app-data-dir>/agent-runtime.json`；如果上一次桌面端异常退出，下一次启动会先清理遗留 JAR 进程，避免 H2 文件锁冲突。
5. 桌面 UI 通过 `127.0.0.1` 调用服务，只包装原 Web 能力；服务诊断只在设置页展示，主对话区不暴露本地端口或启动状态。

限制：运行环境需要 Java 17 或更高版本。发布包中应包含 `resources/agent/deepseek-harness-java-app.jar`；也可以通过 `DSH_AGENT_JAR` 指向外部 JAR 进行开发调试。

运行日志会写入系统应用数据目录：

```text
<app-data-dir>/logs/agent.log
```

## 开发

```bash
npm install
npm run tauri dev
```

开发时若本机没有已复制 JAR，Rust 层会回退查找：

```text
../deepseek-harness-java/deepseek-harness-java-app/target/deepseek-harness-java-app-0.1.6.jar
```

准备发布用 JAR：

```bash
npm run agent:prepare
npm run tauri build
```

当前桌面版保持最小核心：应用启动时自动拉起 JAR、项目创建/选择/项目下对话、消息流式输入、模型配置/同步/激活/删除，以及运行期工具审批。设置入口放在左下角；工具审批以对话区内的紧凑提示条处理。

## 模型配置

1. 应用启动后会自动拉起智能体服务；完成后打开左下角「设置」。
2. 选择渠道模板，填写 Base URL 和 API Key。
3. 点击「同步模型」获取上游模型列表，或直接输入模型编码。
4. 点击「保存模型」；桌面端会保存服务端返回的 `channelCode` 并立即激活。
5. 顶部模型选择器随后会显示运行时模型，发送消息时自动携带该渠道。

如果模型配置正确但上游不可用，对话区域会显示智能体返回的错误；配置错误不会导致桌面端进程崩溃。
