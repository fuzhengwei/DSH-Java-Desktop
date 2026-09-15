import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationView from "./components/ConversationView";
import Sidebar, { type WorkspaceView } from "./components/Sidebar";
import SettingsView from "./components/SettingsView";
import InfoPanel from "./components/InfoPanel";
import {
  activateModelSetting,
  deleteModelSetting,
  discoverModels,
  listAvailableModels,
  listChannelPresets,
  listMessages,
  listModelSettings,
  listPlugins,
  listRuntimeApprovals,
  listSessions,
  listWorkspaces,
  createWorkspace,
  resolveRuntimeApproval,
  saveModelSetting,
  streamAgentMessage,
  waitForService,
} from "./lib/agent-client";
import type {
  AgentServiceState,
  ApprovalMode,
  AvailableModel,
  ChannelPreset,
  ConversationMessage,
  ModelDraft,
  ModelSetting,
  PluginSummary,
  RuntimeApproval,
  SessionSummary,
  WorkspaceEntry,
  GitBranchState,
} from "./types";

const emptyModelDraft: ModelDraft = {
  displayName: "",
  providerCode: "",
  modelCode: "",
  baseUrl: "",
  apiKeyRef: "",
  protocol: "openai",
  enabled: true,
};

function newSessionId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  if (typeof record.message === "string") return record.message;
  return "";
}

function sessionTitle(session: SessionSummary): string {
  return session.title || session.lastMessage || session.agentId || session.sessionId || "新对话";
}

