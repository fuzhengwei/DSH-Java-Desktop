import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationView from "./components/ConversationView";
import Sidebar, { type WorkspaceView } from "./components/Sidebar";
import SettingsView from "./components/SettingsView";
import {
  activateModelSetting,
  deleteModelSetting,
  discoverModels,
  listAvailableModels,
  listMessages,
  listModelSettings,
  listRuntimeApprovals,
  listSessions,
  listWorkspaces,
  createWorkspace,
  saveModelSetting,
  resolveRuntimeApproval,
  streamAgentMessage,
  waitForService,
} from "./lib/agent-client";
import type {
  AgentActivity,
  AgentServiceState,
  ApprovalMode,
  AvailableModel,
  ConversationMessage,
  ModelDraft,
  ModelSetting,
  SessionSummary,
  WorkspaceEntry,
  RuntimeApproval,
} from "./types";

const emptyModelDraft: ModelDraft = {
  displayName: "",
  providerCode: "custom",
  modelCode: "",
  baseUrl: "",
  apiKeyRef: "",
  protocol: "openai",
  enabled: true,
};

type SettingsTab = "models" | "service";

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

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
  if (typeof record.info === "string") return record.info;
  if (typeof record.error === "string") return record.error;
  if (typeof record.result === "string") return record.result;
  return "";
}

