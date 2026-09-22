import { useState, type ReactNode } from "react";
import { ArrowLeftIcon, SettingsIcon, ShieldIcon, SlidersIcon } from "./icons";
import PluginsSettings from "./PluginsSettings";
import { CliSettings, McpSettings, SkillsSettings } from "./ExtensionsSettings";
import { DigitalHumansSettings } from "./DigitalHumansSettings";
import type {
  AgentServiceState,
  ApprovalMode,
  AvailableModel,
  DigitalHuman,
  ModelDraft,
  ModelSetting,
  ReasoningEffort,
  WorkspaceEntry,
} from "../types";

export type SettingsSection = "models" | "digital-humans" | "service" | "preferences" | "plugins" | "skills" | "mcp" | "cli";

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
  /** 数字人管理（设置页分栏） */
  digitalHumans: DigitalHuman[];
  digitalHumansLoading: boolean;
  digitalHumanProjects: WorkspaceEntry[];
  onDigitalHumansChanged: () => void;
  onAddDigitalHuman: () => void;
  /** 打开编辑数字人弹窗（App.tsx 内统一渲染弹窗实例） */
  onEditDigitalHuman: (human: DigitalHuman) => void;
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

function PuzzleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M9.5 4.5h5v3.2a2.3 2.3 0 1 0 2.6 0V4.5h2.4v5h-3.2a2.3 2.3 0 1 1 0 2.6h3.2v7.4h-5v-3.2a2.3 2.3 0 1 0-2.6 0v3.2H4.5v-5h3.2a2.3 2.3 0 1 1 0-2.6H4.5V4.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function SkillsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 3.5l2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function McpIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 7.8l3 7.4M16.5 7.8l-3 7.4M8.5 6h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CliIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UsersGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.8 19.2c.6-2.9 2.7-4.7 5.2-4.7s4.6 1.8 5.2 4.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15.5 5.4a3.2 3.2 0 0 1 0 5.9M17.6 14.9c1.5.7 2.6 2.2 3 4.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "set-switch on" : "set-switch"}
      disabled={disabled}
      onClick={onChange}
    />
  );
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
  digitalHumans,
  digitalHumansLoading,
  digitalHumanProjects,
  onDigitalHumansChanged,
  onAddDigitalHuman,
  onEditDigitalHuman,
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

  const sections: Array<{ id: SettingsSection; title: string; description: string; badge?: string; icon: ReactNode; group: string }> = [
    { id: "models", title: "模型", description: "管理模型渠道、API Key，切换当前使用的模型", badge: String(modelSettings.length), icon: <SlidersIcon className="icon-16" />, group: "AI 能力" },
    { id: "digital-humans", title: "数字人", description: "管理数字员工：角色、授权、项目归属与健康状态", badge: String(digitalHumans.length), icon: <UsersGlyph className="icon-16" />, group: "AI 能力" },
    { id: "skills", title: "Skills 技能", description: "安装技能包（压缩包 / Git）、启停与删除", icon: <SkillsIcon className="icon-16" />, group: "扩展" },
    { id: "mcp", title: "MCP 服务", description: "添加、测试与管理 MCP server 连接", icon: <McpIcon className="icon-16" />, group: "扩展" },
    { id: "cli", title: "CLI 子智能体", description: "配置 claude / codex / ACP 外部 CLI 命令", icon: <CliIcon className="icon-16" />, group: "扩展" },
    { id: "plugins", title: "插件", description: "安装插件包、上传 JAR，配置插件参数", icon: <PuzzleIcon className="icon-16" />, group: "扩展" },
    { id: "service", title: "服务", description: "查看本地智能体服务连接状态与 Java Runtime", icon: <SettingsIcon className="icon-16" />, group: "系统" },
    { id: "preferences", title: "偏好", description: "工具执行审批策略、沙箱边界与推理强度", icon: <ShieldIcon className="icon-16" />, group: "系统" },
  ];
  const activeMeta = sections.find((section) => section.id === activeSection) || sections[0];
  const activeTitle = activeMeta.title;
  const groupedSections = sections.reduce<Array<{ group: string; items: typeof sections }>>((groups, section) => {
    const group = groups.find((item) => item.group === section.group);
    if (group) group.items.push(section);
    else groups.push({ group: section.group, items: [section] });
    return groups;
  }, []);

  return (
    <div className="settings-page settings-v2">
      <aside className="set-nav">
        <button className="set-back" onClick={onBack}>
          <ArrowLeftIcon className="icon-14" />
          <span>返回应用</span>
        </button>
        <nav className="set-nav-scroll" aria-label="设置目录">
          {error ? <div className="set-error">{error}</div> : null}
          {groupedSections.map((group) => (
            <div key={group.group} className="set-nav-group">
              <div className="set-nav-group-title">{group.group}</div>
              {group.items.map((section) => (
                <button
                  key={section.id}
                  className={activeSection === section.id ? "set-nav-item active" : "set-nav-item"}
                  onClick={() => onSectionChange(section.id)}
                >
                  <span className="set-nav-icon" aria-hidden="true">{section.icon}</span>
                  <span className="set-nav-label">{section.title}</span>
                  {section.badge ? <i className="set-nav-badge">{section.badge}</i> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="set-nav-footer">
          <span className={serviceStatus === "running" ? "set-status-dot ok" : "set-status-dot"} />
          <span>{serviceStatus === "running" ? `本地服务已连接 · ${service?.port ? `127.0.0.1:${service.port}` : ""}` : serviceStatus === "starting" ? "服务启动中…" : "等待服务连接"}</span>
        </div>
      </aside>

      <main className="set-main">
        <header className="set-head" data-tauri-drag-region>
          <h1>{activeTitle}</h1>
          <div className="set-head-actions">
            {activeSection === "models" ? (
              <>
                <button className="ghost-action compact" onClick={onDiscover} disabled={syncingModels}>{syncingModels ? "同步中…" : "同步模型"}</button>
                <button className="primary-action compact" onClick={() => setShowForm(true)}>添加模型</button>
              </>
            ) : null}
            {activeSection === "digital-humans" ? (
              <button className="primary-action compact" onClick={onAddDigitalHuman}>
                添加数字人
              </button>
            ) : null}
            {activeSection === "service" ? (
              <button className="primary-action compact" onClick={onReconnect} disabled={serviceStatus === "starting"}>{serviceStatus === "starting" ? "连接中…" : "重新连接"}</button>
            ) : null}
          </div>
          <button className="set-close" onClick={onBack} aria-label="关闭设置" title="关闭设置">
            <CloseIcon className="icon-16" />
          </button>
        </header>

        <div className="set-scroll">
          {activeSection === "models" ? (
            <>
              <div className="set-section-label">模型配置</div>
              <section className="set-card">
                {modelSettings.length === 0 ? <div className="set-empty">还没有模型配置，点击右上角「添加模型」开始。</div> : null}
                {modelSettings.map((model) => (
                  <article key={model.channelCode || model.modelCode} className={`set-model ${model.active ? "active" : ""}`}>
                    <div className="set-model-top">
                      <div className="set-model-info">
                        <strong>{model.displayName || model.channelCode}</strong>
                        <span>{model.modelCode} · {model.baseUrl || "未配置地址"} · {protocolLabel(model.protocol)}</span>
                      </div>
                      <div className="set-model-side">
                        {model.active ? <span className="set-chip live">使用中</span> : null}
                        <Switch
                          checked={model.enabled !== false}
                          disabled={!model.channelCode}
                          label={model.enabled !== false ? "停用该模型" : "启用该模型"}
                          onChange={() => onToggleModel(model)}
                        />
                      </div>
                    </div>
                    <div className="set-model-actions">
                      <button className="ghost-action compact" onClick={() => onActivate(model.channelCode || "")} disabled={model.active || model.enabled === false || !model.channelCode}>使用</button>
                      <button className="ghost-action compact" onClick={() => { onEdit(model); setShowForm(true); }}>编辑</button>
                      <button className="danger-action compact" onClick={() => onDelete(model.channelCode || "")} disabled={!model.channelCode}>删除</button>
                    </div>
                  </article>
                ))}
              </section>

              <div className="set-section-label">运行时可用模型</div>
              <section className="set-card">
                <div className="set-runtime-grid">
                  {availableModels.length === 0 ? <div className="set-empty">暂无运行时模型</div> : null}
                  {availableModels.map((model) => (
                    <article key={`${model.channelCode}-${model.modelCode}`} className="set-runtime">
                      <strong>{model.displayName || model.modelCode}</strong>
                      <span>{model.modelCode}</span>
                      <small>{model.channelCode}</small>
                    </article>
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {activeSection === "digital-humans" ? (
            <DigitalHumansSettings
              servicePort={service?.port ?? null}
              humans={digitalHumans}
              loading={digitalHumansLoading}
              projects={digitalHumanProjects}
              onChanged={onDigitalHumansChanged}
              onEditHuman={onEditDigitalHuman}
            />
          ) : null}

          {activeSection === "plugins" ? (
            <PluginsSettings servicePort={service?.port ?? null} />
          ) : null}

          {activeSection === "skills" ? (
            <SkillsSettings servicePort={service?.port ?? null} />
          ) : null}

          {activeSection === "mcp" ? (
            <McpSettings servicePort={service?.port ?? null} />
          ) : null}

          {activeSection === "cli" ? (
            <CliSettings servicePort={service?.port ?? null} />
          ) : null}

          {activeSection === "service" ? (
            <>
              <div className="set-section-label">智能体服务连接</div>
              <section className="set-card">
                <div className="set-row">
                  <div className="set-row-main">
                    <strong>运行状态</strong>
                    <span>{serviceError || "本地 Runtime 正常"}</span>
                  </div>
                  <span className={`set-chip ${serviceStatus === "running" ? "live" : ""}`}>
                    {serviceStatus === "running" ? "已连接" : serviceStatus === "starting" ? "正在启动" : "不可用"}
                  </span>
                </div>
                <div className="set-row">
                  <div className="set-row-main">
                    <strong>服务地址</strong>
                    <span>仅监听本机，不在主对话区暴露端口。</span>
                  </div>
                  <span className="set-value">{service?.port ? `127.0.0.1:${service.port}` : "待分配"}</span>
                </div>
                <div className="set-row">
                  <div className="set-row-main">
                    <strong>JAR 路径</strong>
                    <span>应用启动时自动拉起智能体服务。</span>
                  </div>
                  <span className="set-value mono" title={service?.jarPath || ""}>{service?.jarPath || "由桌面端后台托管"}</span>
                </div>
                <div className="set-row">
                  <div className="set-row-main">
                    <strong>Java Runtime</strong>
                    <span>{runtimeStatusDetail(service, serviceError)}</span>
                  </div>
                  <span className="set-value">
                    {service?.javaVersion ? `Java ${service.javaVersion} · ${runtimeSourceLabel(service.runtimeSource)}` : runtimeSourceLabel(service?.runtimeSource || null)}
                  </span>
                </div>
                <div className="set-row">
                  <div className="set-row-main">
                    <strong>运行时模型</strong>
                    <span>启用且健康可用的渠道数量。</span>
                  </div>
                  <span className="set-value">{availableModels.length}</span>
                </div>
              </section>
            </>
          ) : null}

          {activeSection === "preferences" ? (
            <>
              <div className="set-section-label">工具执行审批</div>
              <section className="set-card">
                <div className="set-option-list" role="radiogroup" aria-label="工具执行审批">
                  {approvalOptions.map((option) => (
                    <label key={option.value} className={`set-option ${approvalMode === option.value ? "active" : ""}`}>
                      <input
                        type="radio"
                        name="approval-mode"
                        checked={approvalMode === option.value}
                        onChange={() => onApprovalModeChange(option.value)}
                      />
                      <div className="set-row-main">
                        <strong>{option.title}</strong>
                        <span>{option.detail}</span>
                      </div>
                      <i aria-hidden="true">{approvalMode === option.value ? "当前" : ""}</i>
                    </label>
                  ))}
                </div>
              </section>

              <div className="set-section-label">推理强度</div>
              <section className="set-card">
                <div className="set-option-list" role="radiogroup" aria-label="推理强度">
                  {reasoningOptions.map((option) => (
                    <label key={option.value} className={`set-option ${reasoningEffort === option.value ? "active" : ""}`}>
                      <input
                        type="radio"
                        name="reasoning-effort"
                        checked={reasoningEffort === option.value}
                        onChange={() => onReasoningEffortChange(option.value)}
                      />
                      <div className="set-row-main">
                        <strong>{option.title}</strong>
                        <span>{option.detail}</span>
                      </div>
                      <i aria-hidden="true">{reasoningEffort === option.value ? "当前" : ""}</i>
                    </label>
                  ))}
                </div>
              </section>
            </>
          ) : null}
        </div>
      </main>

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
