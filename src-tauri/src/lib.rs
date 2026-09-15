use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, RunEvent, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceState {
    status: String,
    port: Option<u16>,
    jar_path: Option<String>,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchState {
    branch: String,
    detached: bool,
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
}

struct AgentRuntimeState(Mutex<Option<AgentRuntime>>);

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

fn find_free_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .map(|listener| listener.local_addr().map(|addr| addr.port()).unwrap_or(8090))
        .map_err(|error| format!("分配端口失败：{error}"))
}

fn service_snapshot(state: &State<AgentRuntimeState>) -> ServiceState {
    let mut guard = state.0.lock().unwrap();
    if let Some(runtime) = guard.as_mut() {
        if let Ok(Some(exit_status)) = runtime.child.try_wait() {
            let port = runtime.port;
            let jar_path = runtime.jar_path.display().to_string();
            let finished = guard.take();
            if let Some(finished) = finished {
                let _ = fs::remove_file(finished.runtime_path);
            }
            return ServiceState {
                status: "stopped".to_string(),
                port: Some(port),
                jar_path: Some(jar_path),
                message: format!("智能体进程已退出：{exit_status}"),
            };
        }
    }

    match guard.as_ref() {
        Some(runtime) => ServiceState {
            status: "running".to_string(),
            port: Some(runtime.port),
            jar_path: Some(runtime.jar_path.display().to_string()),
            message: format!("HTTP 服务监听 127.0.0.1:{}", runtime.port),
        },
        None => default_state("智能体服务未启动"),
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
            let port = runtime.port;
            return Ok(ServiceState {
                status: "running".to_string(),
                port: Some(port),
                jar_path: Some(runtime.jar_path.display().to_string()),
                message: "智能体服务已在运行".to_string(),
            });
        }
    }

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
        "jdbc:h2:file:{};MODE=MySQL;CASE_INSENSITIVE_IDENTIFIERS=TRUE",
        data_dir.join("deepseek-harness-java").display()
    );

    let java = std::env::var("DSH_AGENT_JAVA").unwrap_or_else(|_| "java".to_string());
    let child = Command::new(java)
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
        .map_err(|error| format!("启动 JAR 失败：{error}"))?;

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
    });

    Ok(ServiceState {
        status: "running".to_string(),
        port: Some(port),
        jar_path: Some(jar_path.display().to_string()),
        message: "进程已启动，等待 HTTP 健康检查".to_string(),
    })
}

#[tauri::command]
fn stop_agent(state: State<AgentRuntimeState>) -> Result<ServiceState, String> {
    shutdown_runtime(&state);
    Ok(default_state("智能体服务已停止"))
}

#[tauri::command]
fn agent_status(state: State<AgentRuntimeState>) -> ServiceState {
    service_snapshot(&state)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AgentRuntimeState(Mutex::new(None)))
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![start_agent, stop_agent, agent_status, project_git_branch])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    let handle = app.handle().clone();
    app.run(move |_app, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            shutdown_runtime(handle.state::<AgentRuntimeState>().inner());
        }
    });
}