function messagesFromPayload(payload: unknown): ConversationMessage[] | null {
  const messages = payloadRecord(payload).messages;
  if (!Array.isArray(messages)) return null;
  return messages.filter((item): item is ConversationMessage => Boolean(item && typeof item === "object"));
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
  const [localProjects, setLocalProjects] = useState<WorkspaceEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(newSessionId());
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [approvals, setApprovals] = useState<RuntimeApproval[]>([]);
  const [resolvingApprovalId, setResolvingApprovalId] = useState("");
  const [modelSettings, setModelSettings] = useState<ModelSetting[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModelDraft);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("models");
  const [savingModel, setSavingModel] = useState(false);
  const [syncingModels, setSyncingModels] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("REQUEST_APPROVAL");
  const [showReasoning, setShowReasoning] = useState(true);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
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
    const [sessionsResult, projectsResult, modelSettingsResult, runtimeModelsResult, approvalsResult] =
      await Promise.allSettled([
        listSessions(servicePort),
        listWorkspaces(servicePort),
        listModelSettings(servicePort),
        listAvailableModels(servicePort),
        listRuntimeApprovals(servicePort),
      ]);

    if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value);
    if (projectsResult.status === "fulfilled") {
      setProjects(projectsResult.value);
      setActiveProjectPath((current) => current || projectsResult.value[0]?.path || "");
    }
    const loadedModels = modelSettingsResult.status === "fulfilled" ? modelSettingsResult.value : [];
    const loadedRuntimeModels = runtimeModelsResult.status === "fulfilled" ? runtimeModelsResult.value : [];
    setModelSettings(loadedModels);
    setAvailableModels(loadedRuntimeModels);
    if (approvalsResult.status === "fulfilled") setApprovals(approvalsResult.value);

    if (focusModelsIfEmpty && loadedModels.length === 0) {
      setActiveView("settings");
    }
  }, []);

  useEffect(() => {
    setSessionProjectMap(JSON.parse(localStorage.getItem("dsh-session-project-map") || "{}"));
    setLocalProjects(JSON.parse(localStorage.getItem("dsh-local-projects") || "[]"));
  }, []);

  useEffect(() => {
    localStorage.setItem("dsh-session-project-map", JSON.stringify(sessionProjectMap));
  }, [sessionProjectMap]);

  useEffect(() => {
    localStorage.setItem("dsh-local-projects", JSON.stringify(localProjects));
  }, [localProjects]);

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
        if (attempt < 2) {
          await invoke("stop_agent").catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
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
    if (!port || !streaming) return;
    let cancelled = false;
    const loadApprovals = async () => {
      try {
        const items = await listRuntimeApprovals(port);
        if (!cancelled) setApprovals(items);
      } catch {
        return;
      }
    };

    void loadApprovals();
    const timer = window.setInterval(() => void loadApprovals(), 1_200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [port, streaming]);

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

  const resolveApproval = useCallback(async (approvalId: string, verdict: "ALLOW_ONCE" | "DENY") => {
    if (!port || resolvingApprovalId) return;
    setResolvingApprovalId(approvalId);
    setError("");
    try {
      await resolveRuntimeApproval(port, approvalId, verdict);
      await loadWorkspaceData(port);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setResolvingApprovalId("");
    }
  }, [loadWorkspaceData, port, resolvingApprovalId]);

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
    setApprovals([]);
    setActivity([
      { id: "meta", label: "连接模型", detail: activeModel.displayName || activeModel.modelCode, state: "running" },
    ]);

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
          if (event.type === "meta") {
            setActivity((current) => current.map((item) => (
              item.id === "meta" ? { ...item, state: "done" } : item
            )));
          } else if (event.type === "chunk" || event.type === "reasoning") {
            const delta = payloadText(event.payload);
            if (event.type === "reasoning") {
              setActivity((current) => {
                if (current.some((item) => item.state === "running" && item.label === "思考中")) {
                  return current;
                }
                return [...current, { id: `reasoning-${current.length}`, label: "思考中", state: "running" }];
              });
            } else {
              setActivity((current) => {
                const changed = current.map((item) => (item.state === "running" ? { ...item, state: "done" as const } : item));
                return changed.some((item) => item.label === "生成回复")
                  ? changed
                  : [...changed, { id: `answer-${changed.length}`, label: "生成回复", state: "running" }];
              });
            }
            setMessages((current) => {
              const next = [...current];
              const target = next[next.length - 1];
              if (target?.role === "assistant") {
                if (event.type === "chunk") target.content += delta;
                else target.reasoning = (target.reasoning || "") + delta;
              }
              return next;
            });
          } else if (event.type === "step_break") {
            const payload = payloadRecord(event.payload);
            const toolName = typeof payload.toolName === "string" ? payload.toolName : "工具";
            const callId = typeof payload.callId === "string" ? payload.callId : `${toolName}-${Date.now()}`;
            setActivity((current) => [
              ...current.map((item) => (item.state === "running" ? { ...item, state: "done" as const } : item)),
              { id: callId, label: `执行 · ${toolName}`, detail: payloadText(payload.arguments), state: "running" },
            ]);
            setMessages((current) => [
              ...current,
              {
                role: "tool",
                content: "",
                toolName,
                callId,
                arguments: payloadRecord(payload.arguments),
                status: typeof payload.status === "string" ? payload.status : "running",
              },
              { role: "assistant", content: "", reasoning: "" },
            ]);
          } else if (event.type === "tool_result") {
            const payload = payloadRecord(event.payload);
            const callId = typeof payload.callId === "string" ? payload.callId : "";
            const failed = payload.status === "error" || payload.status === "failed";
            setActivity((current) => current.map((item) => (
              item.id === callId
                ? { ...item, state: failed ? "error" : "done", detail: payloadText(payload) }
                : item
            )));
            setMessages((current) => current.map((message) => (
              message.role === "tool" && (!callId || message.callId === callId)
                ? {
                    ...message,
                    result: typeof payload.result === "string" ? payload.result : payloadText(payload),
                    status: typeof payload.status === "string" ? payload.status : "success",
                    durationMs: typeof payload.durationMs === "number" ? payload.durationMs : message.durationMs,
                  }
                : message
            )));
          } else if (event.type === "done") {
            const normalized = messagesFromPayload(event.payload);
            if (normalized && normalized.length > 0) setMessages(normalized);
            setActivity((current) => current.map((item) => (
              item.state === "running" ? { ...item, state: "done" } : item
            )));
          } else if (event.type === "error") {
            setActivity((current) => current.map((item) => (
              item.state === "running" ? { ...item, state: "error" } : item
            )));
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
      setActivity((current) => current.map((item) => (
        item.state === "running" ? { ...item, state: caught instanceof DOMException ? "done" : "error" } : item
      )));
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

  const submitModel = useCallback(async (): Promise<boolean> => {
    if (!port) return false;
    if (!modelDraft.displayName.trim()) {
      setError("请填写渠道名称");
      return false;
    }
    if (!modelDraft.modelCode.trim()) {
      setError("请选择或输入模型");
      return false;
    }
    if (!modelDraft.baseUrl.trim()) {
      setError("请填写 Base URL");
      return false;
    }
    if (modelDraft.protocol !== "ollama" && !modelDraft.apiKeyRef.trim()) {
      setError("请填写 API Key");
      return false;
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
    return true;
  }, [loadWorkspaceData, modelDraft, port]);

  const toggleModel = useCallback(async (model: ModelSetting) => {
    if (!port || !model.channelCode) return;
    setError("");
    try {
      await saveModelSetting(port, {
        ...model,
        enabled: model.enabled === false,
      });
      await loadWorkspaceData(port);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadWorkspaceData, port]);

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

  const startConversation = useCallback((project?: WorkspaceEntry) => {
    if (project) setActiveProjectPath(project.path);
    setActiveSessionId(newSessionId());
    setMessages([]);
    setActivity([]);
    setActiveView("conversation");
  }, []);

  const pickLocalProject = useCallback(async () => {
    try {
      const selected = await invoke<WorkspaceEntry | null>("pick_local_directory");
      if (!selected?.path) return;
      const entry: WorkspaceEntry = {
        name: selected.name || selected.path.split("/").filter(Boolean).pop() || "本地项目",
        path: selected.path,
        local: true,
      };
      setLocalProjects((current) => [
        ...current.filter((project) => project.path !== entry.path),
        entry,
      ]);
      setActiveProjectPath(entry.path);
      setProjectModalOpen(false);
      setActiveView("conversation");
      startConversation(entry);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [startConversation]);

  const removeLocalProject = useCallback((path: string) => {
    setLocalProjects((current) => current.filter((project) => project.path !== path));
    if (activeProjectPath === path) {
      setActiveProjectPath(projects[0]?.path || "");
      startConversation(projects[0]);
    }
  }, [activeProjectPath, projects, startConversation]);

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

  const modelChoices = availableModels.length > 0
    ? availableModels
    : modelSettings.filter((model) => model.enabled !== false);
  const combinedProjects = useMemo(() => {
    const byPath = new Map<string, WorkspaceEntry>();
    for (const project of projects) byPath.set(project.path, project);
    for (const project of localProjects) byPath.set(project.path, project);
    return [...byPath.values()];
  }, [localProjects, projects]);
  const activeProject = combinedProjects.find((project) => project.path === activeProjectPath);

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        activeSessionId={activeSessionId}
        activeProjectPath={activeProjectPath}
        projects={combinedProjects}
        sessions={sessions}
        sessionProjectMap={sessionProjectMap}
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
        onPickLocalProject={() => void pickLocalProject()}
        onRemoveLocalProject={removeLocalProject}
      />

      <main className="main-panel">
        {!(activeView === "conversation" && messages.length === 0) ? (
          <header className="topbar">
            <div>
              <h1>
                {activeView === "conversation"
                  ? sessionTitle(activeSession || { agentId: activeSessionId })
                      : settingsTab === "models" ? "模型设置" : "智能体服务"}
              </h1>
              <p>
                {activeProject ? `${activeProject.name} · ` : ""}
                {modelChoices.length > 0 ? `${modelChoices.length} 个模型可用` : "未配置模型"}
              </p>
            </div>
          </header>
        ) : null}

        {error ? <div className="error-banner">{error}</div> : null}

        {activeView === "conversation" ? (
          <ConversationView
            serviceReady={serviceReady}
            streaming={streaming}
            showReasoning={showReasoning}
            draft={draft}
            messages={messages}
            activeModel={activeModel}
            activeProject={activeProject}
            onDraftChange={setDraft}
            onSend={() => void sendMessage()}
            onStopGeneration={() => abortRef.current?.abort()}
            approvalMode={approvalMode}
            onApprovalModeChange={setApprovalMode}
            onShowReasoningChange={setShowReasoning}
            onOpenSettings={() => setActiveView("settings")}
            activity={activity}
            approvals={approvals.filter((approval) => !approval.sessionId || approval.sessionId === activeSessionId)}
            resolvingApprovalId={resolvingApprovalId}
            onResolveApproval={(approvalId, verdict) => void resolveApproval(approvalId, verdict)}
          />
        ) : null}

        {activeView === "settings" ? (
          <SettingsView
            service={service}
            serviceStatus={serviceStatus}
            serviceError={serviceError}
            activeTab={settingsTab}
            onTabChange={setSettingsTab}
            draft={modelDraft}
            modelSettings={modelSettings}
            availableModels={availableModels}
            discoveredModels={discoveredModels}
            savingModel={savingModel}
            syncingModels={syncingModels}
            onDraftChange={setModelDraft}
            onDiscover={() => void syncAvailableModels()}
            onSave={() => submitModel()}
            onCancelEdit={() => setModelDraft(emptyModelDraft)}
            onActivate={(channelCode) => void activateModel(channelCode)}
            onDelete={(channelCode) => void removeModel(channelCode)}
            onEdit={editModel}
            onToggleModel={(model) => void toggleModel(model)}
          />
        ) : null}

      </main>
    </div>
  );
}
