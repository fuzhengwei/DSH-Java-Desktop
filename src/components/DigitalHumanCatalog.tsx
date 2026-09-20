import { memo, useCallback, useEffect, useState } from "react";
import type { DigitalHuman, DigitalHumanHealth, ParticipantPresence, WorkspaceEntry } from "../types";
import {
  assignDigitalHumanToProject,
  deleteDigitalHuman,
  healthCheck,
  saveCredential,
  updateDigitalHuman,
  type DigitalHumanDraft,
} from "../lib/digital-human-client";
import { EditIcon, PlusIcon, RefreshIcon, TrashIcon, XIcon } from "./icons";

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
  online: "在线",
  offline: "离线",
  unauthorized: "未授权",
  degraded: "不稳定",
  unknown: "未知",
};

export const PRESENCE_TEXT: Record<ParticipantPresence, string> = {
  idle: "空闲",
  thinking: "思考中",
  working: "执行中",
  waiting_input: "等待输入",
  waiting_approval: "待审批",
  blocked: "阻塞",
  done: "已完成",
  error: "异常",
};

export function healthDotClass(health?: DigitalHumanHealth): string {
  switch (health) {
    case "online": return "on";
    case "degraded": return "warn";
    case "unauthorized": return "warn";
    default: return "off";
  }
}

