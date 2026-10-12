import i18n from "../i18n";
import { memo, useCallback, useEffect, useState } from "react";
import type { DigitalHuman, DigitalHumanHealth, ParticipantPresence, WorkspaceEntry } from "../types";
import { assignDigitalHumanToProject, deleteDigitalHuman, healthCheck, saveCredential, updateDigitalHuman, type DigitalHumanDraft } from "../lib/digital-human-client";
import { EditIcon, PlusIcon, RefreshIcon, TrashIcon, XIcon } from "./icons";
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
export const HEALTH_TEXT: Record<DigitalHumanHealth, string> = {
  online: t("DigitalHumanCatalog.0"),
  offline: t("DigitalHumanCatalog.1"),
  unauthorized: t("DigitalHumanCatalog.2"),
  degraded: t("DigitalHumanCatalog.3"),
  unknown: t("DigitalHumanCatalog.4")
};
export const PRESENCE_TEXT: Record<ParticipantPresence, string> = {
  idle: t("DigitalHumanCatalog.5"),
  thinking: t("DigitalHumanCatalog.6"),
  working: t("DigitalHumanCatalog.7"),
  waiting_input: t("DigitalHumanCatalog.8"),
  waiting_approval: t("DigitalHumanCatalog.9"),
  blocked: t("DigitalHumanCatalog.10"),
  done: t("DigitalHumanCatalog.11"),
  error: t("DigitalHumanCatalog.12")
};
export function healthDotClass(health?: DigitalHumanHealth): string {
  switch (health) {
    case "online":
      return "on";
    case "degraded":
      return "warn";
    case "unauthorized":
      return "warn";
    default:
      return "off";
  }
}

