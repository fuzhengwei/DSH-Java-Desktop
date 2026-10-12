import i18n from "../i18n";
import { useCallback, useEffect, useState } from "react";
import type { DigitalHuman, WorkspaceEntry } from "../types";
import { assignDigitalHumanToProject, deleteDigitalHuman, healthCheck, saveCredential, updateDigitalHuman, type DigitalHumanDraft } from "../lib/digital-human-client";
import { EditIcon, PlusIcon, RefreshIcon, TrashIcon } from "./icons";
const t = i18n.t.bind(i18n);
const AVATAR_OPTIONS = ["🛠️", "📊", "✍️", "☕", "🔍", "🚀", "🧪", "📦", "🛡️", "📚", "🤖", "🌐"];
const COLOR_OPTIONS = ["#4160f0", "#2f855a", "#b7791f", "#7c5cd6", "#c53030", "#0e7490", "#be5a0e", "#4a5568"];
type EditFormState = {
  displayName: string;
  avatarRef: string;
  themeColor: string;
  purpose: string;
  roleTagsText: string;
  approvalPolicy: DigitalHuman["approvalPolicy"];
  concurrencyLimit: number;
  baseUrl: string;
  token: string;
};
const HEALTH_TEXT: Record<string, string> = {
  online: t("DigitalHumansSettings.0"),
  offline: t("DigitalHumansSettings.1"),
  unauthorized: t("DigitalHumansSettings.2"),
  degraded: t("DigitalHumansSettings.3"),
  unknown: t("DigitalHumansSettings.4")
};
function healthChipClass(health?: string): string {
  if (health === "online") return "live";
  if (health === "degraded" || health === "unauthorized") return "warn";
  return "";
}
function endpointLabel(human: DigitalHuman): string {
  if (human.endpoint.type === "local-dsh") return t("DigitalHumansSettings.5");
  if (human.endpoint.type === "a2a") return "A2A";
  return t("DigitalHumansSettings.6");
}
function hasRemoteEndpoint(human: DigitalHuman): boolean {
  return human.endpoint.type === "remote-dsh" || human.endpoint.type === "a2a";
}

/** 项目路径 → 条目 索引（组件模块级缓存，projects 变化时重建） */
let projectsIndex = new Map<string, WorkspaceEntry>();
function rebuildProjectsIndex(projects: WorkspaceEntry[]) {
  projectsIndex = new Map(projects.map(project => [project.path, project]));
}

/** 数字人当前归属的项目条目（projectPath 兜底支持以分隔符拼接的多个路径） */
function assignedProjects(human: DigitalHuman): WorkspaceEntry[] {
  if (!human.projectPath) return [];
  const paths = human.projectPath.split(/[:;]/).filter(Boolean);
  const matched = paths.map(path => projectsIndex.get(path)).filter((entry): entry is WorkspaceEntry => Boolean(entry));
  if (matched.length > 0) return matched;
  const direct = projectsIndex.get(human.projectPath);
  return direct ? [direct] : [];
}

