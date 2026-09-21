use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_process::init as process_plugin;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceState {
    status: String,
    port: Option<u16>,
    jar_path: Option<String>,
    message: String,
    runtime_status: String,
    runtime_source: Option<String>,
    java_path: Option<String>,
    java_version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchState {
    branch: String,
    detached: bool,
}

#[derive(Clone, Serialize)]
struct GitBranchesState {
    current: String,
    branches: Vec<String>,
}

#[derive(Clone, Serialize)]
struct WorkspaceSelection {
    name: String,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileSelection {
    name: String,
    path: String,
    mime_type: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct GitChangeSummary {
    is_repo: bool,
    branch: String,
    insertions: u64,
    deletions: u64,
    files: Vec<GitChangedFile>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitChangedFile {
    status: String,
    path: String,
    insertions: Option<u64>,
    deletions: Option<u64>,
}

#[derive(Deserialize, Serialize)]
struct AgentRuntimeRecord {
    pid: u32,
    port: u16,
    jar_path: String,
}

struct AgentRuntime {
    child: Child,
    port: u16,
    jar_path: PathBuf,
    runtime_path: PathBuf,
    java_runtime: JavaRuntime,
}

struct AgentRuntimeState(Mutex<Option<AgentRuntime>>);

#[derive(Clone)]
struct JavaRuntime {
    path: PathBuf,
    source: String,
    version: String,
}

struct RuntimeCheck {
    status: String,
    source: Option<String>,
    java_path: Option<String>,
    java_version: Option<String>,
    message: String,
    runtime: Option<JavaRuntime>,
}

impl Drop for AgentRuntimeState {
    fn drop(&mut self) {
        if let Some(mut runtime) = self.0.get_mut().unwrap().take() {
            let _ = runtime.child.kill();
            let _ = runtime.child.wait();
            let _ = fs::remove_file(runtime.runtime_path);
        }
    }
}

fn shutdown_runtime(state: &AgentRuntimeState) {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut runtime) = guard.take() {
        let _ = runtime.child.kill();
        let _ = runtime.child.wait();
        let _ = fs::remove_file(runtime.runtime_path);
    }
}

/// 探测 PID 实际状态：kill -0 会把僵尸进程（已死、等待父进程回收）误判为存活，
/// 导致清理逻辑对僵尸发 TERM 永远无效而报"无法清理旧智能体进程"。
/// 因此用 ps 读取进程状态与命令行：不存在/僵尸 → 不算存活；
/// 命令行与智能体 jar 无关 → 视为 PID 复用被无关进程占用。
fn probe_pid(pid: u32) -> PidProbe {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
            .args(["-o", "stat=,command=", "-p", &pid.to_string()])
            .output();
        match output {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout);
                let mut parts = text.splitn(2, char::is_whitespace);
                let stat = parts.next().unwrap_or("").trim().to_string();
                let command = parts.next().unwrap_or("").trim().to_string();
                if stat.is_empty() {
                    return PidProbe::Gone;
                }
                if stat.starts_with('Z') {
                    return PidProbe::Zombie;
                }
                let ours = command.contains("deepseek-harness-java-app")
                    || command.contains("deepseek-harness-java")
                    || command.ends_with("java");
                if ours {
                    PidProbe::Ours
                } else {
                    PidProbe::Foreign(command)
                }
            }
            _ => PidProbe::Gone,
        }
    }

    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output();
        match output {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
                if !text.contains(&pid.to_string()) {
                    return PidProbe::Gone;
                }
                let ours = text.contains("java");
                if ours {
                    PidProbe::Ours
                } else {
                    PidProbe::Foreign(text)
                }
            }
            _ => PidProbe::Gone,
        }
    }
}

enum PidProbe {
    Gone,
    Zombie,
    Ours,
    Foreign(String),
}

fn pid_is_alive(pid: u32) -> bool {
    !matches!(probe_pid(pid), PidProbe::Gone | PidProbe::Zombie)
}

