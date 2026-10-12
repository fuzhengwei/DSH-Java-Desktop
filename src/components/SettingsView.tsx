import i18n from "../i18n";
import { useState, type ReactNode } from "react";
import { ArrowLeftIcon, SettingsIcon, ShieldIcon, SlidersIcon } from "./icons";
import PluginsSettings from "./PluginsSettings";
import { CliSettings, McpSettings, SkillsSettings } from "./ExtensionsSettings";
import { DigitalHumansSettings } from "./DigitalHumansSettings";
import type { AgentServiceState, ApprovalMode, AvailableModel, DigitalHuman, ModelDraft, ModelSetting, ReasoningEffort, WorkspaceEntry } from "../types";
const t = i18n.t.bind(i18n);
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
const approvalOptions: Array<{
  value: ApprovalMode;
  title: string;
  detail: string;
}> = [{
  value: "REQUEST_APPROVAL",
  title: t("SettingsView.0"),
  detail: t("SettingsView.1")
}, {
  value: "AUTO_APPROVE",
  title: t("SettingsView.2"),
  detail: t("SettingsView.3")
}, {
  value: "FULL_OPEN",
  title: t("SettingsView.4"),
  detail: t("SettingsView.5")
}];
const reasoningOptions: Array<{
  value: ReasoningEffort;
  title: string;
  detail: string;
}> = [{
  value: "low",
  title: t("SettingsView.6"),
  detail: t("SettingsView.7")
}, {
  value: "medium",
  title: t("SettingsView.8"),
  detail: t("SettingsView.9")
}, {
  value: "high",
  title: t("SettingsView.10"),
  detail: t("SettingsView.11")
}];
function protocolLabel(protocol?: string) {
  if (protocol === "anthropic") return "Anthropic Messages";
  if (protocol === "ollama") return t("SettingsView.12");
  return t("SettingsView.13");
}
function runtimeSourceLabel(source: AgentServiceState["runtimeSource"]) {
  if (source === "bundled") return t("SettingsView.14");
  if (source === "custom") return t("SettingsView.15");
  if (source === "system") return t("SettingsView.16");
  return t("SettingsView.17");
}
function PuzzleIcon({
  className
}: {
  className?: string;
}) {
  return <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M9.5 4.5h5v3.2a2.3 2.3 0 1 0 2.6 0V4.5h2.4v5h-3.2a2.3 2.3 0 1 1 0 2.6h3.2v7.4h-5v-3.2a2.3 2.3 0 1 0-2.6 0v3.2H4.5v-5h3.2a2.3 2.3 0 1 1 0-2.6H4.5V4.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>;
}
function SkillsIcon({
  className
}: {
  className?: string;
}) {
  return <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 3.5l2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>;
}
function McpIcon({
  className
}: {
  className?: string;
}) {
  return <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 7.8l3 7.4M16.5 7.8l-3 7.4M8.5 6h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>;
}
function CliIcon({
  className
}: {
  className?: string;
}) {
  return <svg viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>;
}
function UsersGlyph({
  className
}: {
  className?: string;
}) {
  return <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.8 19.2c.6-2.9 2.7-4.7 5.2-4.7s4.6 1.8 5.2 4.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15.5 5.4a3.2 3.2 0 0 1 0 5.9M17.6 14.9c1.5.7 2.6 2.2 3 4.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>;
}
function CloseIcon({
  className
}: {
  className?: string;
}) {
  return <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>;
}
function Switch({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={checked ? "set-switch on" : "set-switch"} disabled={disabled} onClick={onChange} />;
}
function runtimeStatusDetail(service: AgentServiceState | null, serviceError: string) {
  if (!service) return serviceError || t("SettingsView.18");
  if (service.runtimeStatus === "missing") return serviceError || t("SettingsView.19");
  if (service.runtimeStatus === "too_old") return serviceError || t("SettingsView.20");
  if (service.runtimeStatus === "invalid") return serviceError || t("SettingsView.21");
  return service.javaPath || serviceError || t("SettingsView.22");
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
  onEditDigitalHuman
}: SettingsViewProps) {
  const [showForm, setShowForm] = useState(false);
  const modelOptions = Array.from(new Set([...availableModels.flatMap(model => model.modelCode ? [model.modelCode] : []), ...discoveredModels]));
  const canSave = draft.displayName.trim().length > 0 && draft.modelCode.trim().length > 0 && draft.baseUrl.trim().length > 0 && (draft.protocol === "ollama" || draft.apiKeyRef.trim().length > 0);
  const closeForm = () => {
    setShowForm(false);
    onCancelEdit();
  };
  const saveForm = async () => {
    const saved = await onSave();
    if (saved) closeForm();
  };
  const sections: Array<{
    id: SettingsSection;
    title: string;
    description: string;
    badge?: string;
    icon: ReactNode;
    group: string;
  }> = [{
    id: "models",
    title: t("SettingsView.23"),
    description: t("SettingsView.24"),
    badge: String(modelSettings.length),
    icon: <SlidersIcon className="icon-16" />,
    group: t("SettingsView.25")
  }, {
    id: "digital-humans",
    title: t("SettingsView.26"),
    description: t("SettingsView.27"),
    badge: String(digitalHumans.length),
    icon: <UsersGlyph className="icon-16" />,
    group: t("SettingsView.28")
  }, {
    id: "skills",
    title: t("SettingsView.29"),
    description: t("SettingsView.30"),
    icon: <SkillsIcon className="icon-16" />,
    group: t("SettingsView.31")
  }, {
    id: "mcp",
    title: t("SettingsView.32"),
    description: t("SettingsView.33"),
    icon: <McpIcon className="icon-16" />,
    group: t("SettingsView.34")
  }, {
    id: "cli",
    title: t("SettingsView.35"),
    description: t("SettingsView.36"),
    icon: <CliIcon className="icon-16" />,
    group: t("SettingsView.37")
  }, {
    id: "plugins",
    title: t("SettingsView.38"),
    description: t("SettingsView.39"),
    icon: <PuzzleIcon className="icon-16" />,
    group: t("SettingsView.40")
  }, {
    id: "service",
    title: t("SettingsView.41"),
    description: t("SettingsView.42"),
    icon: <SettingsIcon className="icon-16" />,
    group: t("SettingsView.43")
  }, {
    id: "preferences",
    title: t("SettingsView.44"),
    description: t("SettingsView.45"),
    icon: <ShieldIcon className="icon-16" />,
    group: t("SettingsView.46")
  }];
  const activeMeta = sections.find(section => section.id === activeSection) || sections[0];
  const activeTitle = activeMeta.title;
  const groupedSections = sections.reduce<Array<{
    group: string;
    items: typeof sections;
  }>>((groups, section) => {
    const group = groups.find(item => item.group === section.group);
    if (group) group.items.push(section);else groups.push({
      group: section.group,
      items: [section]
    });
    return groups;
  }, []);
  return <div className="settings-page settings-v2">
      <aside className="set-nav">
        <button className="set-back" onClick={onBack}>
          <ArrowLeftIcon className="icon-14" />
          <span>{t("SettingsView.47")}</span>
        </button>
        <nav className="set-nav-scroll" aria-label={t("SettingsView.48")}>
          {error ? <div className="set-error">{error}</div> : null}
          {groupedSections.map(group => <div key={group.group} className="set-nav-group">
              <div className="set-nav-group-title">{group.group}</div>
              {group.items.map(section => <button key={section.id} className={activeSection === section.id ? "set-nav-item active" : "set-nav-item"} onClick={() => onSectionChange(section.id)}>
                  <span className="set-nav-icon" aria-hidden="true">{section.icon}</span>
                  <span className="set-nav-label">{section.title}</span>
                  {section.badge ? <i className="set-nav-badge">{section.badge}</i> : null}
                </button>)}
            </div>)}
        </nav>
        <div className="set-nav-footer">
          <span className={serviceStatus === "running" ? "set-status-dot ok" : "set-status-dot"} />
          <span>{serviceStatus === "running" ? t("SettingsView.106", {
            v0: service?.port ? `127.0.0.1:${service.port}` : ""
          }) : serviceStatus === "starting" ? t("SettingsView.49") : t("SettingsView.50")}</span>
        </div>
      </aside>

      <main className="set-main">
        <header className="set-head" data-tauri-drag-region>
          <h1>{activeTitle}</h1>
          <div className="set-head-actions">
            {activeSection === "models" ? <>
                <button className="ghost-action compact" onClick={onDiscover} disabled={syncingModels}>{syncingModels ? t("SettingsView.51") : t("SettingsView.52")}</button>
                <button className="primary-action compact" onClick={() => setShowForm(true)}>{t("SettingsView.53")}</button>
              </> : null}
            {activeSection === "digital-humans" ? <button className="primary-action compact" onClick={onAddDigitalHuman}>{t("SettingsView.54")}</button> : null}
            {activeSection === "service" ? <button className="primary-action compact" onClick={onReconnect} disabled={serviceStatus === "starting"}>{serviceStatus === "starting" ? t("SettingsView.55") : t("SettingsView.56")}</button> : null}
          </div>
          <button className="set-close" onClick={onBack} aria-label={t("SettingsView.57")} title={t("SettingsView.58")}>
            <CloseIcon className="icon-16" />
          </button>
        </header>

        <div className="set-scroll">
          {activeSection === "models" ? <>
              <div className="set-section-label">{t("SettingsView.59")}</div>
              <section className="set-card">
                {modelSettings.length === 0 ? <div className="set-empty">{t("SettingsView.60")}</div> : null}
                {modelSettings.map(model => <article key={model.channelCode || model.modelCode} className={`set-model ${model.active ? "active" : ""}`}>
                    <div className="set-model-top">
                      <div className="set-model-info">
                        <strong>{model.displayName || model.channelCode}</strong>
                        <span>{model.modelCode} · {model.baseUrl || t("SettingsView.61")} · {protocolLabel(model.protocol)}</span>
                      </div>
                      <div className="set-model-side">
                        {model.active ? <span className="set-chip live">{t("SettingsView.62")}</span> : null}
                        <Switch checked={model.enabled !== false} disabled={!model.channelCode} label={model.enabled !== false ? t("SettingsView.63") : t("SettingsView.64")} onChange={() => onToggleModel(model)} />
                      </div>
                    </div>
                    <div className="set-model-actions">
                      <button className="ghost-action compact" onClick={() => onActivate(model.channelCode || "")} disabled={model.active || model.enabled === false || !model.channelCode}>{t("SettingsView.65")}</button>
                      <button className="ghost-action compact" onClick={() => {
                  onEdit(model);
                  setShowForm(true);
                }}>{t("SettingsView.66")}</button>
                      <button className="danger-action compact" onClick={() => onDelete(model.channelCode || "")} disabled={!model.channelCode}>{t("SettingsView.67")}</button>
                    </div>
                  </article>)}
              </section>

              <div className="set-section-label">{t("SettingsView.68")}</div>
              <section className="set-card">
                <div className="set-runtime-grid">
                  {availableModels.length === 0 ? <div className="set-empty">{t("SettingsView.69")}</div> : null}
                  {availableModels.map(model => <article key={`${model.channelCode}-${model.modelCode}`} className="set-runtime">
                      <strong>{model.displayName || model.modelCode}</strong>
                      <span>{model.modelCode}</span>
                      <small>{model.channelCode}</small>
                    </article>)}
                </div>
              </section>
            </> : null}

          {activeSection === "digital-humans" ? <DigitalHumansSettings servicePort={service?.port ?? null} humans={digitalHumans} loading={digitalHumansLoading} projects={digitalHumanProjects} onChanged={onDigitalHumansChanged} onEditHuman={onEditDigitalHuman} /> : null}

          {activeSection === "plugins" ? <PluginsSettings servicePort={service?.port ?? null} /> : null}

          {activeSection === "skills" ? <SkillsSettings servicePort={service?.port ?? null} /> : null}

          {activeSection === "mcp" ? <McpSettings servicePort={service?.port ?? null} /> : null}

          {activeSection === "cli" ? <CliSettings servicePort={service?.port ?? null} /> : null}

          {activeSection === "service" ? <>
              <div className="set-section-label">{t("SettingsView.70")}</div>
              <section className="set-card">
                <div className="set-row">
                  <div className="set-row-main">
                    <strong>{t("SettingsView.71")}</strong>
                    <span>{serviceError || t("SettingsView.72")}</span>
                  </div>
                  <span className={`set-chip ${serviceStatus === "running" ? "live" : ""}`}>
                    {serviceStatus === "running" ? t("SettingsView.73") : serviceStatus === "starting" ? t("SettingsView.74") : t("SettingsView.75")}
                  </span>
                </div>
                <div className="set-row">
                  <div className="set-row-main">
                    <strong>{t("SettingsView.76")}</strong>
                    <span>{t("SettingsView.77")}</span>
                  </div>
                  <span className="set-value">{service?.port ? `127.0.0.1:${service.port}` : t("SettingsView.78")}</span>
                </div>
                <div className="set-row">
                  <div className="set-row-main">
                    <strong>{t("SettingsView.79")}</strong>
                    <span>{t("SettingsView.80")}</span>
                  </div>
                  <span className="set-value mono" title={service?.jarPath || ""}>{service?.jarPath || t("SettingsView.81")}</span>
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
                    <strong>{t("SettingsView.82")}</strong>
                    <span>{t("SettingsView.83")}</span>
                  </div>
                  <span className="set-value">{availableModels.length}</span>
                </div>
              </section>
            </> : null}

          {activeSection === "preferences" ? <>
              <div className="set-section-label">{t("SettingsView.84")}</div>
              <section className="set-card">
                <div className="set-option-list" role="radiogroup" aria-label={t("SettingsView.85")}>
                  {approvalOptions.map(option => <label key={option.value} className={`set-option ${approvalMode === option.value ? "active" : ""}`}>
                      <input type="radio" name="approval-mode" checked={approvalMode === option.value} onChange={() => onApprovalModeChange(option.value)} />
                      <div className="set-row-main">
                        <strong>{option.title}</strong>
                        <span>{option.detail}</span>
                      </div>
                      <i aria-hidden="true">{approvalMode === option.value ? t("SettingsView.86") : ""}</i>
                    </label>)}
                </div>
              </section>

              <div className="set-section-label">{t("SettingsView.87")}</div>
              <section className="set-card">
                <div className="set-option-list" role="radiogroup" aria-label={t("SettingsView.88")}>
                  {reasoningOptions.map(option => <label key={option.value} className={`set-option ${reasoningEffort === option.value ? "active" : ""}`}>
                      <input type="radio" name="reasoning-effort" checked={reasoningEffort === option.value} onChange={() => onReasoningEffortChange(option.value)} />
                      <div className="set-row-main">
                        <strong>{option.title}</strong>
                        <span>{option.detail}</span>
                      </div>
                      <i aria-hidden="true">{reasoningEffort === option.value ? t("SettingsView.89") : ""}</i>
                    </label>)}
                </div>
              </section>
            </> : null}
        </div>
      </main>

      {showForm ? <div className="modal-overlay" onClick={closeForm}>
          <div className="modal model-modal" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{draft.channelCode ? t("SettingsView.90") : t("SettingsView.91")}</h3>
              <button className="modal-close" onClick={closeForm}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <label className="form-field span-2">
                  <span>{t("SettingsView.92")}</span>
                  <select value={draft.protocol} onChange={event => onDraftChange({
                ...draft,
                protocol: event.target.value
              })}>
                    <option value="openai">{t("SettingsView.93")}</option>
                    <option value="anthropic">Anthropic Messages</option>
                    <option value="ollama">{t("SettingsView.94")}</option>
                  </select>
                </label>
                <label className="form-field span-2">
                  <span>{t("SettingsView.95")}</span>
                  <input value={draft.displayName} placeholder={t("SettingsView.96")} onChange={event => onDraftChange({
                ...draft,
                displayName: event.target.value
              })} />
                </label>
                <label className="form-field span-2">
                  <span>Base URL</span>
                  <input value={draft.baseUrl} placeholder="https://api.deepseek.com/v1" onChange={event => onDraftChange({
                ...draft,
                baseUrl: event.target.value
              })} />
                </label>
                <label className="form-field span-2">
                  <span>API Key</span>
                  <input type="password" value={draft.apiKeyRef} placeholder={draft.protocol === "ollama" ? t("SettingsView.97") : t("SettingsView.98")} onChange={event => onDraftChange({
                ...draft,
                apiKeyRef: event.target.value
              })} />
                </label>
                <label className="form-field span-2">
                  <span>{t("SettingsView.99")}</span>
                  <input list="desktop-model-options" value={draft.modelCode} placeholder={t("SettingsView.100")} onChange={event => onDraftChange({
                ...draft,
                modelCode: event.target.value
              })} />
                  <datalist id="desktop-model-options">
                    {modelOptions.map(model => <option key={model} value={model} />)}
                  </datalist>
                  {modelOptions.length > 0 ? <div className="suggestion-row">
                      {modelOptions.slice(0, 8).map(model => <button key={model} type="button" className={model === draft.modelCode ? "model-suggestion active" : "model-suggestion"} onClick={() => onDraftChange({
                  ...draft,
                  modelCode: model
                })}>{model}</button>)}
                    </div> : null}
                </label>
              </div>
            </div>
            <div className="modal-actions">
              <button className="ghost-action" onClick={onDiscover} disabled={syncingModels}>{syncingModels ? t("SettingsView.101") : t("SettingsView.102")}</button>
              <button className="ghost-action" onClick={closeForm}>{t("SettingsView.103")}</button>
              <button className="primary-action compact" onClick={() => void saveForm()} disabled={savingModel || !canSave}>
                {savingModel ? t("SettingsView.104") : t("SettingsView.105")}
              </button>
            </div>
          </div>
        </div> : null}
    </div>;
}