/** 数字人当前归属的项目路径集合 */
function assignedProjectPaths(human: DigitalHuman): string[] {
  return assignedProjects(human).map(project => project.path);
}
export function DigitalHumansSettings({
  servicePort,
  humans,
  loading,
  projects,
  onChanged,
  onEditHuman
}: {
  servicePort: number | null;
  humans: DigitalHuman[];
  loading: boolean;
  projects: WorkspaceEntry[];
  onChanged: () => void;
  /** 打开编辑弹窗（外层统一管理选中态） */
  onEditHuman: (human: DigitalHuman) => void;
}) {
  const [actionError, setActionError] = useState("");
  const [checkingId, setCheckingId] = useState("");
  const [confirmingId, setConfirmingId] = useState("");
  /** 正在展开「归属项目」选择浮层的数字人 id */
  const [pickingId, setPickingId] = useState("");
  rebuildProjectsIndex(projects);
  const runHealthCheck = useCallback(async (human: DigitalHuman) => {
    setCheckingId(human.id);
    setActionError("");
    try {
      await healthCheck(servicePort, human);
      onChanged();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCheckingId("");
    }
  }, [onChanged, servicePort]);
  const remove = useCallback(async (human: DigitalHuman) => {
    setActionError("");
    try {
      await deleteDigitalHuman(servicePort, human.id);
      setConfirmingId("");
      onChanged();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [onChanged, servicePort]);
  const changeProject = useCallback((human: DigitalHuman, projectPath: string) => {
    void assignDigitalHumanToProject(servicePort, human.id, projectPath);
    onChanged();
  }, [onChanged, servicePort]);
  if (!servicePort) {
    return <div className="set-empty">{t("DigitalHumansSettings.7")}</div>;
  }
  return <>
      <div className="set-section-label">{t("DigitalHumansSettings.8")}</div>
      <section className="set-card">
        <div className="set-list-toolbar">
          <span>{loading ? t("DigitalHumansSettings.9") : t("DigitalHumansSettings.54", {
            v0: humans.length
          })}</span>
        </div>
        {actionError ? <div className="set-error">{actionError}</div> : null}
        {humans.length === 0 && !loading ? <div className="set-empty">{t("DigitalHumansSettings.10")}</div> : null}
        {humans.map(human => {
        const confirming = confirmingId === human.id;
        return <article key={human.id} className="set-dh">
              <div className="set-dh-top">
                <span className="set-dh-avatar" style={{
              background: human.themeColor
            }}>
                  {human.avatarRef}
                </span>
                <div className="set-row-main">
                  <strong>
                    {human.displayName}
                    <span className="set-dh-src">{endpointLabel(human)}{human.projectPath ? t("DigitalHumansSettings.11") : t("DigitalHumansSettings.12")}</span>
                  </strong>
                  <span>{human.purpose}</span>
                </div>
                <span className={`set-chip ${healthChipClass(human.endpoint.healthState)}`}>
                  {HEALTH_TEXT[human.endpoint.healthState || "unknown"]}
                </span>
              </div>
              <div className="set-dh-meta">
                <div className="set-dh-tags">
                  {human.roleTags.length > 0 ? human.roleTags.map(tag => <span key={tag} className="set-dh-tag">{tag}</span>) : <span className="set-dh-notag">{t("DigitalHumansSettings.13")}</span>}
                </div>
                <span className="set-dh-kv">{t("DigitalHumansSettings.14")}<b>{human.concurrencyLimit}</b></span>
                {human.endpoint.latencyMs != null ? <span className="set-dh-kv">{t("DigitalHumansSettings.15")}<b>{human.endpoint.latencyMs}ms</b></span> : null}
              </div>
              <div className="set-dh-actions">
                <div className="set-dh-projects">
                  {/* 归属项目以标签展示：全局为一个中性标签，归属为可移除的绿色标签，支持多选 */}
                  <button type="button" className={`set-dh-proj-tag${!human.projectPath ? " active" : ""}`} title={human.projectPath ? t("DigitalHumansSettings.16") : t("DigitalHumansSettings.17")} onClick={() => changeProject(human, "")}>{t("DigitalHumansSettings.18")}</button>
                  {assignedProjects(human).map(project => <button key={project.path} type="button" className="set-dh-proj-tag assigned" title={t("DigitalHumansSettings.55", {
                v0: project.name
              })} onClick={() => changeProject(human, "")}>
                      {project.name}
                      <i aria-hidden="true">×</i>
                    </button>)}
                  <div className="set-dh-proj-add-wrap">
                    <button type="button" className="set-dh-proj-tag add" title={t("DigitalHumansSettings.19")} onClick={() => setPickingId(pickingId === human.id ? "" : human.id)}>
                      <PlusIcon className="icon-12" />{t("DigitalHumansSettings.20")}</button>
                    {pickingId === human.id ? <div className="set-dh-proj-pop" role="menu" aria-label={t("DigitalHumansSettings.21")}>
                        {projects.length === 0 ? <div className="set-dh-proj-empty">{t("DigitalHumansSettings.22")}</div> : projects.map(project => {
                    const assigned = assignedProjectPaths(human).includes(project.path);
                    return <button key={project.path} type="button" role="menuitemcheckbox" aria-checked={assigned} className={assigned ? "set-dh-proj-opt assigned" : "set-dh-proj-opt"} onClick={() => {
                      changeProject(human, assigned ? "" : project.path);
                      setPickingId("");
                    }}>
                              <span>{project.name}</span>
                              {assigned ? <b>{t("DigitalHumansSettings.23")}</b> : null}
                            </button>;
                  })}
                      </div> : null}
                  </div>
                </div>
                <div className="set-dh-buttons">
                  <button className="ghost-action compact" onClick={() => onEditHuman(human)}>
                    <EditIcon className="icon-14" />{t("DigitalHumansSettings.24")}</button>
                  <button className="ghost-action compact" disabled={checkingId === human.id} onClick={() => void runHealthCheck(human)}>
                    <RefreshIcon className={`icon-14${checkingId === human.id ? " spinning" : ""}`} />
                    {checkingId === human.id ? t("DigitalHumansSettings.25") : t("DigitalHumansSettings.26")}
                  </button>
                  {confirming ? <>
                      <button className="danger-action compact" onClick={() => void remove(human)}>{t("DigitalHumansSettings.27")}</button>
                      <button className="ghost-action compact" onClick={() => setConfirmingId("")}>{t("DigitalHumansSettings.28")}</button>
                    </> : <button className="ghost-action compact danger-text" onClick={() => setConfirmingId(human.id)}>
                      <TrashIcon className="icon-14" />{t("DigitalHumansSettings.29")}</button>}
                </div>
              </div>
            </article>;
      })}
      </section>
    </>;
}

/** 设置页内的编辑数字人弹窗（复用主界面编辑表单结构，走设置页视觉） */
export function EditDigitalHumanSettingsModal({
  human,
  onClose,
  onSaved
}: {
  human: DigitalHuman;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditFormState>(() => ({
    displayName: human.displayName,
    avatarRef: human.avatarRef,
    themeColor: human.themeColor,
    purpose: human.purpose,
    roleTagsText: human.roleTags.join(", "),
    approvalPolicy: human.approvalPolicy,
    concurrencyLimit: human.concurrencyLimit,
    baseUrl: human.endpoint.baseUrl || "",
    token: ""
  }));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const patch = (partial: Partial<EditFormState>) => setForm(current => ({
    ...current,
    ...partial
  }));
  const save = async () => {
    const displayName = form.displayName.trim();
    const purpose = form.purpose.trim();
    if (!displayName || !purpose) {
      setError(t("DigitalHumansSettings.30"));
      return;
    }
    const baseUrl = form.baseUrl.trim().replace(/\/+$/, "");
    if (hasRemoteEndpoint(human) && !baseUrl) {
      setError(t("DigitalHumansSettings.31"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      let credentialRef = human.endpoint.credentialRef;
      if (form.token.trim()) {
        credentialRef = credentialRef || `cred_${Date.now().toString(36)}`;
        await saveCredential(credentialRef, form.token.trim());
      }
      const draft: Partial<DigitalHumanDraft> = {
        displayName,
        avatarRef: form.avatarRef,
        themeColor: form.themeColor,
        purpose,
        roleTags: form.roleTagsText.split(/[，,]/).map(item => item.trim()).filter(Boolean),
        approvalPolicy: form.approvalPolicy,
        concurrencyLimit: Math.max(1, Math.min(8, Math.round(form.concurrencyLimit) || 1)),
        endpoint: {
          ...human.endpoint,
          baseUrl: hasRemoteEndpoint(human) ? baseUrl : human.endpoint.baseUrl,
          credentialRef
        }
      };
      await updateDigitalHuman(null, human.id, draft);
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);
  return <div className="modal-overlay" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !saving) onClose();
  }}>
      <div className="modal dh-edit-modal skill-install-modal" role="dialog" aria-modal="true" aria-label={t("DigitalHumansSettings.32")}>
        <div className="modal-header">
          <h3>{t("DigitalHumansSettings.33")}</h3>
          <p>{t("DigitalHumansSettings.34")}</p>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label className="form-field span-2">
              <span>{t("DigitalHumansSettings.35")}</span>
              <input value={form.displayName} onChange={event => patch({
              displayName: event.target.value
            })} />
            </label>
            {hasRemoteEndpoint(human) ? <>
                <label className="form-field span-2">
                  <span>{t("DigitalHumansSettings.36")}</span>
                  <input placeholder="https://host:port" value={form.baseUrl} onChange={event => patch({
                baseUrl: event.target.value
              })} />
                </label>
                <label className="form-field span-2">
                  <span>{t("DigitalHumansSettings.37")}</span>
                  <input type="password" placeholder={human.endpoint.credentialRef ? t("DigitalHumansSettings.38") : t("DigitalHumansSettings.39")} value={form.token} onChange={event => patch({
                token: event.target.value
              })} />
                </label>
              </> : null}
            <div className="form-field span-2">
              <span>{t("DigitalHumansSettings.40")}</span>
              <div className="wizard-avatar-picker">
                {AVATAR_OPTIONS.map(emoji => <button key={emoji} type="button" className={`wizard-avatar-opt${form.avatarRef === emoji ? " sel" : ""}`} style={{
                background: form.themeColor
              }} onClick={() => patch({
                avatarRef: emoji
              })}>
                    {emoji}
                  </button>)}
              </div>
              <div className="wizard-color-row">
                {COLOR_OPTIONS.map(color => <button key={color} type="button" aria-label={t("DigitalHumansSettings.56", {
                v0: color
              })} className={`wizard-color-dot${form.themeColor === color ? " sel" : ""}`} style={{
                background: color
              }} onClick={() => patch({
                themeColor: color
              })} />)}
              </div>
            </div>
            <label className="form-field span-2">
              <span>{t("DigitalHumansSettings.41")}</span>
              <textarea rows={3} value={form.purpose} onChange={event => patch({
              purpose: event.target.value
            })} />
            </label>
            <label className="form-field span-2">
              <span>{t("DigitalHumansSettings.42")}</span>
              <input value={form.roleTagsText} onChange={event => patch({
              roleTagsText: event.target.value
            })} />
            </label>
            <div className="form-field span-2">
              <span>{t("DigitalHumansSettings.43")}</span>
              <div className="wizard-radio-group">
                {([["WRITE_REQUIRES_APPROVAL", t("DigitalHumansSettings.44"), t("DigitalHumansSettings.45")], ["AUTO_ALLOW", t("DigitalHumansSettings.46"), t("DigitalHumansSettings.47")], ["ALWAYS_CONFIRM", t("DigitalHumansSettings.48"), t("DigitalHumansSettings.49")]] as const).map(([value, name, desc]) => <button key={value} type="button" className={`wizard-radio${form.approvalPolicy === value ? " sel" : ""}`} onClick={() => patch({
                approvalPolicy: value
              })}>
                    <b>{name}</b>
                    <small>{desc}</small>
                  </button>)}
              </div>
            </div>
            <label className="form-field">
              <span>{t("DigitalHumansSettings.50")}</span>
              <input type="number" min={1} max={8} value={form.concurrencyLimit} onChange={event => patch({
              concurrencyLimit: Number(event.target.value) || 1
            })} />
            </label>
          </div>
          {error ? <div className="set-error">{error}</div> : null}
        </div>
        <div className="modal-actions">
          <button className="ghost-action" disabled={saving} onClick={onClose}>{t("DigitalHumansSettings.51")}</button>
          <button className="primary-action compact" disabled={saving} onClick={() => void save()}>
            {saving ? t("DigitalHumansSettings.52") : t("DigitalHumansSettings.53")}
          </button>
        </div>
      </div>
    </div>;
}