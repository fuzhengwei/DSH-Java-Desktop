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

可以，而且这是当前最合适的复用方式，但前提是必须由 Tauri Rust 层托管进程，而不是前端直接执行。`resources/agent/deepseek-harness-java-app.jar` 已直接纳入本仓库并随安装包打包：

1. `deepseek-harness-java` 的 `/api/agent/stream`、会话、审批、模型等 Web 端能力都在 Spring Boot JAR 内。
2. `standalone` profile 使用本地 H2 数据库，桌面场景不要求先部署 MySQL。
3. Tauri Rust 层选择空闲端口、捕获日志、记录进程状态，退出时停止子进程，避免前端暴露执行命令的安全面。
4. 运行记录写入 `<app-data-dir>/agent-runtime.json`；如果上一次桌面端异常退出，下一次启动会先清理遗留 JAR 进程，避免 H2 文件锁冲突。
5. 桌面 UI 通过 `127.0.0.1` 调用服务，只包装原 Web 能力；服务诊断只在设置页展示，主对话区不暴露本地端口或启动状态。

发布版只使用应用内置的 Java 17 Runtime，用户不需要单独安装或配置 JDK。开发环境会按以下顺序选择 Java：`DSH_AGENT_JAVA`、应用内置 Runtime、系统 `java`；无论来源是什么，版本都必须是 Java 17 或更高版本。正式构建如果缺少内置 Runtime 会直接提示准备资源，不会静默依赖用户的系统 Java。

内置 Runtime 位于 `resources/agent/runtime`，目录中需要包含当前目标平台的 `bin/java`（Windows 为 `bin/java.exe`）。Runtime 二进制不提交到 Git，由准备脚本按当前平台下载 Temurin JRE 17；也可以通过 `DSH_JRE_TARGET` 为指定平台准备资源。

运行日志会写入系统应用数据目录：

```text
<app-data-dir>/logs/agent.log
```

## 开发

```bash
npm install
npm run tauri dev
```

发布版直接使用仓库内的 JAR；开发时若本机没有已复制 JAR，Rust 层会回退查找：

```text
../deepseek-harness-java/deepseek-harness-java-app/target/deepseek-harness-java-app-0.1.6.jar
```

准备发布用 JAR 和 Java Runtime：

```bash
npm run tauri:build
```

`agent:prepare` 会构建并复制智能体 JAR，然后下载当前平台的 Temurin Java 17 Runtime。跨平台构建时，分别在对应平台执行准备脚本，或设置目标平台，例如（部分网络环境需要先访问 Adoptium API 与 GitHub Release 镜像）：

```bash
DSH_JRE_TARGET=darwin-arm64 npm run agent:runtime
DSH_JRE_TARGET=win32-x64 npm run agent:runtime
```

如果发布包中的 Runtime 缺失、损坏或版本低于 17，设置页「智能体服务连接」会显示具体 Java 路径、版本和错误原因；应用不会修改用户的 `JAVA_HOME` 或系统 `PATH`。

## 发布与自动更新

四个平台使用独立 tag 分别触发构建；成功后会把安装包和 Tauri updater 签名文件上传到同一个版本对应的 `dsh-java-desktop-v*` GitHub Release：

| 平台 | Tag |
| --- | --- |
| Linux x64 | `linux-x64-v*` |
| Windows x64 | `windows-x64-v*` |
| macOS Apple Silicon | `macos-apple-silicon-v*` |
| macOS Intel | `macos-intel-v*` |

应用通过以下端点检查更新：

```text
https://github.com/fuzhengwei/DSH-Java-Desktop/releases/latest/download/latest.json
```

CI 需要在仓库 `Settings → Secrets and variables → Actions` 中配置以下 Secret：

| Secret | 用途 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 自动更新包签名私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri 自动更新包签名私钥密码，无密码可为空 |
| `APPLE_CERTIFICATE` | macOS Developer ID Application 证书 `.p12` 的 Base64 内容 |
| `APPLE_CERTIFICATE_PASSWORD` | 上述 `.p12` 证书密码 |
| `APPLE_SIGNING_IDENTITY` | macOS 代码签名身份名称 |
| `APPLE_ID` | macOS 公证使用的 Apple ID |
| `APPLE_PASSWORD` | macOS 公证使用的 App-Specific Password |
| `APPLE_TEAM_ID` | Apple 开发者 Team ID |

`GITHUB_TOKEN` 不需要手动配置。本地生成/保存的 updater 私钥位置见 `src-tauri/updater.key`，公开签名密钥已写入 `src-tauri/tauri.conf.json`。应用启动时会自动检查更新；发现新版本后可选择下载安装，安装完成即可一键重启到新版本。

当前桌面版保持最小核心：应用启动时自动拉起 JAR、项目创建/选择/项目下对话、消息流式输入、模型配置/同步/激活/删除，以及运行期工具审批。设置入口放在左下角；工具审批以对话区内的紧凑提示条处理。

## 模型配置

1. 应用启动后会自动拉起智能体服务；完成后打开左下角「设置」。
2. 选择渠道模板，填写 Base URL 和 API Key。
3. 点击「同步模型」获取上游模型列表，或直接输入模型编码。
4. 点击「保存模型」；桌面端会保存服务端返回的 `channelCode` 并立即激活。
5. 顶部模型选择器随后会显示运行时模型，发送消息时自动携带该渠道。

如果模型配置正确但上游不可用，对话区域会显示智能体返回的错误；配置错误不会导致桌面端进程崩溃。
