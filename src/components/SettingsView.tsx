import { useState } from "react";
import type { AgentServiceState, AvailableModel, ChannelPreset, ModelDraft, ModelSetting } from "../types";

type SettingsViewProps = {
  service: AgentServiceState | null;
  serviceStatus: "checking" | "stopped" | "running" | "starting";
  serviceError: string;
  draft: ModelDraft;
  presets: ChannelPreset[];
  modelSettings: ModelSetting[];
  availableModels: AvailableModel[];
  discoveredModels: string[];
  savingModel: boolean;
  syncingModels: boolean;
  onDraftChange: (draft: ModelDraft) => void;
  onApplyPreset: (preset: ChannelPreset) => void;
  onDiscover: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onActivate: (channelCode: string) => void;
  onDelete: (channelCode: string) => void;
  onEdit: (model: ModelSetting) => void;
};

export default function SettingsView({
  service,
  serviceStatus,
  serviceError,
  draft,
  presets,
  modelSettings,
  availableModels,
  discoveredModels,
  savingModel,
  syncingModels,
  onDraftChange,
  onApplyPreset,
  onDiscover,
  onSave,
  onCancelEdit,
  onActivate,
  onDelete,
  onEdit,
}: SettingsViewProps) {
  const [presetId, setPresetId] = useState("");
  const modelOptions = Array.from(new Set([
    ...discoveredModels,
    ...(presets.find((preset) => preset.id === presetId)?.modelSuggestions || []),
  ]));

  return (
    <div className="settings-layout">
      <section className="settings-runtime-strip">
        <div className={`settings-runtime-dot ${serviceStatus === "running" ? "online" : "offline"}`} />
        <div>
          <strong>{serviceStatus === "running" ? "智能体服务已连接" : serviceStatus === "starting" ? "智能体服务正在启动" : "智能体服务不可用"}</strong>
          <span>{service?.jarPath || "服务由桌面端后台自动托管"}</span>
          {serviceError ? <small>{serviceError}</small> : null}
        </div>
        {service?.port ? <code>127.0.0.1:{service.port}</code> : null}
      </section>

      <section className="settings-panel form-panel">
        <div className="settings-panel-head">
          <div>
            <h2>{draft.channelCode ? "编辑模型" : "接入模型"}</h2>
            <p>保存后点击“使用”设为默认对话模型。支持 OpenAI 兼容、Anthropic 和 Ollama。</p>
          </div>
          <span className="settings-pill">多协议</span>
        </div>

        <div className="form-grid">
          <label className="form-field">
            <span>渠道名称</span>
            <input value={draft.displayName} placeholder="例如：DeepSeek 官方 / 本地 Ollama"
              onChange={(event) => onDraftChange({ ...draft, displayName: event.target.value })} />
          </label>

          <label className="form-field">
            <span>渠道模板</span>
            <select value={presetId} onChange={(event) => {
              setPresetId(event.target.value);
              const preset = presets.find((item) => item.id === event.target.value);
              if (preset) onApplyPreset(preset);
            }}>
              <option value="">选择模板快捷填充</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.displayName || preset.id}</option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span>Provider</span>
            <input value={draft.providerCode} placeholder="deepseek / openai / ollama"
              onChange={(event) => onDraftChange({ ...draft, providerCode: event.target.value })} />
          </label>

          <label className="form-field">
            <span>协议</span>
            <select value={draft.protocol} onChange={(event) => onDraftChange({ ...draft, protocol: event.target.value })}>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic Messages</option>
              <option value="ollama">Ollama 原生</option>
            </select>
          </label>

          <label className="form-field span-2">
            <span>模型</span>
            <input list="desktop-model-options" value={draft.modelCode} placeholder="选择、同步或手动输入模型"
              onChange={(event) => onDraftChange({ ...draft, modelCode: event.target.value })} />
            <datalist id="desktop-model-options">
              {modelOptions.map((model) => <option key={model} value={model} />)}
            </datalist>
          </label>

          <label className="form-field">
            <span>Base URL</span>
            <input value={draft.baseUrl} placeholder="https://api.deepseek.com/v1"
              onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })} />
          </label>

          <label className="form-field">
            <span>API Key</span>
            <input type="password" value={draft.apiKeyRef} placeholder="本地保存到模型设置"
              onChange={(event) => onDraftChange({ ...draft, apiKeyRef: event.target.value })} />
          </label>
        </div>

        <div className="settings-actions">
          <label className="toggle">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => onDraftChange({ ...draft, enabled: event.target.checked })} />
            启用
          </label>
          <button className="ghost-action" onClick={onDiscover} disabled={syncingModels}>
            {syncingModels ? "同步中…" : "同步模型"}
          </button>
          <button className="primary-action compact" onClick={onSave} disabled={savingModel}>
            {savingModel ? "保存中…" : draft.channelCode ? "保存修改" : "保存模型"}
          </button>
          {draft.channelCode ? <button className="ghost-action" onClick={onCancelEdit}>取消编辑</button> : null}
        </div>
      </section>

      <section className="settings-panel wide models-panel">
        <div className="settings-panel-head">
          <div>
            <h2>已配置模型</h2>
            <p>当前生效模型会自动用于新对话。点击“使用”切换全局默认渠道。</p>
          </div>
          <span className="settings-pill">{modelSettings.length}</span>
        </div>

        <div className="model-grid">
          {modelSettings.length === 0 ? <div className="empty-card">还没有模型配置</div> : null}
          {modelSettings.map((model) => (
            <article key={model.channelCode || model.modelCode} className={`model-card ${model.active ? "active" : ""}`}>
              <div className="model-card-head">
                <strong>{model.displayName || model.channelCode}</strong>
                {model.active ? <span className="active-badge">使用中</span> : null}
              </div>
              <div className="model-code">{model.modelCode}</div>
              <div className="model-chip-row">
                <span className="model-chip">{model.providerCode || "custom"}</span>
                <span className={`status-chip ${model.enabled ? "online" : "muted"}`}>
                  {model.enabled ? "已启用" : "已停用"}
                </span>
              </div>
              <div className="model-meta">
                <span>{model.protocol === "openai" ? "OpenAI 兼容" : model.protocol === "anthropic" ? "Anthropic Messages" : model.protocol === "ollama" ? "Ollama 原生" : model.protocol || "openai"}</span>
                <span>{model.baseUrl || "未配置地址"}</span>
                <span>{model.apiKeyRef ? "API Key 已配置" : "API Key 未配置"}</span>
              </div>
              <div className="model-actions">
                <button className="ghost-action" onClick={() => onActivate(model.channelCode || "")} disabled={model.active || !model.channelCode}>
                  使用
                </button>
                <button className="ghost-action" onClick={() => onEdit(model)}>编辑</button>
                <button className="danger-action" onClick={() => onDelete(model.channelCode || "")} disabled={!model.channelCode}>删除</button>
              </div>
            </article>
          ))}
        </div>
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
    </div>
  );
}
