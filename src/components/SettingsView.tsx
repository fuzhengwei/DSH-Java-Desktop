import { useState } from "react";
import { ArrowLeftIcon } from "./icons";
import PluginsSettings from "./PluginsSettings";
import type {
  AgentServiceState,
  ApprovalMode,
  AvailableModel,
  ModelDraft,
  ModelSetting,
  ReasoningEffort,
} from "../types";

export type SettingsSection = "models" | "service" | "preferences" | "plugins";

type SettingsViewProps = {
  service: AgentServiceState | null;
  serviceStatus: "checking" | "stopped" | "running" | "starting";
  serviceError: string;
  error: string;
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
  approvalMode: ApprovalMode;
  reasoningEffort: ReasoningEffort;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  draft: ModelDraft;
  modelSettings: ModelSetting[];
  availableModels: AvailableModel[];
  discoveredModels: string[];
  savingModel: boolean;
  syncingModels: boolean;
  onDraftChange: (draft: ModelDraft) => void;
  onDiscover: () => void;
  onSave: () => Promise<boolean>;
  onCancelEdit: () => void;
  onActivate: (channelCode: string) => void;
  onDelete: (channelCode: string) => void;
  onEdit: (model: ModelSetting) => void;
  onToggleModel: (model: ModelSetting) => void;
  onReconnect: () => void;
};

const approvalOptions: Array<{ value: ApprovalMode; title: string; detail: string }> = [
  { value: "REQUEST_APPROVAL", title: "请求审批", detail: "执行工具前等待确认，适合日常工作和陌生项目。" },
  { value: "AUTO_APPROVE", title: "自动审批 · 沙箱内", detail: "自动允许沙箱内工具执行，减少打断但保留隔离。" },
  { value: "FULL_OPEN", title: "完全开放 · 沙箱外", detail: "允许沙箱外执行，拥有最高自由度；仅在完全信任任务时使用。" },
];

const reasoningOptions: Array<{ value: ReasoningEffort; title: string; detail: string }> = [
  { value: "low", title: "低推理", detail: "更快响应，适合问答、摘要和简单修改。" },
  { value: "medium", title: "中推理", detail: "平衡速度和稳定性，适合大多数开发任务。" },
  { value: "high", title: "高推理", detail: "更充分推理，适合复杂调试、架构和大范围变更。" },
];

function protocolLabel(protocol?: string) {
  if (protocol === "anthropic") return "Anthropic Messages";
  if (protocol === "ollama") return "Ollama 原生";
  return "OpenAI 兼容";
}

function runtimeSourceLabel(source: AgentServiceState["runtimeSource"]) {
  if (source === "bundled") return "应用内置";
  if (source === "custom") return "自定义路径";
  if (source === "system") return "系统环境";
  return "未检测到";
}

function runtimeStatusDetail(service: AgentServiceState | null, serviceError: string) {
  if (!service) return serviceError || "正在检测 Java Runtime…";
  if (service.runtimeStatus === "missing") return serviceError || "未检测到 Java 17 Runtime。发布版请重新安装应用。";
  if (service.runtimeStatus === "too_old") return serviceError || "当前 Java 版本过低，需要 Java 17 或更高版本。";
  if (service.runtimeStatus === "invalid") return serviceError || "Java Runtime 无法启动或版本无法识别。";
  return service.javaPath || serviceError || "Runtime 检测正常";
}

