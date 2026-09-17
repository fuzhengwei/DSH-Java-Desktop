import { memo, useCallback, useEffect, useState } from "react";
import type { DigitalHuman, DigitalHumanHealth, ParticipantPresence, WorkspaceEntry } from "../types";
import { assignDigitalHumanToProject, deleteDigitalHuman, healthCheck } from "../lib/digital-human-client";
import { PlusIcon, RefreshIcon, TrashIcon, XIcon } from "./icons";

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
  return human.endpoint.type === "local-dsh" ? "本地" : "远端 DSH";
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

  // 归属项目切换：本地写映射并触发外层刷新（只影响展示归属，不动服务端记录）
  const changeProject = useCallback((projectPath: string) => {
    if (!selected) return;
    assignDigitalHumanToProject(selected.id, projectPath);
    onChanged();
  }, [onChanged, selected]);

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
                  {selected.endpoint.type === "remote-dsh"
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