fn terminate_pid(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

fn force_kill_pid(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

/// 等待进程退出；已返回 true 表示确认退出，false 表示超时仍存活
fn wait_pid_gone(pid: u32, attempts: usize) -> bool {
    for _ in 0..attempts {
        if !pid_is_alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    !pid_is_alive(pid)
}

fn cleanup_stale_runtime(runtime_path: &PathBuf) -> Result<(), String> {
    let record = match fs::read_to_string(runtime_path) {
        Ok(contents) => serde_json::from_str::<AgentRuntimeRecord>(&contents).ok(),
        Err(_) => None,
    };

    if let Some(record) = record {
        match probe_pid(record.pid) {
            // 进程已退出或为僵尸：僵尸无法被信号终结，直接视为可清理
            PidProbe::Gone | PidProbe::Zombie => {}
            PidProbe::Foreign(command) => {
                // PID 已被无关进程复用：不动它，直接清掉过期记录继续启动
                eprintln!(
                    "[agent-runtime] 运行记录 PID {} 已被无关进程占用（{}），跳过清理",
                    record.pid,
                    command
                );
            }
            PidProbe::Ours => {
                terminate_pid(record.pid);
                if !wait_pid_gone(record.pid, 30) {
                    force_kill_pid(record.pid);
                    if !wait_pid_gone(record.pid, 30) {
                        return Err(format!("无法清理旧智能体进程（PID {}）", record.pid));
                    }
                }
            }
        }
    }

    fs::remove_file(runtime_path)
        .or_else(|error| if error.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(error) })
        .map_err(|error| format!("清理智能体运行记录失败：{error}"))
}

fn persist_runtime(runtime_path: &Path, child: &Child, port: u16, jar_path: &Path) -> Result<(), String> {
    let record = AgentRuntimeRecord {
        pid: child.id(),
        port,
        jar_path: jar_path.display().to_string(),
    };
    let temporary_path = runtime_path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(&record).map_err(|error| format!("写入智能体运行记录失败：{error}"))?;
    fs::write(&temporary_path, contents).map_err(|error| format!("写入智能体运行记录失败：{error}"))?;
    fs::rename(temporary_path, runtime_path).map_err(|error| format!("保存智能体运行记录失败：{error}"))
}

fn default_state(message: &str) -> ServiceState {
    ServiceState {
        status: "stopped".to_string(),
        port: None,
        jar_path: None,
        message: message.to_string(),
        runtime_status: "unknown".to_string(),
        runtime_source: None,
        java_path: None,
        java_version: None,
    }
}

fn state_with_runtime(
    status: &str,
    port: Option<u16>,
    jar_path: Option<String>,
    message: String,
    runtime: &RuntimeCheck,
) -> ServiceState {
    ServiceState {
        status: status.to_string(),
        port,
        jar_path,
        message,
        runtime_status: runtime.status.clone(),
        runtime_source: runtime.source.clone(),
        java_path: runtime.java_path.clone(),
        java_version: runtime.java_version.clone(),
    }
}

fn running_state(runtime: &AgentRuntime, message: String) -> ServiceState {
    ServiceState {
        status: "running".to_string(),
        port: Some(runtime.port),
        jar_path: Some(runtime.jar_path.display().to_string()),
        message,
        runtime_status: "ready".to_string(),
        runtime_source: Some(runtime.java_runtime.source.clone()),
        java_path: Some(runtime.java_runtime.path.display().to_string()),
        java_version: Some(runtime.java_runtime.version.clone()),
    }
}

/// Windows 上 Tauri resource_dir/app_data_dir 返回 `\\?\` 原义路径，
/// 传给 `java -jar` 后 Spring Boot 的 jar:file URL 解析会失败，必须还原为普通 Win32 路径。
fn plain_path(path: PathBuf) -> PathBuf {
    dunce::simplified(&path).to_path_buf()
}

fn locate_agent_jar(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("DSH_AGENT_JAR") {
        let path = plain_path(PathBuf::from(path));
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("DSH_AGENT_JAR 指向的文件不存在：{}", path.display()));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("agent/deepseek-harness-java-app.jar");
        if path.exists() {
            return Ok(plain_path(path));
        }
    }

    let development_jar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../deepseek-harness-java/deepseek-harness-java-app/target/deepseek-harness-java-app.jar");
    if development_jar.exists() {
        return Ok(development_jar);
    }

    Err("未找到智能体 JAR。请先执行 npm run agent:prepare，或设置 DSH_AGENT_JAR。".to_string())
}

fn runtime_java_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "java.exe"
    } else {
        "java"
    }
}

fn bundled_java_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("agent/runtime/bin").join(runtime_java_name());
        if path.is_file() {
            return Some(plain_path(path));
        }
    }

    let development_runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources/agent/runtime/bin")
        .join(runtime_java_name());
    development_runtime.is_file().then_some(development_runtime)
}

fn parse_java_version(output: &[u8]) -> Option<(String, u32)> {
    let text = String::from_utf8_lossy(output);
    let raw_version = text
        .split_once("version \"")
        .and_then(|(_, rest)| rest.split_once('"').map(|(version, _)| version.to_string()))
        .or_else(|| {
            text.split_whitespace()
                .map(|token| token.trim_matches(['"', '\'']))
                .find(|token| token.chars().next().is_some_and(|character| character.is_ascii_digit()))
                .map(ToString::to_string)
        })?;

    let major_text = raw_version
        .strip_prefix("1.")
        .unwrap_or(&raw_version)
        .split(['.', '-'])
        .next()?;
    let major = major_text.parse::<u32>().ok()?;
    Some((raw_version, major))
}