export default function App() {
  const [activeView, setActiveView] = useState<WorkspaceView>("conversation");
  const [service, setService] = useState<AgentServiceState | null>(null);
  const [serviceStatus, setServiceStatus] = useState<"checking" | "stopped" | "running" | "starting">("checking");
  const [error, setError] = useState("");
  const [serviceError, setServiceError] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<WorkspaceEntry[]>([]);
  const [activeProjectPath, setActiveProjectPath] = useState("");
  const [sessionProjectMap, setSessionProjectMap] = useState<Record<string, string>>({});
  const [activeSessionId, setActiveSessionId] = useState(newSessionId());
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [approvals, setApprovals] = useState<RuntimeApproval[]>([]);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [modelSettings, setModelSettings] = useState<ModelSetting[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [presets, setPresets] = useState<ChannelPreset[]>([]);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModelDraft);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [savingModel, setSavingModel] = useState(false);
  const [syncingModels, setSyncingModels] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("REQUEST_APPROVAL");
  const [showReasoning, setShowReasoning] = useState(true);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [gitBranch, setGitBranch] = useState<GitBranchState | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const port = service?.port ?? null;
  const serviceReady = serviceStatus === "running" && Boolean(port);
  const activeSession = sessions.find((session) => session.agentId === activeSessionId);
  const activeModel = useMemo(() => {
    const activeChannelCode = modelSettings.find((model) => model.active)?.channelCode;
    const activeSetting = modelSettings.find((model) => model.channelCode === activeChannelCode);
    if (activeSetting) {
      return {
        channelCode: activeSetting.channelCode,
        displayName: activeSetting.displayName,
        providerCode: activeSetting.providerCode,
        modelCode: activeSetting.modelCode,
      };
    }
    return availableModels.find((model) => model.channelCode && model.modelCode) || availableModels[0];
  }, [availableModels, modelSettings]);

  const loadWorkspaceData = useCallback(async (servicePort: number, focusModelsIfEmpty = false) => {
    const [sessionsResult, projectsResult, approvalsResult, pluginsResult, modelSettingsResult, runtimeModelsResult, presetsResult] =
      await Promise.allSettled([
        listSessions(servicePort),
        listWorkspaces(servicePort),
        listRuntimeApprovals(servicePort),
        listPlugins(servicePort),
        listModelSettings(servicePort),
        listAvailableModels(servicePort),
        listChannelPresets(servicePort),
      ]);

    if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value);
    if (projectsResult.status === "fulfilled") {
      setProjects(projectsResult.value);
      setActiveProjectPath((current) => current || projectsResult.value[0]?.path || "");
    }
    if (approvalsResult.status === "fulfilled") setApprovals(approvalsResult.value);
    if (pluginsResult.status === "fulfilled") setPlugins(pluginsResult.value);
    if (presetsResult.status === "fulfilled") setPresets(presetsResult.value);

    const loadedModels = modelSettingsResult.status === "fulfilled" ? modelSettingsResult.value : [];
    const loadedRuntimeModels = runtimeModelsResult.status === "fulfilled" ? runtimeModelsResult.value : [];
    setModelSettings(loadedModels);
    setAvailableModels(loadedRuntimeModels);

    if (focusModelsIfEmpty && loadedModels.length === 0) {
      setActiveView("settings");
    }
  }, []);

  useEffect(() => {
    setSessionProjectMap(JSON.parse(localStorage.getItem("dsh-session-project-map") || "{}"));
  }, []);

  useEffect(() => {
    localStorage.setItem("dsh-session-project-map", JSON.stringify(sessionProjectMap));
  }, [sessionProjectMap]);

  const startService = useCallback(async () => {
    setError("");
    setServiceStatus("starting");
    let lastError = "智能体服务启动失败";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const state = await invoke<AgentServiceState>("start_agent");
        if (!state.port) throw new Error(state.message || "服务启动失败");
        setService(state);
        await waitForService(state.port);
        setServiceStatus("running");
        setServiceError("");
        await loadWorkspaceData(state.port, true);
        return;
      } catch (caught) {
        lastError = caught instanceof Error ? caught.message : String(caught);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    setServiceStatus("stopped");
    setServiceError(lastError);
  }, [loadWorkspaceData]);

  useEffect(() => {
    const autoStartKey = "__dsh_auto_start__";
    if ((window as unknown as Record<string, boolean>)[autoStartKey]) return;
    (window as unknown as Record<string, boolean>)[autoStartKey] = true;
    void startService();
  }, [startService]);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!activeProjectPath) {
      setGitBranch(null);
      return;
    }
    void invoke<GitBranchState>("project_git_branch", { path: activeProjectPath })
      .then(setGitBranch)
      .catch(() => setGitBranch(null));
  }, [activeProjectPath]);

  const selectSession = useCallback(async (sessionId: string) => {
    setActiveSessionId(sessionId);
    setActiveView("conversation");
    if (!port) return;
    try {
      setMessages(await listMessages(port, sessionId));
    } catch {
      setMessages([]);
    }
  }, [port]);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!port || !text || streaming) return;
    if (!activeModel) {
      setActiveView("settings");
      setError("请先配置并激活一个可用模型");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setError("");
    setDraft("");

    const userMessage: ConversationMessage = { role: "user", content: text };
    const assistantMessage: ConversationMessage = { role: "assistant", content: "", reasoning: "" };
    setMessages((current) => [...current, userMessage, assistantMessage]);

    try {
      await streamAgentMessage(
        port,
        {
          agentId: activeSessionId,
          message: text,
          channelCode: activeModel.channelCode,
          cwd: activeProjectPath || undefined,
          approvalMode,
        },
        (event) => {
          if (event.type === "chunk" || event.type === "reasoning") {
            const delta = payloadText(event.payload);
            setMessages((current) => {
              const next = [...current];
              const target = next[next.length - 1];
              if (target?.role === "assistant") {
                if (event.type === "chunk") target.content += delta;
                else target.reasoning = (target.reasoning || "") + delta;
              }
              return next;
            });
          } else if (event.type === "error") {
            throw new Error(payloadText(event.payload) || "智能体返回错误");
          }
        },
        controller.signal,
      );
      setSessionProjectMap((current) => ({
        ...current,
        [activeSessionId]: activeProjectPath,
      }));
      await loadWorkspaceData(port);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [activeModel, activeProjectPath, activeSessionId, draft, loadWorkspaceData, port, streaming]);

  const createProject = useCallback(async () => {
    const name = projectName.trim();
    if (!port || !name || creatingProject) return;
    setCreatingProject(true);
    setError("");
    try {
      const latest = await createWorkspace(port, name);
      setProjects(latest);
      setActiveProjectPath(latest.find((project) => project.name === name)?.path || latest[0]?.path || "");
      setProjectModalOpen(false);
      setProjectName("");
      setActiveView("conversation");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreatingProject(false);
    }
  }, [creatingProject, port, projectName]);

  const applyPreset = useCallback((preset: ChannelPreset) => {
    setModelDraft((current) => ({
      ...current,
      displayName: current.displayName || preset.displayName || "",
      providerCode: preset.id,
      baseUrl: preset.baseUrl || "",
      protocol: preset.protocol || "openai",
      modelCode: preset.modelSuggestions?.[0] || "",
    }));
  }, []);

  const syncAvailableModels = useCallback(async () => {
    if (!port) return;
    if (!modelDraft.baseUrl.trim()) {
      setError("同步模型前请先填写 Base URL");
      return;
    }
    setSyncingModels(true);
    setError("");
    try {
      const models = await discoverModels(port, {
        baseUrl: modelDraft.baseUrl.trim(),
        apiKeyRef: modelDraft.apiKeyRef.trim(),
        protocol: modelDraft.protocol,
      });
      setDiscoveredModels(models);
      if (models.length > 0 && !modelDraft.modelCode) {
        setModelDraft((current) => ({ ...current, modelCode: models[0] }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSyncingModels(false);
    }
  }, [modelDraft, port]);

  const submitModel = useCallback(async () => {
    if (!port) return;
    if (!modelDraft.displayName.trim()) {
      setError("请填写渠道名称");
      return;
    }
    if (!modelDraft.modelCode.trim()) {
      setError("请选择或输入模型");
      return;
    }

    setSavingModel(true);
    setError("");
    try {
      const saved = await saveModelSetting(port, { ...modelDraft });
      if (saved.channelCode) {
        await activateModelSetting(port, saved.channelCode);
      }
      setModelDraft(emptyModelDraft);
      setDiscoveredModels([]);
      await loadWorkspaceData(port, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingModel(false);
    }
  }, [loadWorkspaceData, modelDraft, port]);

  const activateModel = useCallback(async (channelCode: string) => {
    if (!port || !channelCode) return;
    setError("");
    try {
      await activateModelSetting(port, channelCode);
      await loadWorkspaceData(port);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadWorkspaceData, port]);

  const removeModel = useCallback(async (channelCode: string) => {
    if (!port || !channelCode) return;
    setError("");
    try {
      await deleteModelSetting(port, channelCode);
      if (modelDraft.channelCode === channelCode) setModelDraft(emptyModelDraft);
      await loadWorkspaceData(port, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadWorkspaceData, modelDraft.channelCode, port]);

  const editModel = useCallback((model: ModelSetting) => {
    setModelDraft({
      channelCode: model.channelCode,
      displayName: model.displayName || "",
      providerCode: model.providerCode || "",
      modelCode: model.modelCode || "",
      baseUrl: model.baseUrl || "",
      apiKeyRef: model.apiKeyRef || "",
      protocol: model.protocol || "openai",
      enabled: model.enabled !== false,
    });
    setActiveView("settings");
  }, []);

  const resolveApproval = useCallback(async (approvalId: string, verdict: "ALLOW_ONCE" | "ALLOW_SESSION" | "DENY" | "CANCEL") => {
    if (!port) return;
    setError("");
    try {
      await resolveRuntimeApproval(port, approvalId, verdict);
      await loadWorkspaceData(port);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadWorkspaceData, port]);

  const startConversation = useCallback((project?: WorkspaceEntry) => {
    if (project) setActiveProjectPath(project.path);
    setActiveSessionId(newSessionId());
    setMessages([]);
    setActiveView("conversation");
  }, []);

  const selectProject = useCallback((project: WorkspaceEntry) => {
    setActiveProjectPath(project.path);
    setActiveView("conversation");
    const projectSessionId = Object.entries(sessionProjectMap)
      .reverse()
      .find(([, path]) => path === project.path)?.[0];
    if (projectSessionId) {
      void selectSession(projectSessionId);
    } else {
      startConversation(project);
    }
  }, [selectSession, sessionProjectMap, startConversation]);

  useEffect(() => {
    if (!port) return;
    const timer = window.setInterval(async () => {
      try {
        setApprovals(await listRuntimeApprovals(port));
      } catch {
        // 保持上一轮审批状态，避免瞬时网络错误打断 UI。
      }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [port]);

  const modelChoices = availableModels.length > 0
    ? availableModels
    : modelSettings.filter((model) => model.enabled !== false);
  const activeProject = projects.find((project) => project.path === activeProjectPath);

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        activeSessionId={activeSessionId}
        activeProjectPath={activeProjectPath}
        projects={projects}
        sessions={sessions}
        sessionProjectMap={sessionProjectMap}
        approvals={approvals}
        plugins={plugins}
        creatingProject={creatingProject}
        projectModalOpen={projectModalOpen}
        projectName={projectName}
        onViewChange={setActiveView}
        onSelectProject={selectProject}
        onSelectSession={(id) => void selectSession(id)}
        onNewConversation={startConversation}
        onProjectModalChange={(open, name) => {
          setProjectModalOpen(open);
          setProjectName(name || "");
        }}
        onCreateProject={() => void createProject()}
      />

      <main className="main-panel">
        {!(activeView === "conversation" && messages.length === 0) ? (
          <header className="topbar">
            <div>
              <h1>
                {activeView === "conversation"
                  ? sessionTitle(activeSession || { agentId: activeSessionId })
                  : activeView === "approvals"
                    ? "审批中心"
                    : activeView === "plugins"
                      ? "插件管理"
                      : activeView === "pulls"
                        ? "拉取请求"
                        : activeView === "scheduled"
                          ? "已安排"
                      : "模型与设置"}
              </h1>
              <p>
                {activeProject ? `${activeProject.name} · ` : ""}
                {modelChoices.length > 0 ? `${modelChoices.length} 个模型可用` : "未配置模型"}
              </p>
            </div>
            <div className="topbar-actions">
              <select
                className="model-select"
                value={activeModel?.channelCode || ""}
                onChange={(event) => void activateModel(event.target.value)}
                disabled={!serviceReady || modelChoices.length === 0}
              >
                {modelChoices.length === 0 ? <option value="">未配置模型</option> : null}
                {modelChoices.map((model) => (
                  <option key={model.channelCode || model.modelCode} value={model.channelCode || ""}>
                    {model.displayName || model.modelCode}
                  </option>
                ))}
              </select>
              <button className="ghost-action" onClick={() => startConversation(activeProject)}>新对话</button>
            </div>
          </header>
        ) : null}

        {error ? <div className="error-banner">{error}</div> : null}

        {activeView === "conversation" ? (
          <div className="workspace-layout">
            <ConversationView
              serviceReady={serviceReady}
              streaming={streaming}
              showReasoning={showReasoning}
              draft={draft}
              messages={messages}
              activeModel={activeModel}
              activeProject={activeProject}
              gitBranch={gitBranch}
              onDraftChange={setDraft}
              onSend={() => void sendMessage()}
              onStopGeneration={() => abortRef.current?.abort()}
              approvalMode={approvalMode}
              onApprovalModeChange={setApprovalMode}
              onShowReasoningChange={setShowReasoning}
              onOpenSettings={() => setActiveView("settings")}
            />
            <InfoPanel
              port={port}
              project={activeProject}
              gitBranch={gitBranch}
              activeModel={activeModel}
              messages={messages}
              approvals={approvals}
              plugins={plugins}
              streaming={streaming}
              activeSessionId={activeSessionId}
              onStartTask={(prompt) => {
                setDraft(prompt);
                setActiveView("conversation");
              }}
            />
          </div>
        ) : null}

        {activeView === "settings" ? (
          <SettingsView
            service={service}
            serviceStatus={serviceStatus}
            serviceError={serviceError}
            draft={modelDraft}
            presets={presets}
            modelSettings={modelSettings}
            availableModels={availableModels}
            discoveredModels={discoveredModels}
            savingModel={savingModel}
            syncingModels={syncingModels}
            onDraftChange={setModelDraft}
            onApplyPreset={applyPreset}
            onDiscover={() => void syncAvailableModels()}
            onSave={() => void submitModel()}
            onCancelEdit={() => setModelDraft(emptyModelDraft)}
            onActivate={(channelCode) => void activateModel(channelCode)}
            onDelete={(channelCode) => void removeModel(channelCode)}
            onEdit={editModel}
          />
        ) : null}

        {activeView === "approvals" ? (
          <div className="panel-grid">
            {approvals.length === 0 ? <div className="panel-card muted">当前没有运行期审批</div> : null}
            {approvals.map((approval) => (
              <article key={approval.approvalId} className="approval-card">
                <strong>{approval.toolName || "Tool Approval"}</strong>
                <pre>{approval.displayCommand || JSON.stringify(approval.arguments || {}, null, 2)}</pre>
                <div className="approval-actions">
                  <button className="ghost-action" onClick={() => void resolveApproval(approval.approvalId, "ALLOW_ONCE")}>允许一次</button>
                  <button className="ghost-action" onClick={() => void resolveApproval(approval.approvalId, "ALLOW_SESSION")}>本会话允许</button>
                  <button className="danger-action" onClick={() => void resolveApproval(approval.approvalId, "DENY")}>拒绝</button>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {activeView === "plugins" ? (
          <div className="panel-grid">
            {plugins.length === 0 ? <div className="panel-card muted">暂无已加载插件</div> : null}
            {plugins.map((plugin) => (
              <article key={plugin.pluginId || plugin.name} className="panel-card">
                <strong>{plugin.name || plugin.pluginId || "Plugin"}</strong>
                <p>{plugin.version || "—"}</p>
                <span>{plugin.status || ""}</span>
              </article>
            ))}
          </div>
        ) : null}

        {activeView === "pulls" ? (
          <div className="panel-grid">
            <div className="panel-card muted">
              <strong>暂无拉取请求</strong>
              <span>连接项目后，这里会展示需要审查或合并的变更。</span>
            </div>
          </div>
        ) : null}

        {activeView === "scheduled" ? (
          <div className="panel-grid">
            <div className="panel-card muted">
              <strong>暂无已安排任务</strong>
              <span>后续可以在这里管理定时运行的智能体任务。</span>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