/** 数字人头像：emoji 渲染，带主题色与状态点 */
export const HumanAvatar = memo(function HumanAvatar({
  human,
  size = 38,
  health,
  presence,
  square = false
}: {
  human: Pick<DigitalHuman, "avatarRef" | "themeColor" | "displayName">;
  size?: number;
  health?: DigitalHumanHealth;
  presence?: ParticipantPresence;
  square?: boolean;
}) {
  const dotClass = presence ? `presence-${presence}` : health ? healthDotClass(health) : "";
  return <span className={`dh-avatar${square ? " square" : ""}`} style={{
    width: size,
    height: size,
    fontSize: Math.round(size * 0.44),
    background: human.themeColor,
    borderRadius: square ? Math.round(size * 0.3) : "50%"
  }} role="img" aria-label={human.displayName}>
      {human.avatarRef}
      {dotClass ? <span className={`dh-status-dot ${dotClass}`} /> : null}
    </span>;
});
function endpointLabel(human: DigitalHuman): string {
  if (human.endpoint.type === "local-dsh") return t("DigitalHumanCatalog.13");
  if (human.endpoint.type === "a2a") return "A2A";
  return t("DigitalHumanCatalog.14");
}
function hasRemoteEndpoint(human: DigitalHuman): boolean {
  return human.endpoint.type === "remote-dsh" || human.endpoint.type === "a2a";
}
type CatalogProps = {
  humans: DigitalHuman[];
  loading: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onChanged: () => void;
  port: number | null;
  /** 顶层项目列表，用于「归属项目」下拉 */
  projects?: WorkspaceEntry[];
};
export default function DigitalHumanCatalog({
  humans,
  loading,
  selectedId,
  onSelect,
  onAdd,
  onChanged,
  port,
  projects = []
}: CatalogProps) {
  const [checking, setChecking] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const selected = humans.find(item => item.id === selectedId) || humans[0];
  useEffect(() => {
    if (selected && selected.id !== selectedId) onSelect(selected.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);
  const runHealthCheck = useCallback(async () => {
    if (!selected || checking) return;
    setChecking(true);
    setActionError("");
    try {
      await healthCheck(port, selected);
      onChanged();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  }, [checking, onChanged, port, selected]);
  const remove = useCallback(async () => {
    if (!selected) return;
    setActionError("");
    try {
      await deleteDigitalHuman(port, selected.id);
      setConfirmingDelete(false);
      onChanged();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [onChanged, port, selected]);

  // 归属项目切换：服务端 project_path 为主、本地投影兜底，触发外层刷新
  const changeProject = useCallback((projectPath: string) => {
    if (!selected) return;
    void assignDigitalHumanToProject(port, selected.id, projectPath);
    onChanged();
  }, [onChanged, port, selected]);
  const startEdit = useCallback(() => {
    if (!selected) return;
    setActionError("");
    setEditError("");
    setConfirmingDelete(false);
    setEditForm({
      displayName: selected.displayName,
      avatarRef: selected.avatarRef,
      themeColor: selected.themeColor,
      purpose: selected.purpose,
      roleTagsText: selected.roleTags.join(", "),
      approvalPolicy: selected.approvalPolicy,
      concurrencyLimit: selected.concurrencyLimit,
      baseUrl: selected.endpoint.baseUrl || "",
      token: ""
    });
    setEditing(true);
  }, [selected]);
  const patchEditForm = useCallback((partial: Partial<EditFormState>) => {
    setEditForm(current => current ? {
      ...current,
      ...partial
    } : current);
  }, []);
  const saveEdit = useCallback(async () => {
    if (!selected || !editForm || savingEdit) return;
    const displayName = editForm.displayName.trim();
    const purpose = editForm.purpose.trim();
    if (!displayName || !purpose) {
      setEditError(t("DigitalHumanCatalog.15"));
      return;
    }
    const baseUrl = editForm.baseUrl.trim().replace(/\/+$/, "");
    if ((selected.endpoint.type === "remote-dsh" || selected.endpoint.type === "a2a") && !baseUrl) {
      setEditError(t("DigitalHumanCatalog.16"));
      return;
    }
    setSavingEdit(true);
    setEditError("");
    try {
      let credentialRef = selected.endpoint.credentialRef;
      if (editForm.token.trim()) {
        credentialRef = credentialRef || `cred_${Date.now().toString(36)}`;
        await saveCredential(credentialRef, editForm.token.trim());
      }
      const patch: Partial<DigitalHumanDraft> = {
        displayName,
        avatarRef: editForm.avatarRef,
        themeColor: editForm.themeColor,
        purpose,
        roleTags: editForm.roleTagsText.split(/[，,]/).map(item => item.trim()).filter(Boolean),
        approvalPolicy: editForm.approvalPolicy,
        concurrencyLimit: Math.max(1, Math.min(8, Math.round(editForm.concurrencyLimit) || 1)),
        endpoint: {
          ...selected.endpoint,
          baseUrl: selected.endpoint.type === "remote-dsh" || selected.endpoint.type === "a2a" ? baseUrl : selected.endpoint.baseUrl,
          credentialRef
        }
      };
      await updateDigitalHuman(port, selected.id, patch);
      setEditing(false);
      setEditForm(null);
      onChanged();
    } catch (caught) {
      setEditError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingEdit(false);
    }
  }, [editForm, onChanged, port, savingEdit, selected]);
  const selectedProjectName = selected?.projectPath ? projects.find(project => project.path === selected.projectPath)?.name || selected.projectPath : "";
  return <div className="dh-catalog">
      <div className="dh-catalog-list">
        <div className="dh-catalog-head">
          <h2>{t("DigitalHumanCatalog.17")}</h2>
          <button type="button" className="primary-action compact" onClick={onAdd}>
            <PlusIcon className="icon-14" />{t("DigitalHumanCatalog.18")}</button>
        </div>
        <div className="dh-catalog-scroll">
          {loading ? <div className="dh-empty">{t("DigitalHumanCatalog.19")}</div> : humans.length === 0 ? <div className="dh-empty">
              <div className="dh-empty-icon">🧑‍🚀</div>
              <p>{t("DigitalHumanCatalog.20")}</p>
              <p className="dh-empty-sub">{t("DigitalHumanCatalog.21")}</p>
              <button type="button" className="primary-action compact" onClick={onAdd}>{t("DigitalHumanCatalog.22")}</button>
            </div> : humans.map(human => <button key={human.id} type="button" className={`dh-item${selected?.id === human.id ? " active" : ""}`} onClick={() => onSelect(human.id)}>
                <HumanAvatar human={human} health={human.endpoint.healthState} />
                <span className="dh-item-main">
                  <span className="dh-item-name">
                    {human.displayName}
                    <span className="dh-src">{endpointLabel(human)}</span>
                  </span>
                  <span className="dh-item-meta">
                    <span className={`dot ${healthDotClass(human.endpoint.healthState)}`} />
                    {HEALTH_TEXT[human.endpoint.healthState || "unknown"]}
                    {" · "}
                    {human.purpose.length > 18 ? `${human.purpose.slice(0, 18)}…` : human.purpose}
                  </span>
                </span>
              </button>)}
        </div>
      </div>

      <div className="dh-catalog-detail">
        {selected ? <>
            <div className="dh-detail-hero">
              <HumanAvatar human={selected} size={64} square health={selected.endpoint.healthState} />
              <div className="dh-detail-title">
                <h1>
                  {selected.displayName}
                  <span className={`dh-health-pill ${healthDotClass(selected.endpoint.healthState)}`}>
                    {HEALTH_TEXT[selected.endpoint.healthState || "unknown"]}
                  </span>
                </h1>
                <p>{selected.purpose}</p>
              </div>
              <div className="dh-detail-actions">
                <button type="button" className="ghost-action compact" onClick={startEdit}>
                  <EditIcon className="icon-14" />{t("DigitalHumanCatalog.23")}</button>
                <button type="button" className="ghost-action compact" disabled={checking} onClick={() => void runHealthCheck()}>
                  <RefreshIcon className={`icon-14${checking ? " spinning" : ""}`} />
                  {checking ? t("DigitalHumanCatalog.24") : t("DigitalHumanCatalog.25")}
                </button>
                {confirmingDelete ? <>
                    <button type="button" className="danger-action compact" onClick={() => void remove()}>{t("DigitalHumanCatalog.26")}</button>
                    <button type="button" className="ghost-action compact" onClick={() => setConfirmingDelete(false)}>{t("DigitalHumanCatalog.27")}</button>
                  </> : <button type="button" className="ghost-action compact danger-text" onClick={() => setConfirmingDelete(true)}>
                    <TrashIcon className="icon-14" />{t("DigitalHumanCatalog.28")}</button>}
              </div>
            </div>
            {actionError ? <div className="error-banner">{actionError}</div> : null}
            <div className="dh-kv-grid">
              <section className="dh-kv-card">
                <h3>{t("DigitalHumanCatalog.29")}</h3>
                <p className="mono-line">{selected.endpoint.baseUrl || t("DigitalHumanCatalog.30")}</p>
                <div className="dh-perm-row">{t("DigitalHumanCatalog.31")}<b>{selected.endpoint.protocolVersion || "dsh.v1"}</b>
                  {selected.endpoint.credentialRef ? <>{t("DigitalHumanCatalog.32")}<b>{selected.endpoint.credentialRef}</b>{t("DigitalHumanCatalog.33")}</> : null}
                </div>
                {selected.endpoint.lastCheckedAt ? <div className="dh-perm-row">{t("DigitalHumanCatalog.34")}<b>{new Date(selected.endpoint.lastCheckedAt).toLocaleString()}</b>
                    {typeof selected.endpoint.latencyMs === "number" ? <>{t("DigitalHumanCatalog.35")}<b className="perm-ok">{selected.endpoint.latencyMs}ms</b></> : null}
                  </div> : null}
              </section>
              <section className="dh-kv-card">
                <h3>{t("DigitalHumanCatalog.36")}</h3>
                <div>
                  {selected.roleTags.length > 0 ? selected.roleTags.map(tag => <span key={tag} className="dh-tag">{tag}</span>) : <span className="dh-empty-sub">{t("DigitalHumanCatalog.37")}</span>}
                </div>
                <div className="dh-perm-row">{t("DigitalHumanCatalog.38")}<b>{selected.concurrencyLimit}</b></div>
              </section>
              <section className="dh-kv-card">
                <h3>{t("DigitalHumanCatalog.39")}</h3>
                <div className="dh-perm-row">
                  <span className="perm-ok">✓</span>{t("DigitalHumanCatalog.40")}<b>{t("DigitalHumanCatalog.41")}</b>
                </div>
                <div className="dh-perm-row">
                  <span className="perm-warn">●</span>{t("DigitalHumanCatalog.42")}{" "}
                  <b>{selected.approvalPolicy === "AUTO_ALLOW" ? t("DigitalHumanCatalog.43") : t("DigitalHumanCatalog.44")}</b>
                </div>
                <div className="dh-perm-row">
                  <span className="perm-warn">●</span>{t("DigitalHumanCatalog.45")}{" "}
                  <b>{selected.approvalPolicy === "ALWAYS_CONFIRM" ? t("DigitalHumanCatalog.46") : t("DigitalHumanCatalog.47")}</b>
                </div>
              </section>
              <section className="dh-kv-card">
                <h3>{t("DigitalHumanCatalog.48")}</h3>
                <select className="dh-project-select" value={selected.projectPath || ""} aria-label={t("DigitalHumanCatalog.49")} onChange={event => changeProject(event.target.value)}>
                  <option value="">{t("DigitalHumanCatalog.50")}</option>
                  {projects.map(project => <option key={project.path} value={project.path}>{project.name}</option>)}
                </select>
                <p className="dh-empty-sub" style={{
              marginTop: 6
            }}>
                  {selected.projectPath ? t("DigitalHumanCatalog.85", {
                v0: selectedProjectName
              }) : t("DigitalHumanCatalog.51")}
                </p>
              </section>
              <section className="dh-kv-card">
                <h3>{t("DigitalHumanCatalog.52")}</h3>
                <p className="dh-empty-sub" style={{
              lineHeight: 1.7
            }}>{t("DigitalHumanCatalog.53")}{selected.displayName}{t("DigitalHumanCatalog.54")}{hasRemoteEndpoint(selected) ? t("DigitalHumanCatalog.55") : t("DigitalHumanCatalog.56")}
                </p>
              </section>
            </div>
          </> : <div className="dh-empty" style={{
        margin: "auto"
      }}>
            <div className="dh-empty-icon">👈</div>
            <p>{t("DigitalHumanCatalog.57")}</p>
          </div>}
      </div>
      {editing && selected && editForm ? <EditDigitalHumanModal human={selected} form={editForm} error={editError} saving={savingEdit} onPatch={patchEditForm} onClose={() => {
      if (savingEdit) return;
      setEditing(false);
      setEditForm(null);
      setEditError("");
    }} onSave={() => void saveEdit()} /> : null}
    </div>;
}
function EditDigitalHumanModal({
  human,
  form,
  error,
  saving,
  onPatch,
  onClose,
  onSave
}: {
  human: DigitalHuman;
  form: EditFormState;
  error: string;
  saving: boolean;
  onPatch: (partial: Partial<EditFormState>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return <div className="modal-overlay" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
      <div className="modal dh-edit-modal" role="dialog" aria-modal="true" aria-label={t("DigitalHumanCatalog.58")}>
        <div className="dh-edit-head">
          <div>
            <h3>{t("DigitalHumanCatalog.59")}</h3>
            <p>{t("DigitalHumanCatalog.60")}</p>
          </div>
          <CloseButton onClick={onClose} label={t("DigitalHumanCatalog.61")} />
        </div>

        <div className="dh-edit-body">
          <label className="wizard-field">
            <span className="wizard-label">{t("DigitalHumanCatalog.62")}</span>
            <input className="wizard-input" value={form.displayName} onChange={event => onPatch({
            displayName: event.target.value
          })} />
          </label>

          {hasRemoteEndpoint(human) ? <>
              <label className="wizard-field">
                <span className="wizard-label">{t("DigitalHumanCatalog.63")}</span>
                <input className="wizard-input" placeholder="https://host:port" value={form.baseUrl} onChange={event => onPatch({
              baseUrl: event.target.value
            })} />
              </label>
              <label className="wizard-field">
                <span className="wizard-label">{t("DigitalHumanCatalog.64")}<small>{t("DigitalHumanCatalog.65")}</small></span>
                <input className="wizard-input" type="password" placeholder={human.endpoint.credentialRef ? t("DigitalHumanCatalog.66") : t("DigitalHumanCatalog.67")} value={form.token} onChange={event => onPatch({
              token: event.target.value
            })} />
              </label>
            </> : null}

          <div className="wizard-field">
            <span className="wizard-label">{t("DigitalHumanCatalog.68")}</span>
            <div className="wizard-avatar-picker">
              {AVATAR_OPTIONS.map(emoji => <button key={emoji} type="button" className={`wizard-avatar-opt${form.avatarRef === emoji ? " sel" : ""}`} style={{
              background: form.themeColor
            }} onClick={() => onPatch({
              avatarRef: emoji
            })}>
                  {emoji}
                </button>)}
            </div>
            <div className="wizard-color-row">
              {COLOR_OPTIONS.map(color => <button key={color} type="button" aria-label={t("DigitalHumanCatalog.86", {
              v0: color
            })} className={`wizard-color-dot${form.themeColor === color ? " sel" : ""}`} style={{
              background: color
            }} onClick={() => onPatch({
              themeColor: color
            })} />)}
            </div>
          </div>

          <label className="wizard-field">
            <span className="wizard-label">{t("DigitalHumanCatalog.69")}<small>{t("DigitalHumanCatalog.70")}</small></span>
            <textarea className="wizard-input" rows={3} value={form.purpose} onChange={event => onPatch({
            purpose: event.target.value
          })} />
          </label>

          <label className="wizard-field">
            <span className="wizard-label">{t("DigitalHumanCatalog.71")}<small>{t("DigitalHumanCatalog.72")}</small></span>
            <input className="wizard-input" value={form.roleTagsText} onChange={event => onPatch({
            roleTagsText: event.target.value
          })} />
          </label>

          <div className="wizard-field">
            <span className="wizard-label">{t("DigitalHumanCatalog.73")}</span>
            <div className="wizard-radio-group">
              {([["WRITE_REQUIRES_APPROVAL", t("DigitalHumanCatalog.74"), t("DigitalHumanCatalog.75")], ["AUTO_ALLOW", t("DigitalHumanCatalog.76"), t("DigitalHumanCatalog.77")], ["ALWAYS_CONFIRM", t("DigitalHumanCatalog.78"), t("DigitalHumanCatalog.79")]] as const).map(([value, name, desc]) => <button key={value} type="button" className={`wizard-radio${form.approvalPolicy === value ? " sel" : ""}`} onClick={() => onPatch({
              approvalPolicy: value
            })}>
                  <b>{name}</b>
                  <small>{desc}</small>
                </button>)}
            </div>
          </div>

          <label className="wizard-field">
            <span className="wizard-label">{t("DigitalHumanCatalog.80")}<small>{t("DigitalHumanCatalog.81")}</small></span>
            <input className="wizard-input wizard-input-narrow" type="number" min={1} max={8} value={form.concurrencyLimit} onChange={event => onPatch({
            concurrencyLimit: Number(event.target.value) || 1
          })} />
          </label>
          {error ? <div className="error-banner dh-edit-error">{error}</div> : null}
        </div>

        <div className="wizard-foot">
          <button type="button" className="ghost-action compact" disabled={saving} onClick={onClose}>{t("DigitalHumanCatalog.82")}</button>
          <span className="wizard-foot-spacer" />
          <button type="button" className="primary-action compact" disabled={saving} onClick={onSave}>
            {saving ? t("DigitalHumanCatalog.83") : t("DigitalHumanCatalog.84")}
          </button>
        </div>
      </div>
    </div>;
}
export function CloseButton({
  onClick,
  label
}: {
  onClick: () => void;
  label: string;
}) {
  return <button type="button" className="ghost-action compact" onClick={onClick} aria-label={label}>
      <XIcon className="icon-14" />
    </button>;
}