fn runtime_source_message(source: &str, version: &str, path: &str) -> String {
    match source {
        "bundled" => format!("已使用应用内置 Java {version} Runtime"),
        "custom" => format!("已使用 DSH_AGENT_JAVA 指定的 Java {version}"),
        _ => format!("未找到应用内置 Runtime，当前使用系统 Java {version}：{path}"),
    }
}

fn missing_runtime_check(message: &str) -> RuntimeCheck {
    RuntimeCheck {
        status: "missing".to_string(),
        source: None,
        java_path: None,
        java_version: None,
        message: message.to_string(),
        runtime: None,
    }
}

fn inspect_java(path: PathBuf, source: &str) -> RuntimeCheck {
    let java_path = path.display().to_string();
    let output = Command::new(&path).arg("-version").output();
    let output = match output {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RuntimeCheck {
                status: "missing".to_string(),
                source: Some(source.to_string()),
                java_path: (source != "system").then_some(java_path),
                java_version: None,
                message: "未检测到可用的 Java Runtime。发布版应包含应用内置 Java 17；请重新安装应用。".to_string(),
                runtime: None,
            };
        }
        Err(error) => {
            return RuntimeCheck {
                status: "invalid".to_string(),
                source: Some(source.to_string()),
                java_path: Some(java_path.clone()),
                java_version: None,
                message: format!("Java Runtime 无法启动：{java_path}（{error}）"),
                runtime: None,
            };
        }
    };

    let version_output = [output.stdout.as_slice(), output.stderr.as_slice()].concat();
    let parsed_version = parse_java_version(&version_output);
    let Some((version, major)) = parsed_version else {
        return RuntimeCheck {
            status: "invalid".to_string(),
            source: Some(source.to_string()),
            java_path: Some(java_path.clone()),
            java_version: None,
            message: format!("无法识别 Java Runtime 版本：{java_path}"),
            runtime: None,
        };
    };

    if !output.status.success() {
        return RuntimeCheck {
            status: "invalid".to_string(),
            source: Some(source.to_string()),
            java_path: Some(java_path.clone()),
            java_version: Some(version),
            message: format!("Java Runtime 启动检查失败：{java_path}"),
            runtime: None,
        };
    }

    if major < 17 {
        return RuntimeCheck {
            status: "too_old".to_string(),
            source: Some(source.to_string()),
            java_path: Some(java_path.clone()),
            java_version: Some(version.clone()),
            message: format!("检测到 Java {version}，智能体服务需要 Java 17 或更高版本。"),
            runtime: None,
        };
    }

    RuntimeCheck {
        status: "ready".to_string(),
        source: Some(source.to_string()),
        java_path: Some(java_path.clone()),
        java_version: Some(version.clone()),
        message: runtime_source_message(source, &version, &java_path),
        runtime: Some(JavaRuntime {
            path,
            source: source.to_string(),
            version,
        }),
    }
}

fn inspect_java_runtime(app: &tauri::AppHandle) -> RuntimeCheck {
    if let Ok(path) = std::env::var("DSH_AGENT_JAVA") {
        return inspect_java(PathBuf::from(path), "custom");
    }

    if let Some(path) = bundled_java_path(app) {
        return inspect_java(path, "bundled");
    }

    if cfg!(debug_assertions) {
        return inspect_java(PathBuf::from("java"), "system");
    }

    missing_runtime_check("发布包未包含应用内置 Java 17 Runtime，请重新运行 npm run agent:prepare 后构建。")
}

fn find_free_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .map(|listener| listener.local_addr().map(|addr| addr.port()).unwrap_or(8090))
        .map_err(|error| format!("分配端口失败：{error}"))
}

fn service_snapshot(app: &tauri::AppHandle, state: &State<AgentRuntimeState>) -> ServiceState {
    let mut guard = state.0.lock().unwrap();
    if let Some(runtime) = guard.as_mut() {
        if let Ok(Some(exit_status)) = runtime.child.try_wait() {
            let port = runtime.port;
            let jar_path = runtime.jar_path.display().to_string();
            let finished = guard.take();
            if let Some(finished) = finished {
                let _ = fs::remove_file(finished.runtime_path);
            }
            let runtime_check = inspect_java_runtime(app);
            return state_with_runtime(
                "stopped",
                Some(port),
                Some(jar_path),
                format!("智能体进程已退出：{exit_status}"),
                &runtime_check,
            );
        }
    }

    match guard.as_ref() {
        Some(runtime) => running_state(runtime, format!("HTTP 服务监听 127.0.0.1:{}", runtime.port)),
        None => {
            let runtime_check = inspect_java_runtime(app);
            state_with_runtime("stopped", None, None, "智能体服务未启动".to_string(), &runtime_check)
        }
    }
}

