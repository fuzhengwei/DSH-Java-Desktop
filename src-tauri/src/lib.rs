use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, RunEvent, State};
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

fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
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

fn cleanup_stale_runtime(runtime_path: &PathBuf) -> Result<(), String> {
    let record = match fs::read_to_string(runtime_path) {
        Ok(contents) => serde_json::from_str::<AgentRuntimeRecord>(&contents).ok(),
        Err(_) => None,
    };

    if let Some(record) = record {
        if pid_is_alive(record.pid) {
            terminate_pid(record.pid);
            for _ in 0..30 {
                if !pid_is_alive(record.pid) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            if pid_is_alive(record.pid) {
                return Err(format!("无法清理旧智能体进程（PID {}）", record.pid));
            }
        }
    }

    fs::remove_file(runtime_path)
        .or_else(|error| if error.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(error) })
        .map_err(|error| format!("清理智能体运行记录失败：{error}"))
}

fn persist_runtime(runtime_path: &PathBuf, child: &Child, port: u16, jar_path: &PathBuf) -> Result<(), String> {
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

fn locate_agent_jar(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("DSH_AGENT_JAR") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("DSH_AGENT_JAR 指向的文件不存在：{}", path.display()));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("agent/deepseek-harness-java-app.jar");
        if path.exists() {
            return Ok(path);
        }
    }

    let development_jar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../deepseek-harness-java/deepseek-harness-java-app/target/deepseek-harness-java-app-0.1.6.jar");
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
            return Some(path);
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
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AgentRuntimeState(Mutex::new(None)))
        .plugin(tauri_plugin_http::init())
        .plugin(process_plugin())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![start_agent, stop_agent, agent_status, project_git_branch, project_git_branches, switch_project_git_branch, project_git_changes, pick_local_directory, send_notification, open_external, save_credential, read_credential, delete_credential, read_local_text_file, read_local_file_base64, existing_local_files])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    let handle = app.handle().clone();
    app.run(move |_app, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            shutdown_runtime(handle.state::<AgentRuntimeState>().inner());
        }
    });
}