/** 数字人头像：emoji 渲染，带主题色与状态点 */
export const HumanAvatar = memo(function HumanAvatar({
  human,
  size = 38,
  health,
  presence,
  square = false,
}: {
  human: Pick<DigitalHuman, "avatarRef" | "themeColor" | "displayName">;
  size?: number;
  health?: DigitalHumanHealth;
  presence?: ParticipantPresence;
  square?: boolean;
}) {
  const dotClass = presence
    ? `presence-${presence}`
    : health ? healthDotClass(health) : "";
  return (
    <span
      className={`dh-avatar${square ? " square" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.44),
        background: human.themeColor,
        borderRadius: square ? Math.round(size * 0.3) : "50%",
      }}
      role="img"
      aria-label={human.displayName}
    >
      {human.avatarRef}
      {dotClass ? <span className={`dh-status-dot ${dotClass}`} /> : null}
    </span>
  );
});

function endpointLabel(human: DigitalHuman): string {
  if (human.endpoint.type === "local-dsh") return "本地";
  if (human.endpoint.type === "a2a") return "A2A";
  return "远端 DSH";
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
  projects = [],
}: CatalogProps) {
  const [checking, setChecking] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const selected = humans.find((item) => item.id === selectedId) || humans[0];

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
      token: "",
    });
    setEditing(true);
  }, [selected]);

  const patchEditForm = useCallback((partial: Partial<EditFormState>) => {
    setEditForm((current) => current ? { ...current, ...partial } : current);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!selected || !editForm || savingEdit) return;
    const displayName = editForm.displayName.trim();
    const purpose = editForm.purpose.trim();
    if (!displayName || !purpose) {
      setEditError("请填写名称和用途描述");
      return;
    }
    const baseUrl = editForm.baseUrl.trim().replace(/\/+$/, "");
    if ((selected.endpoint.type === "remote-dsh" || selected.endpoint.type === "a2a") && !baseUrl) {
      setEditError("请填写服务地址");
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
        roleTags: editForm.roleTagsText.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
        approvalPolicy: editForm.approvalPolicy,
        concurrencyLimit: Math.max(1, Math.min(8, Math.round(editForm.concurrencyLimit) || 1)),
        endpoint: {
          ...selected.endpoint,
          baseUrl: selected.endpoint.type === "remote-dsh" || selected.endpoint.type === "a2a" ? baseUrl : selected.endpoint.baseUrl,
          credentialRef,
        },
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

  const selectedProjectName = selected?.projectPath
    ? projects.find((project) => project.path === selected.projectPath)?.name || selected.projectPath
    : "";

  return (
    <div className="dh-catalog">
      <div className="dh-catalog-list">
        <div className="dh-catalog-head">
          <h2>数字人</h2>
          <button type="button" className="primary-action compact" onClick={onAdd}>
            <PlusIcon className="icon-14" />
            添加数字人
          </button>
        </div>
        <div className="dh-catalog-scroll">
          {loading ? (
            <div className="dh-empty">加载中…</div>
          ) : humans.length === 0 ? (
            <div className="dh-empty">
              <div className="dh-empty-icon">🧑‍🚀</div>
              <p>还没有数字人</p>
              <p className="dh-empty-sub">把任何 deepseek-harness-java 服务接入为数字员工</p>
              <button type="button" className="primary-action compact" onClick={onAdd}>添加第一个数字人</button>
            </div>
          ) : (
            humans.map((human) => (
              <button
                key={human.id}
                type="button"
                className={`dh-item${selected?.id === human.id ? " active" : ""}`}
                onClick={() => onSelect(human.id)}
              >
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
              </button>
            ))
          )}
        </div>
      </div>

      <div className="dh-catalog-detail">
        {selected ? (
          <>
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
                <button
                  type="button"
                  className="ghost-action compact"
                  onClick={startEdit}
                >
                  <EditIcon className="icon-14" />
                  编辑
                </button>
                <button
                  type="button"
                  className="ghost-action compact"
                  disabled={checking}
                  onClick={() => void runHealthCheck()}
                >
                  <RefreshIcon className={`icon-14${checking ? " spinning" : ""}`} />
                  {checking ? "检查中…" : "健康检查"}
                </button>
                {confirmingDelete ? (
                  <>
                    <button type="button" className="danger-action compact" onClick={() => void remove()}>
                      确认删除
                    </button>
                    <button type="button" className="ghost-action compact" onClick={() => setConfirmingDelete(false)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ghost-action compact danger-text"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <TrashIcon className="icon-14" />
                    删除
                  </button>
                )}
              </div>
            </div>
            {actionError ? <div className="error-banner">{actionError}</div> : null}
            <div className="dh-kv-grid">
              <section className="dh-kv-card">
                <h3>连接</h3>
                <p className="mono-line">{selected.endpoint.baseUrl || "本地智能体服务"}</p>
                <div className="dh-perm-row">
                  协议 <b>{selected.endpoint.protocolVersion || "dsh.v1"}</b>
                  {selected.endpoint.credentialRef ? (
                    <> · 凭据 <b>{selected.endpoint.credentialRef}</b>（安全存储）</>
                  ) : null}
                </div>
                {selected.endpoint.lastCheckedAt ? (
                  <div className="dh-perm-row">
                    最近检查 <b>{new Date(selected.endpoint.lastCheckedAt).toLocaleString()}</b>
                    {typeof selected.endpoint.latencyMs === "number" ? (
                      <> · 延迟 <b className="perm-ok">{selected.endpoint.latencyMs}ms</b></>
                    ) : null}
                  </div>
                ) : null}
              </section>
              <section className="dh-kv-card">
                <h3>能力</h3>
                <div>
                  {selected.roleTags.length > 0
                    ? selected.roleTags.map((tag) => <span key={tag} className="dh-tag">{tag}</span>)
                    : <span className="dh-empty-sub">未设置能力标签</span>}
                </div>
                <div className="dh-perm-row">并发上限 <b>{selected.concurrencyLimit}</b></div>
              </section>
              <section className="dh-kv-card">
                <h3>权限</h3>
                <div className="dh-perm-row">
                  <span className="perm-ok">✓</span> 读操作 <b>自动允许</b>
                </div>
                <div className="dh-perm-row">
                  <span className="perm-warn">●</span> 写操作{" "}
                  <b>{selected.approvalPolicy === "AUTO_ALLOW" ? "自动允许" : "需要审批"}</b>
                </div>
                <div className="dh-perm-row">
                  <span className="perm-warn">●</span> 高危命令{" "}
                  <b>{selected.approvalPolicy === "ALWAYS_CONFIRM" ? "每次确认" : "需要审批"}</b>
                </div>
              </section>
              <section className="dh-kv-card">
                <h3>归属项目</h3>
                <select
                  className="dh-project-select"
                  value={selected.projectPath || ""}
                  aria-label="归属项目"
                  onChange={(event) => changeProject(event.target.value)}
                >
                  <option value="">全局（所有项目可用）</option>
                  {projects.map((project) => (
                    <option key={project.path} value={project.path}>{project.name}</option>
                  ))}
                </select>
                <p className="dh-empty-sub" style={{ marginTop: 6 }}>
                  {selected.projectPath
                    ? `已归属「${selectedProjectName}」：侧边栏项目行会展示其头像，该项目对话可优先调用。`
                    : "全局数字人：任意项目都可以在对话中加入它。"}
                </p>
              </section>
              <section className="dh-kv-card">
                <h3>说明</h3>
                <p className="dh-empty-sub" style={{ lineHeight: 1.7 }}>
                  在对话中点击顶部「＋」或输入 @ 即可把 {selected.displayName} 加入当前协作。
                  {hasRemoteEndpoint(selected)
                    ? " 远端任务由本地智能体服务统一编排与转发。"
                    : " 本地数字人直接使用本机智能体服务执行任务。"}
                </p>
              </section>
            </div>
          </>
        ) : (
          <div className="dh-empty" style={{ margin: "auto" }}>
            <div className="dh-empty-icon">👈</div>
            <p>选择左侧数字人查看详情</p>
          </div>
        )}
      </div>
      {editing && selected && editForm ? (
        <EditDigitalHumanModal
          human={selected}
          form={editForm}
          error={editError}
          saving={savingEdit}
          onPatch={patchEditForm}
          onClose={() => {
            if (savingEdit) return;
            setEditing(false);
            setEditForm(null);
            setEditError("");
          }}
          onSave={() => void saveEdit()}
        />
      ) : null}
    </div>
  );
}

function EditDigitalHumanModal({ human, form, error, saving, onPatch, onClose, onSave }: {
  human: DigitalHuman;
  form: EditFormState;
  error: string;
  saving: boolean;
  onPatch: (partial: Partial<EditFormState>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="modal dh-edit-modal" role="dialog" aria-modal="true" aria-label="编辑数字人">
        <div className="dh-edit-head">
          <div>
            <h3>编辑数字人</h3>
            <p>修改名称、头像、用途、权限和连接信息。</p>
          </div>
          <CloseButton onClick={onClose} label="关闭编辑" />
        </div>

        <div className="dh-edit-body">
          <label className="wizard-field">
            <span className="wizard-label">名称</span>
            <input
              className="wizard-input"
              value={form.displayName}
              onChange={(event) => onPatch({ displayName: event.target.value })}
            />
          </label>

          {hasRemoteEndpoint(human) ? (
            <>
              <label className="wizard-field">
                <span className="wizard-label">服务地址</span>
                <input
                  className="wizard-input"
                  placeholder="https://host:port"
                  value={form.baseUrl}
                  onChange={(event) => onPatch({ baseUrl: event.target.value })}
                />
              </label>
              <label className="wizard-field">
                <span className="wizard-label">访问令牌<small>留空表示沿用当前凭据</small></span>
                <input
                  className="wizard-input"
                  type="password"
                  placeholder={human.endpoint.credentialRef ? "已保存到安全存储" : "可选"}
                  value={form.token}
                  onChange={(event) => onPatch({ token: event.target.value })}
                />
              </label>
            </>
          ) : null}

          <div className="wizard-field">
            <span className="wizard-label">头像与主题色</span>
            <div className="wizard-avatar-picker">
              {AVATAR_OPTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={`wizard-avatar-opt${form.avatarRef === emoji ? " sel" : ""}`}
                  style={{ background: form.themeColor }}
                  onClick={() => onPatch({ avatarRef: emoji })}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="wizard-color-row">
              {COLOR_OPTIONS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`主题色 ${color}`}
                  className={`wizard-color-dot${form.themeColor === color ? " sel" : ""}`}
                  style={{ background: color }}
                  onClick={() => onPatch({ themeColor: color })}
                />
              ))}
            </div>
          </div>

          <label className="wizard-field">
            <span className="wizard-label">用途描述<small>用于展示和自动分工匹配</small></span>
            <textarea
              className="wizard-input"
              rows={3}
              value={form.purpose}
              onChange={(event) => onPatch({ purpose: event.target.value })}
            />
          </label>

          <label className="wizard-field">
            <span className="wizard-label">能力标签<small>逗号分隔</small></span>
            <input
              className="wizard-input"
              value={form.roleTagsText}
              onChange={(event) => onPatch({ roleTagsText: event.target.value })}
            />
          </label>

          <div className="wizard-field">
            <span className="wizard-label">审批策略</span>
            <div className="wizard-radio-group">
              {([
                ["WRITE_REQUIRES_APPROVAL", "读自动 / 写审批", "读取类操作自动执行，写入与命令需确认"],
                ["AUTO_ALLOW", "全部自动", "仅用于完全可信的环境"],
                ["ALWAYS_CONFIRM", "逐次确认", "每个工具调用都需人工确认"],
              ] as const).map(([value, name, desc]) => (
                <button
                  key={value}
                  type="button"
                  className={`wizard-radio${form.approvalPolicy === value ? " sel" : ""}`}
                  onClick={() => onPatch({ approvalPolicy: value })}
                >
                  <b>{name}</b>
                  <small>{desc}</small>
                </button>
              ))}
            </div>
          </div>

          <label className="wizard-field">
            <span className="wizard-label">并发上限<small>同时执行的任务数（1-8）</small></span>
            <input
              className="wizard-input wizard-input-narrow"
              type="number"
              min={1}
              max={8}
              value={form.concurrencyLimit}
              onChange={(event) => onPatch({ concurrencyLimit: Number(event.target.value) || 1 })}
            />
          </label>
          {error ? <div className="error-banner dh-edit-error">{error}</div> : null}
        </div>

        <div className="wizard-foot">
          <button type="button" className="ghost-action compact" disabled={saving} onClick={onClose}>取消</button>
          <span className="wizard-foot-spacer" />
          <button type="button" className="primary-action compact" disabled={saving} onClick={onSave}>
            {saving ? "保存中…" : "保存修改"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="ghost-action compact" onClick={onClick} aria-label={label}>
      <XIcon className="icon-14" />
    </button>
  );
}