#[tauri::command]
fn start_agent(
    app: tauri::AppHandle,
    state: State<AgentRuntimeState>,
) -> Result<ServiceState, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(runtime) = guard.as_mut() {
        if let Ok(Some(_)) = runtime.child.try_wait() {
            guard.take();
        } else {
            return Ok(running_state(runtime, "智能体服务已在运行".to_string()));
        }
    }

    let runtime_check = inspect_java_runtime(&app);
    let java_runtime = runtime_check
        .runtime
        .clone()
        .ok_or_else(|| runtime_check.message.clone())?;
    let jar_path = locate_agent_jar(&app)?;
    let port = find_free_port()?;
    let data_dir = plain_path(
        app.path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录：{error}"))?,
    );
    std::fs::create_dir_all(&data_dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
    let runtime_path = data_dir.join("agent-runtime.json");
    cleanup_stale_runtime(&runtime_path)?;
    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|error| format!("创建日志目录失败：{error}"))?;
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("agent.log"))
        .map_err(|error| format!("打开日志文件失败：{error}"))?;

    let database_url = format!(
        "jdbc:h2:file:{};MODE=MySQL;CASE_INSENSITIVE_IDENTIFIERS=TRUE;AUTO_SERVER=TRUE",
        data_dir.join("deepseek-harness-java").display()
    );

    let child = Command::new(&java_runtime.path)
        .arg(format!("-Dserver.port={port}"))
        .arg("-jar")
        .arg(&jar_path)
        .arg("--spring.profiles.active=standalone")
        .arg(format!("--spring.datasource.url={database_url}"))
        .arg("--spring.datasource.username=sa")
        .arg("--spring.datasource.password=")
        .current_dir(&data_dir)
        .stdout(Stdio::from(log_file.try_clone().map_err(|error| format!("复制日志句柄失败：{error}"))?))
        .stderr(Stdio::from(log_file))
        .spawn()
        .map_err(|error| format!("启动 JAR 失败（Java {}）：{error}", java_runtime.version))?;

    if let Err(error) = persist_runtime(&runtime_path, &child, port, &jar_path) {
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    *guard = Some(AgentRuntime {
        child,
        port,
        jar_path: jar_path.clone(),
        runtime_path,
        java_runtime: java_runtime.clone(),
    });

    Ok(ServiceState {
        status: "running".to_string(),
        port: Some(port),
        jar_path: Some(jar_path.display().to_string()),
        message: "进程已启动，等待 HTTP 健康检查".to_string(),
        runtime_status: runtime_check.status,
        runtime_source: runtime_check.source,
        java_path: runtime_check.java_path,
        java_version: runtime_check.java_version,
    })
}

#[tauri::command]
fn stop_agent(state: State<AgentRuntimeState>) -> Result<ServiceState, String> {
    shutdown_runtime(&state);
    Ok(default_state("智能体服务已停止"))
}

#[tauri::command]
fn agent_status(app: tauri::AppHandle, state: State<AgentRuntimeState>) -> ServiceState {
    service_snapshot(&app, &state)
}

#[tauri::command]
fn project_git_branch(path: String) -> Result<GitBranchState, String> {
    let workspace = PathBuf::from(&path);
    if !workspace.is_dir() {
        return Err(format!("项目目录不存在：{path}"));
    }

    let inside = Command::new("git")
        .args(["-C", &path, "rev-parse", "--is-inside-work-tree"])
        .output()
        .map_err(|error| format!("读取 Git 状态失败：{error}"))?;
    if !inside.status.success() {
        return Ok(GitBranchState {
            branch: "未初始化 Git".to_string(),
            detached: false,
        });
    }

    let branch_output = Command::new("git")
        .args(["-C", &path, "branch", "--show-current"])
        .output()
        .map_err(|error| format!("读取 Git 分支失败：{error}"))?;
    let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();
    if !branch.is_empty() {
        return Ok(GitBranchState { branch, detached: false });
    }

    let revision = Command::new("git")
        .args(["-C", &path, "rev-parse", "--short", "HEAD"])
        .output()
        .map_err(|error| format!("读取 Git 提交失败：{error}"))?;
    let revision = String::from_utf8_lossy(&revision.stdout).trim().to_string();
    Ok(GitBranchState {
        branch: if revision.is_empty() { "HEAD".to_string() } else { format!("HEAD · {revision}") },
        detached: true,
    })
}