export default function SettingsView({
  service,
  serviceStatus,
  serviceError,
  error,
  activeSection,
  onSectionChange,
  onBack,
  approvalMode,
  reasoningEffort,
  onApprovalModeChange,
  onReasoningEffortChange,
  draft,
  modelSettings,
  availableModels,
  discoveredModels,
  savingModel,
  syncingModels,
  onDraftChange,
  onDiscover,
  onSave,
  onCancelEdit,
  onActivate,
  onDelete,
  onEdit,
  onToggleModel,
  onReconnect,
}: SettingsViewProps) {
  const [showForm, setShowForm] = useState(false);
  const modelOptions = Array.from(new Set([
    ...availableModels.flatMap((model) => model.modelCode ? [model.modelCode] : []),
    ...discoveredModels,
  ]));
  const canSave = draft.displayName.trim().length > 0
    && draft.modelCode.trim().length > 0
    && draft.baseUrl.trim().length > 0
    && (draft.protocol === "ollama" || draft.apiKeyRef.trim().length > 0);

  const closeForm = () => {
    setShowForm(false);
    onCancelEdit();
  };

  const saveForm = async () => {
    const saved = await onSave();
    if (saved) closeForm();
  };

  const sections: Array<{ id: SettingsSection; title: string; description: string; badge?: string }> = [
    { id: "models", title: "模型设置", description: "渠道、API Key 与激活", badge: String(modelSettings.length) },
    { id: "plugins", title: "插件管理", description: "安装、启停与参数配置" },
    { id: "service", title: "智能体服务", description: "连接状态与本地 Runtime" },
    { id: "preferences", title: "对话偏好", description: "审批、沙箱与推理" },
  ];
  const activeTitle = sections.find((section) => section.id === activeSection)?.title || "设置";

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <button className="settings-back" onClick={onBack}>
          <ArrowLeftIcon className="icon-16" />
          <span>返回应用</span>
        </button>
        <div className="settings-page-title">
          <h1>设置</h1>
          <p>{activeTitle}</p>
        </div>
      </header>

      {error ? <div className="settings-page-error">{error}</div> : null}

      <div className="settings-page-body">
        <nav className="settings-nav" aria-label="设置目录">
          {sections.map((section) => (
            <button
              key={section.id}
              className={activeSection === section.id ? "settings-nav-item active" : "settings-nav-item"}
              onClick={() => onSectionChange(section.id)}
            >
              <strong>{section.title}</strong>
              <span>{section.description}</span>
              {section.badge ? <i>{section.badge}</i> : null}
            </button>
          ))}
        </nav>

        <main className="settings-content">
          {activeSection === "plugins" ? (
            <PluginsSettings servicePort={service?.port ?? null} />
          ) : null}

          {activeSection === "service" ? (
            <section className="settings-panel service-panel">
              <div className="settings-panel-head">
                <div>
                  <h2>智能体服务连接</h2>
                  <p>服务由桌面端自动托管。模型渠道和凭据在「模型设置」中管理。</p>
                </div>
                <button className="ghost-action compact" onClick={onReconnect} disabled={serviceStatus === "starting"}>
                  {serviceStatus === "starting" ? "连接中…" : "重新连接"}
                </button>
              </div>
              <div className="service-status-grid">
                <div className="service-status-card">
                  <span>运行状态</span>
                  <strong>{serviceStatus === "running" ? "已连接" : serviceStatus === "starting" ? "正在启动" : "不可用"}</strong>
                  <small>{serviceError || "本地 Runtime 正常"}</small>
                </div>
                <div className="service-status-card">
                  <span>服务地址</span>
                  <strong>{service?.port ? `127.0.0.1:${service.port}` : "待分配"}</strong>
                  <small>仅监听本机，不在主对话区暴露端口。</small>
                </div>
                <div className="service-status-card wide">
                  <span>JAR 路径</span>
                  <strong>{service?.jarPath || "由桌面端后台托管"}</strong>
                  <small>应用启动时自动拉起智能体服务。</small>
                </div>
                <div className="service-status-card wide">
                  <span>Java Runtime</span>
                  <strong>
                    {service?.javaVersion ? `Java ${service.javaVersion} · ${runtimeSourceLabel(service.runtimeSource)}` : runtimeSourceLabel(service?.runtimeSource || null)}
                  </strong>
                  <small>{runtimeStatusDetail(service, serviceError)}</small>
                </div>
                <div className="service-status-card">
                  <span>运行时模型</span>
                  <strong>{availableModels.length}</strong>
                  <small>启用且健康可用的渠道数量。</small>
                </div>
              </div>
            </section>
          ) : null}

          {activeSection === "preferences" ? (
            <section className="settings-panel preferences-panel">
              <div className="settings-panel-head">
                <div>
                  <h2>对话偏好</h2>
                  <p>设置新消息使用的工具审批策略和推理强度。</p>
                </div>
                <span className="settings-pill">新消息生效</span>
              </div>
              <div className="preference-group">
                <div className="preference-group-head">
                  <h3>工具执行审批</h3>
                  <span>控制智能体运行工具时的安全边界。</span>
                </div>
                <div className="preference-list" role="radiogroup" aria-label="工具执行审批">
                  {approvalOptions.map((option) => (
                    <label key={option.value} className={`preference-option ${approvalMode === option.value ? "active" : ""}`}>
                      <input
                        type="radio"
                        name="approval-mode"
                        checked={approvalMode === option.value}
                        onChange={() => onApprovalModeChange(option.value)}
                      />
                      <div>
                        <strong>{option.title}</strong>
                        <span>{option.detail}</span>
                      </div>
                      <i aria-hidden="true">{approvalMode === option.value ? "当前" : ""}</i>
                    </label>
                  ))}
                </div>
              </div>
              <div className="preference-group">
                <div className="preference-group-head">
                  <h3>推理强度</h3>
                  <span>在响应速度和处理复杂任务的能力之间平衡。</span>
                </div>
                <div className="preference-list" role="radiogroup" aria-label="推理强度">
                  {reasoningOptions.map((option) => (
                    <label key={option.value} className={`preference-option ${reasoningEffort === option.value ? "active" : ""}`}>
                      <input
                        type="radio"
                        name="reasoning-effort"
                        checked={reasoningEffort === option.value}
                        onChange={() => onReasoningEffortChange(option.value)}
                      />
                      <div>
                        <strong>{option.title}</strong>
                        <span>{option.detail}</span>
                      </div>
                      <i aria-hidden="true">{reasoningEffort === option.value ? "当前" : ""}</i>
                    </label>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {activeSection === "models" ? (
            <>
              <section className="settings-panel models-panel">
                <div className="settings-panel-head">
                  <div>
                    <h2>模型配置</h2>
                    <p>添加、启用、停用、切换或删除模型渠道。</p>
                  </div>
                  <span className="settings-pill">{modelSettings.length}</span>
                </div>
                <div className="model-list">
                  {modelSettings.length === 0 ? <div className="empty-card">还没有模型配置</div> : null}
                  {modelSettings.map((model) => (
                    <article key={model.channelCode || model.modelCode} className={`model-row ${model.active ? "active" : ""} ${model.enabled === false ? "disabled" : ""}`}>
                      <div className="model-row-main">
                        <strong>{model.displayName || model.channelCode}</strong>
                        <span>{model.modelCode}</span>
                        <small>{model.baseUrl || "未配置地址"} · {protocolLabel(model.protocol)}</small>
                      </div>
                      <div className="model-row-badges">
                        {model.active ? <span className="active-badge">使用中</span> : null}
                        <span className={`status-chip ${model.enabled ? "online" : "muted"}`}>{model.enabled ? "已启用" : "已停用"}</span>
                      </div>
                      <div className="model-row-actions">
                        <button className="ghost-action" onClick={() => onActivate(model.channelCode || "")} disabled={model.active || model.enabled === false || !model.channelCode}>使用</button>
                        <button className="ghost-action" onClick={() => { onEdit(model); setShowForm(true); }}>编辑</button>
                        <button className="ghost-action" onClick={() => onToggleModel(model)} disabled={!model.channelCode}>{model.enabled ? "停用" : "启用"}</button>
                        <button className="danger-action" onClick={() => onDelete(model.channelCode || "")} disabled={!model.channelCode}>删除</button>
                      </div>
                    </article>
                  ))}
                </div>
                <button className="primary-action add-model-action" onClick={() => setShowForm(true)}>添加模型</button>
              </section>

              <section className="settings-panel runtime-panel">
                <div className="settings-panel-head">
                  <div>
                    <h2>运行时可用模型</h2>
                    <p>只有启用且健康可用的模型才会出现在这里。</p>
                  </div>
                  <span className="settings-pill">{availableModels.length}</span>
                </div>
                <div className="model-grid">
                  {availableModels.length === 0 ? <div className="empty-card">暂无运行时模型</div> : null}
                  {availableModels.map((model) => (
                    <article key={`${model.channelCode}-${model.modelCode}`} className="runtime-model-card">
                      <strong>{model.displayName || model.modelCode}</strong>
                      <span>{model.modelCode}</span>
                      <small>{model.channelCode}</small>
                    </article>
                  ))}
                </div>
              </section>
            </>
          ) : null}
        </main>
      </div>

      {showForm ? (
        <div className="modal-overlay" onClick={closeForm}>
          <div className="modal model-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{draft.channelCode ? "编辑模型" : "添加模型"}</h3>
              <button className="modal-close" onClick={closeForm}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <label className="form-field span-2">
                  <span>协议</span>
                  <select value={draft.protocol} onChange={(event) => onDraftChange({ ...draft, protocol: event.target.value })}>
                    <option value="openai">OpenAI 兼容</option>
                    <option value="anthropic">Anthropic Messages</option>
                    <option value="ollama">Ollama 原生</option>
                  </select>
                </label>
                <label className="form-field span-2">
                  <span>渠道名称</span>
                  <input value={draft.displayName} placeholder="例如：DeepSeek 官方 / 本地 Ollama" onChange={(event) => onDraftChange({ ...draft, displayName: event.target.value })} />
                </label>
                <label className="form-field span-2">
                  <span>Base URL</span>
                  <input value={draft.baseUrl} placeholder="https://api.deepseek.com/v1" onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })} />
                </label>
                <label className="form-field span-2">
                  <span>API Key</span>
                  <input type="password" value={draft.apiKeyRef} placeholder={draft.protocol === "ollama" ? "本地部署无需填写" : "输入 API Key"} onChange={(event) => onDraftChange({ ...draft, apiKeyRef: event.target.value })} />
                </label>
                <label className="form-field span-2">
                  <span>模型</span>
                  <input list="desktop-model-options" value={draft.modelCode} placeholder="选择、同步或手动输入模型" onChange={(event) => onDraftChange({ ...draft, modelCode: event.target.value })} />
                  <datalist id="desktop-model-options">
                    {modelOptions.map((model) => <option key={model} value={model} />)}
                  </datalist>
                  {modelOptions.length > 0 ? (
                    <div className="suggestion-row">
                      {modelOptions.slice(0, 8).map((model) => (
                        <button key={model} type="button" className={model === draft.modelCode ? "model-suggestion active" : "model-suggestion"} onClick={() => onDraftChange({ ...draft, modelCode: model })}>{model}</button>
                      ))}
                    </div>
                  ) : null}
                </label>
              </div>
            </div>
            <div className="modal-actions">
              <button className="ghost-action" onClick={onDiscover} disabled={syncingModels}>{syncingModels ? "同步中…" : "同步模型"}</button>
              <button className="ghost-action" onClick={closeForm}>取消</button>
              <button className="primary-action compact" onClick={() => void saveForm()} disabled={savingModel || !canSave}>
                {savingModel ? "保存中…" : "保存并使用"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
