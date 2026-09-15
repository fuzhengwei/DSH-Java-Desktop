import { useState } from "react";
import type { AgentServiceState, AvailableModel, ModelDraft, ModelSetting } from "../types";

type SettingsViewProps = {
  service: AgentServiceState | null;
  serviceStatus: "checking" | "stopped" | "running" | "starting";
  serviceError: string;
  activeTab: "models" | "service";
  onTabChange: (tab: "models" | "service") => void;
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

export default function SettingsView({
  service,
  serviceStatus,
  serviceError,
  activeTab,
  onTabChange,
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

  return (
    <div className="settings-layout">
      <div className="settings-tabs">
        <button className={activeTab === "models" ? "active" : ""} onClick={() => onTabChange("models")}>模型设置</button>
        <button className={activeTab === "service" ? "active" : ""} onClick={() => onTabChange("service")}>智能体服务</button>
      </div>

      {activeTab === "service" ? (
        <section className="settings-panel wide service-panel">
          <div className="settings-panel-head">
            <div>
              <h2>智能体服务连接</h2>
              <p>服务由桌面端托管。模型渠道、API Key 和模型同步在「模型设置」中管理。</p>
            </div>
            <button
              className="ghost-action compact"
              onClick={onReconnect}
              disabled={serviceStatus === "starting"}
            >
              {serviceStatus === "starting" ? "连接中…" : "重新连接"}
            </button>
          </div>
          <div className="settings-runtime-strip standalone">
            <div className={`settings-runtime-dot ${serviceStatus === "running" ? "online" : "offline"}`} />
            <div>
              <strong>{serviceStatus === "running" ? "已连接" : serviceStatus === "starting" ? "正在启动" : "不可用"}</strong>
              <span>{service?.jarPath || "服务由桌面端后台自动托管"}</span>
              {serviceError ? <small>{serviceError}</small> : null}
            </div>
            {service?.port ? <code>127.0.0.1:{service.port}</code> : null}
          </div>
        </section>
      ) : (
        <>
          <section className="settings-panel wide models-panel">
        <div className="settings-panel-head">
          <div>
            <h2>模型配置</h2>
            <p>启用、停用、切换或删除模型渠道。</p>
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
                <small>{model.baseUrl || "未配置地址"} · {model.protocol === "openai" ? "OpenAI 兼容" : model.protocol === "anthropic" ? "Anthropic Messages" : model.protocol === "ollama" ? "Ollama 原生" : model.protocol || "openai"}</small>
              </div>
              <div className="model-row-badges">
                {model.active ? <span className="active-badge">使用中</span> : null}
                <span className={`status-chip ${model.enabled ? "online" : "muted"}`}>{model.enabled ? "已启用" : "已停用"}</span>
              </div>
              <div className="model-row-actions">
                <button className="ghost-action" onClick={() => onActivate(model.channelCode || "")} disabled={model.active || model.enabled === false || !model.channelCode}>使用</button>
                <button className="ghost-action" onClick={() => {
                  onEdit(model);
                  setShowForm(true);
                }}>编辑</button>
                <button className="ghost-action" onClick={() => onToggleModel(model)} disabled={!model.channelCode}>{model.enabled ? "停用" : "启用"}</button>
                <button className="danger-action" onClick={() => onDelete(model.channelCode || "")} disabled={!model.channelCode}>删除</button>
              </div>
            </article>
          ))}
        </div>

        <button className="primary-action add-model-action" onClick={() => setShowForm(true)}>添加模型</button>
      </section>

          <section className="settings-panel wide runtime-panel">
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
      )}

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
                  <input value={draft.displayName} placeholder="例如：DeepSeek 官方 / 本地 Ollama"
                    onChange={(event) => onDraftChange({ ...draft, displayName: event.target.value })} />
                </label>
                <label className="form-field span-2">
                  <span>Base URL</span>
                  <input value={draft.baseUrl} placeholder="https://api.deepseek.com/v1"
                    onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })} />
                </label>
                <label className="form-field span-2">
                  <span>API Key</span>
                  <input type="password" value={draft.apiKeyRef} placeholder={draft.protocol === "ollama" ? "本地部署无需填写" : "输入 API Key"}
                    onChange={(event) => onDraftChange({ ...draft, apiKeyRef: event.target.value })} />
                </label>
                <label className="form-field span-2">
                  <span>模型</span>
                  <input list="desktop-model-options" value={draft.modelCode} placeholder="选择、同步或手动输入模型"
                    onChange={(event) => onDraftChange({ ...draft, modelCode: event.target.value })} />
                  <datalist id="desktop-model-options">
                    {modelOptions.map((model) => <option key={model} value={model} />)}
                  </datalist>
                  {modelOptions.length > 0 ? (
                    <div className="suggestion-row">
                      {modelOptions.slice(0, 8).map((model) => (
                        <button key={model} type="button" className={model === draft.modelCode ? "model-suggestion active" : "model-suggestion"}
                          onClick={() => onDraftChange({ ...draft, modelCode: model })}>{model}</button>
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
                {savingModel ? "保存中…" : draft.channelCode ? "保存并使用" : "保存并使用"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