#[tauri::command]
fn project_git_branches(path: String) -> Result<GitBranchesState, String> {
    read_git_branches(&path)
}

#[tauri::command]
fn switch_project_git_branch(path: String, branch: String) -> Result<GitBranchesState, String> {
    if !PathBuf::from(&path).is_dir() {
        return Err(format!("项目目录不存在：{path}"));
    }
    if branch.trim().is_empty() || branch.starts_with('-') {
        return Err("无效的 Git 分支".to_string());
    }

    let checkout = Command::new("git")
        .args(["-C", &path, "checkout", &branch])
        .output()
        .map_err(|error| format!("切换 Git 分支失败：{error}"))?;
    if !checkout.status.success() {
        return Err(String::from_utf8_lossy(&checkout.stderr).trim().to_string());
    }

    read_git_branches(&path)
}

fn read_git_branches(path: &str) -> Result<GitBranchesState, String> {
    if !PathBuf::from(path).is_dir() {
        return Err(format!("项目目录不存在：{path}"));
    }

    let inside = Command::new("git")
        .args(["-C", path, "rev-parse", "--is-inside-work-tree"])
        .output()
        .map_err(|error| format!("读取 Git 状态失败：{error}"))?;
    if !inside.status.success() {
        return Ok(GitBranchesState { current: String::new(), branches: Vec::new() });
    }

    let branch_output = Command::new("git")
        .args(["-C", path, "branch", "--show-current"])
        .output()
        .map_err(|error| format!("读取 Git 分支失败：{error}"))?;
    let current = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();
    if current.is_empty() {
        return Ok(GitBranchesState { current: String::new(), branches: Vec::new() });
    }

    let list_output = Command::new("git")
        .args(["-C", path, "branch", "--format=%(refname:short)"])
        .output()
        .map_err(|error| format!("读取 Git 分支列表失败：{error}"))?;
    if !list_output.status.success() {
        return Err(String::from_utf8_lossy(&list_output.stderr).trim().to_string());
    }

    let mut branches = String::from_utf8_lossy(&list_output.stdout)
        .lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    branches.sort();
    branches.dedup();

    Ok(GitBranchesState { current, branches })
}

#[tauri::command]
fn project_git_changes(path: String) -> Result<GitChangeSummary, String> {
    let mut summary = GitChangeSummary::default();
    if !PathBuf::from(&path).is_dir() {
        return Err(format!("项目目录不存在：{path}"));
    }

    let inside = Command::new("git")
        .args(["-C", &path, "rev-parse", "--is-inside-work-tree"])
        .output()
        .map_err(|error| format!("读取 Git 状态失败：{error}"))?;
    if !inside.status.success() {
        return Ok(summary);
    }
    summary.is_repo = true;

    let branch_output = Command::new("git")
        .args(["-C", &path, "branch", "--show-current"])
        .output()
        .map_err(|error| format!("读取 Git 分支失败：{error}"))?;
    summary.branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();

    // 已跟踪文件的增删行（工作区 + 暂存区，相对 HEAD）
    let numstat = Command::new("git")
        .args(["-C", &path, "diff", "HEAD", "--numstat"])
        .output()
        .map_err(|error| format!("读取 Git 变更失败：{error}"))?;
    let mut changed: std::collections::HashMap<String, (u64, u64)> = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&numstat.stdout).lines() {
        let mut parts = line.split('\t');
        let (Some(add), Some(del), Some(file)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let insertions = add.parse::<u64>().unwrap_or(0);
        let deletions = del.parse::<u64>().unwrap_or(0);
        summary.insertions += insertions;
        summary.deletions += deletions;
        changed.insert(file.to_string(), (insertions, deletions));
    }

    // 文件状态（M/A/D/R/untracked）
    let status = Command::new("git")
        .args(["-C", &path, "status", "--porcelain=v1"])
        .output()
        .map_err(|error| format!("读取 Git 状态失败：{error}"))?;
    let mut untracked: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&status.stdout).lines() {
        if line.len() < 4 {
            continue;
        }
        let code = &line[..2];
        let raw_path = line[3..].trim();
        // 重命名格式 "old -> new"，取新路径
        let file_path = raw_path.rsplit(" -> ").next().unwrap_or(raw_path);
        let status_code = if code == "??" {
            "A".to_string()
        } else if code.contains('D') {
            "D".to_string()
        } else if code.contains('R') {
            "R".to_string()
        } else if code.contains('A') {
            "A".to_string()
        } else {
            "M".to_string()
        };
        if code == "??" {
            // 未跟踪文件计入真实行数（视为全部新增）
            let full = PathBuf::from(&path).join(file_path);
            if full.is_file() {
                let lines = fs::read(&full)
                    .map(|bytes| bytes.iter().filter(|byte| **byte == b'\n').count() as u64 + 1)
                    .unwrap_or(0);
                summary.insertions += lines;
                summary.files.push(GitChangedFile {
                    status: status_code,
                    path: file_path.to_string(),
                    insertions: Some(lines),
                    deletions: None,
                });
                continue;
            }
            untracked.push(file_path.to_string());
            continue;
        }
        let (insertions, deletions) = changed.get(file_path).copied().unwrap_or((0, 0));
        summary.files.push(GitChangedFile {
            status: status_code,
            path: file_path.to_string(),
            insertions: Some(insertions),
            deletions: Some(deletions),
        });
    }
    for file_path in untracked {
        summary.files.push(GitChangedFile {
            status: "A".to_string(),
            path: file_path,
            insertions: None,
            deletions: None,
        });
    }

    // 变更多的排前面
    summary.files.sort_by(|a, b| {
        (b.insertions.unwrap_or(0) + b.deletions.unwrap_or(0))
            .cmp(&(a.insertions.unwrap_or(0) + a.deletions.unwrap_or(0)))
    });

    Ok(summary)
}

// ── 文件渲染：读取本地文件内容（md/word/excel 等） ──────────

/// 读取本地文本文件（md/txt/csv 等），大小限制 8MB，避免 UI 卡死。
#[tauri::command]
fn read_local_text_file(path: String) -> Result<String, String> {
    let file = resolve_preview_file(&path);
    if !file.is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let meta = fs::metadata(&file).map_err(|error| format!("读取文件信息失败：{error}"))?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("文件过大（超过 8MB），不支持预览".to_string());
    }
    fs::read_to_string(&file).map_err(|error| format!("读取文件失败：{error}"))
}

/// 写入本地文本文件（draw.io 编辑保存等），内容上限 8MB；父目录不存在时自动创建。
#[tauri::command]
fn write_local_text_file(path: String, contents: String) -> Result<(), String> {
    if contents.len() > 8 * 1024 * 1024 {
        return Err("内容过大（超过 8MB），不支持写盘".to_string());
    }
    let file = resolve_preview_file(&path);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    fs::write(&file, contents).map_err(|error| format!("写入文件失败：{error}"))
}

/// 读取本地二进制文件（docx/xlsx/pdf 等），返回 Base64，大小限制 50MB。
#[tauri::command]
fn read_local_file_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    let file = resolve_preview_file(&path);
    if !file.is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let meta = fs::metadata(&file).map_err(|error| format!("读取文件信息失败：{error}"))?;
    if meta.len() > 50 * 1024 * 1024 {
        return Err("文件过大（超过 50MB），不支持预览".to_string());
    }
    let mut handle = fs::File::open(&file).map_err(|error| format!("打开文件失败：{error}"))?;
    let mut buffer = Vec::with_capacity(meta.len() as usize);
    handle
        .read_to_end(&mut buffer)
        .map_err(|error| format!("读取文件失败：{error}"))?;
    Ok(base64_encode(&buffer))
}

/// 批量检查本地文件是否仍然存在，用于过滤对话历史里已失效的临时文件路径。
#[tauri::command]
fn existing_local_files(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| resolve_preview_file(path).is_file())
        .collect()
}

/// 批量读取本地文件大小（字节），与入参顺序对齐；不存在的文件对应 null。
#[tauri::command]
fn local_file_metas(paths: Vec<String>) -> Vec<Option<u64>> {
    paths
        .into_iter()
        .map(|path| resolve_preview_file(&path).metadata().ok().map(|meta| meta.len()))
        .collect()
}

/// 批量判断路径类型（"file" | "dir"），与入参顺序对齐；不存在或不可访问对应 null。
/// 用于消息尾部文件产物标签：区分文件 / 文件夹 / 失效路径，决定点击行为与图标。
#[tauri::command]
fn local_path_kinds(paths: Vec<String>) -> Vec<Option<String>> {
    paths
        .into_iter()
        .map(|path| {
            let resolved = resolve_preview_file(&path);
            if resolved.is_file() {
                Some("file".to_string())
            } else if resolved.is_dir() {
                Some("dir".to_string())
            } else {
                None
            }
        })
        .collect()
}

/// 列出目录的单层内容（信息面板工程目录树用）。
/// 设计取向是"快"：只读一层、目录优先排序、默认跳过隐藏文件（.git/node_modules 之外的
/// 隐藏项也一并跳过）、条目超上限截断并标记——避免大目录（如 node_modules）一次拉爆 webview。
#[derive(serde::Serialize)]
struct DirEntryItem {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

#[derive(serde::Serialize)]
struct DirListing {
    entries: Vec<DirEntryItem>,
    /// 实际条目数超出上限被截断
    truncated: bool,
    total: usize,
}

#[tauri::command]
fn list_directory(path: String, show_hidden: bool) -> Result<DirListing, String> {
    const MAX_ENTRIES: usize = 500;

    let mut dirs: Vec<DirEntryItem> = Vec::new();
    let mut files: Vec<DirEntryItem> = Vec::new();
    let mut total = 0usize;

    let read_dir = std::fs::read_dir(&path).map_err(|error| format!("读取目录失败：{error}"))?;
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        total += 1;
        if dirs.len() + files.len() >= MAX_ENTRIES {
            continue; // 继续计数 total，方便前端提示"还有 N 项未显示"
        }
        let Ok(file_type) = entry.file_type() else { continue };
        let is_dir = file_type.is_dir();
        let size = if is_dir {
            0
        } else {
            entry.metadata().map(|meta| meta.len()).unwrap_or(0)
        };
        let item = DirEntryItem {
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            size,
        };
        if is_dir {
            dirs.push(item);
        } else {
            files.push(item);
        }
    }

    let collate = |a: &DirEntryItem, b: &DirEntryItem| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(collate);
    files.sort_by(collate);
    dirs.extend(files);

    let truncated = total > dirs.len();
    Ok(DirListing {
        truncated,
        total,
        entries: dirs,
    })
}

/// 预览路径兜底：Agent 有时会把用户主目录下的文件写成 `/Desktop/foo.html`。
/// 不改变对外展示的原路径，只在本机读取时尝试映射到 `$HOME/Desktop/foo.html`。
fn resolve_preview_file(path: &str) -> PathBuf {
    let direct = if let Some(rest) = path.strip_prefix("~/") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(path))
    } else {
        PathBuf::from(path)
    };
    if direct.is_file() {
        return direct;
    }

    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return direct;
    };
    for prefix in ["/Desktop/", "/Downloads/", "/Documents/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            let mapped = home.join(prefix.trim_matches('/')).join(rest);
            if mapped.is_file() {
                return mapped;
            }
        }
    }
    direct
}

/// 轻量 Base64 编码（避免为单一命令引入依赖）
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[tauri::command]
fn send_notification(title: String, body: String) -> Result<(), String> {    notify_rust::Notification::new()
        .summary(&title)
        .body(&body)
        .appname("DSH Java Desktop")
        .show()
        .map(|_| ())
        .map_err(|error| format!("发送系统通知失败：{error}"))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let lower = url.trim().to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("仅支持打开 http/https 链接".to_string());
    }

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).status();
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd").args(["/C", "start", "", &url]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&url).status();

    result
        .map_err(|error| format!("调用系统浏览器失败：{error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("系统浏览器返回错误状态：{status}"))
            }
        })
}

// ── 生成文件的系统级操作（右键菜单：打开 / 打开文件夹 / 另存为） ──

/// 用系统默认程序打开本地文件（与预览一致的路径解析规则）；目录则交给文件管理器打开
#[tauri::command]
fn open_local_file(path: String) -> Result<(), String> {
    let file = resolve_preview_file(&path);
    if !file.exists() {
        return Err(format!("文件不存在或不可访问：{path}"));
    }

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&file).status();
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd").args(["/C", "start", ""]).arg(&file).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&file).status();

    result
        .map_err(|error| format!("调用系统程序打开文件失败：{error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("系统程序返回错误状态：{status}"))
            }
        })
}

/// 在文件管理器中显示文件（macOS Finder 定位到文件本身）
#[tauri::command]
fn reveal_local_file(path: String) -> Result<(), String> {
    let file = resolve_preview_file(&path);
    if !file.exists() {
        return Err(format!("文件不存在或不可访问：{path}"));
    }

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(&file).status();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg(format!("/select,{}", file.display())).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = {
        let parent = file
            .parent()
            .map(|parent| parent.to_path_buf())
            .unwrap_or_else(|| file.clone());
        Command::new("xdg-open").arg(&parent).status()
    };

    result
        .map_err(|error| format!("打开文件所在文件夹失败：{error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("文件管理器返回错误状态：{status}"))
            }
        })
}

/// 弹出系统「另存为」对话框，把生成文件复制到用户选择的位置；取消时返回 None
#[tauri::command]
fn save_local_file_as(path: String) -> Result<Option<String>, String> {
    let source = resolve_preview_file(&path);
    if !source.is_file() {
        return Err(format!("文件不存在或不可访问：{path}"));
    }
    let mut dialog = rfd::FileDialog::new().set_title("另存为");
    if let Some(name) = source.file_name() {
        dialog = dialog.set_file_name(name.to_string_lossy().as_ref());
    }
    let Some(target) = dialog.save_file() else {
        return Ok(None);
    };
    fs::copy(&source, &target).map_err(|error| format!("保存文件失败：{error}"))?;
    Ok(Some(target.to_string_lossy().to_string()))
}

// ── 数字人凭据安全存储 ─────────────────────────────────────
// 凭据（远端 Token）只写入应用数据目录下权限 0600 的独立文件，
// 业务表/事件流/日志里只出现 credentialRef，永不出现明文。

fn credentials_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
    Ok(dir.join("digital-human-credentials.json"))
}

fn read_credential_map(app: &tauri::AppHandle) -> Result<std::collections::HashMap<String, String>, String> {
    let path = credentials_path(app)?;
    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|error| format!("读取凭据存储失败：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(std::collections::HashMap::new()),
        Err(error) => Err(format!("读取凭据存储失败：{error}")),
    }
}

fn write_credential_map(app: &tauri::AppHandle, map: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let path = credentials_path(app)?;
    let contents = serde_json::to_vec_pretty(map).map_err(|error| format!("序列化凭据失败：{error}"))?;
    fs::write(&path, contents).map_err(|error| format!("写入凭据存储失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn save_credential(app: tauri::AppHandle, credential_ref: String, secret: String) -> Result<(), String> {
    if credential_ref.trim().is_empty() {
        return Err("credentialRef 不能为空".to_string());
    }
    let mut map = read_credential_map(&app)?;
    if secret.trim().is_empty() {
        map.remove(&credential_ref);
    } else {
        map.insert(credential_ref, secret);
    }
    write_credential_map(&app, &map)
}

#[tauri::command]
fn read_credential(app: tauri::AppHandle, credential_ref: String) -> Result<Option<String>, String> {
    Ok(read_credential_map(&app)?.get(&credential_ref).cloned())
}

#[tauri::command]
fn delete_credential(app: tauri::AppHandle, credential_ref: String) -> Result<(), String> {
    let mut map = read_credential_map(&app)?;
    map.remove(&credential_ref);
    write_credential_map(&app, &map)
}

#[tauri::command]
fn pick_local_directory() -> Vec<WorkspaceSelection> {
    rfd::FileDialog::new()
        .set_title("选择本地项目目录")
        .pick_folders()
        .unwrap_or_default()
        .into_iter()
        .map(|selected| {
            let path = selected.to_string_lossy().to_string();
            let name = selected
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            WorkspaceSelection { name, path }
        })
        .collect()
}

#[tauri::command]
fn pick_local_file() -> Option<LocalFileSelection> {
    rfd::FileDialog::new()
        .set_title("选择资源文件")
        .pick_file()
        .map(|selected| {
            let path = selected.to_string_lossy().to_string();
            let name = selected
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let mime_type = mime_type_for_path(&selected);
            LocalFileSelection { name, path, mime_type }
        })
}

fn mime_type_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// 显示并聚焦主窗口（托盘菜单 / Dock 点击 / 左键单击托盘共用）
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 创建系统托盘：左键单击切换显示/隐藏，菜单提供「打开」与「退出」。
/// 关闭窗口不会退出应用（见 on_window_event），真正退出只会走托盘「退出」
/// 或系统退出，ExitRequested 时统一回收智能体 Java 进程。
fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "打开 DSH Java Desktop", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("应用图标未配置").clone())
        .tooltip("DSH Java Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let visible = app
                    .get_webview_window("main")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                if visible {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                } else {
                    show_main_window(app);
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AgentRuntimeState(Mutex::new(None)))
        .plugin(tauri_plugin_http::init())
        .plugin(process_plugin())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(setup_tray)
        .on_window_event(|window, event| {
            // 点击红色叉号：不退出，仅隐藏窗口到托盘（后端 Java 服务保持运行）
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![start_agent, stop_agent, agent_status, project_git_branch, project_git_branches, switch_project_git_branch, project_git_changes, pick_local_directory, pick_local_file, send_notification, open_external, open_local_file, reveal_local_file, save_local_file_as, save_credential, read_credential, delete_credential, read_local_text_file, write_local_text_file, read_local_file_base64, existing_local_files, local_file_metas, local_path_kinds, list_directory])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    let handle = app.handle().clone();
    app.run(move |app, event| {
        match event {
            RunEvent::ExitRequested { .. } => {
                shutdown_runtime(handle.state::<AgentRuntimeState>().inner());
            }
            // macOS：窗口隐藏后点击 Dock 图标重新显示（RunEvent::Reopen 仅在 tauri 2.1+ / macOS 存在）
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
        }
    });
}
