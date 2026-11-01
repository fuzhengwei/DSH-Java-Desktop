import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { request } from "../lib/agent-client";

type FeishuBot = {
  botId: string;
  botName: string;
  appId: string;
  secretRef: string;
  secretConfigured: boolean;
  enabled: boolean;
  agentBaseId: string;
  channelCode: string | null;
  cwd: string | null;
  groupRequireMention: boolean;
  connectionState: string;
  lastError: string | null;
  updatedAt: string | null;
};

type FeishuPairing = {
  pairingId: string;
  status: "WAITING" | "SAVED" | "CANCELLED" | "FAILED" | "EXPIRED";
  url: string;
  userCode: string;
  expireIn: number;
  botId: string | null;
  appId: string | null;
  error: string | null;
};

type FeishuBotProps = {
  servicePort: number | null;
};

const STATE_META: Record<string, { label: string; live: boolean }> = {
  CONNECTED: { label: "在线", live: true },
  CONNECTING: { label: "连接中", live: false },
  ERROR: { label: "异常", live: false },
  IDLE: { label: "离线", live: false },
};

function stateMeta(state?: string) {
  return STATE_META[state || "IDLE"] || STATE_META.IDLE;
}

export default function FeishuBotsSettings({ servicePort }: FeishuBotProps) {
  const [bots, setBots] = useState<FeishuBot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");

  // ── 一键绑定 ──
  const [pairing, setPairing] = useState<FeishuPairing | null>(null);
  const [pairingName, setPairingName] = useState("");
  const [pairStarting, setPairStarting] = useState(false);
  const pairingIdRef = useRef<string | null>(null);

  // ── 手动表单 ──
  const [editing, setEditing] = useState<FeishuBot | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [botId, setBotId] = useState("");
  const [botName, setBotName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [agentBaseId, setAgentBaseId] = useState("");
  const [channelCode, setChannelCode] = useState("");
  const [cwd, setCwd] = useState("");
  const [groupRequireMention, setGroupRequireMention] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyBotId, setBusyBotId] = useState<string | null>(null);

  const notify = useCallback((message: string) => setNotice(message), []);

  const refresh = useCallback(async () => {
    if (!servicePort) return;
    setLoading(true);
    try {
      setBots(await request<FeishuBot[]>(servicePort, "/api/harness/bots"));
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [servicePort]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 一键绑定轮询
  useEffect(() => {
    if (!pairing || !servicePort) return;
    if (pairing.status !== "WAITING") return;
    const timer = window.setInterval(async () => {
      const id = pairingIdRef.current;
      if (!id) return;
      try {
        const next = await request<FeishuPairing>(servicePort, `/api/harness/bots/pairing/${id}`);
        setPairing(next);
        if (next.status === "SAVED") {
          notify(`绑定成功：Bot 已创建并上线（${next.appId || ""}）`);
          void refresh();
        }
      } catch {
        // 轮询失败静默重试
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pairing, servicePort, notify, refresh]);

  const startPairing = async () => {
    if (!servicePort) return;
    setPairStarting(true);
    try {
      const data = await request<FeishuPairing>(servicePort, "/api/harness/bots/pairing", {
        method: "POST",
        body: JSON.stringify({ botName: pairingName.trim() || "DeepSeek Bot" }),
      });
      pairingIdRef.current = data.pairingId;
      setPairing(data);
    } catch (error) {
      notify(`发起绑定失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPairStarting(false);
    }
  };

  const cancelPairing = async () => {
    const id = pairingIdRef.current;
    pairingIdRef.current = null;
    setPairing(null);
    if (id && servicePort) {
      try {
        await request<void>(servicePort, `/api/harness/bots/pairing/${id}`, { method: "DELETE" });
      } catch {
        // 忽略
      }
    }
  };

  /** Tauri WebView 内 <a target="_blank"> 不会唤起系统浏览器，必须走 Rust open_external。 */
  const openPairingUrl = () => {
    if (!pairing?.url) return;
    invoke("open_external", { url: pairing.url }).catch((error) => {
      notify(`打开浏览器失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const openManual = (bot: FeishuBot | null) => {
    setEditing(bot);
    setShowManual(true);
    setBotId(bot?.botId || "");
    setBotName(bot?.botName || "");
    setAppId(bot?.appId || "");
    setAppSecret("");
    setAgentBaseId(bot?.agentBaseId || "");
    setChannelCode(bot?.channelCode || "");
    setCwd(bot?.cwd || "");
    setGroupRequireMention(bot ? bot.groupRequireMention : true);
  };

  const resetManual = () => {
    setShowManual(false);
    setEditing(null);
  };

  const saveManual = async () => {
    if (!servicePort) return;
    if (!editing && !appId.trim()) {
      notify("App ID 不能为空");
      return;
    }
    if (!editing && !agentBaseId.trim()) {
      notify("Agent 基础 ID 不能为空");
      return;
    }
    setSaving(true);
    try {
      await request<FeishuBot>(servicePort, "/api/harness/bots", {
        method: "POST",
        body: JSON.stringify({
          botId: editing?.botId || botId.trim(),
          botName: botName.trim() || botId.trim(),
          appId: appId.trim(),
          appSecret: appSecret.trim(),
          agentBaseId: agentBaseId.trim(),
          channelCode: channelCode.trim(),
          cwd: cwd.trim(),
          groupRequireMention,
        }),
      });
      notify(editing ? "Bot 已更新" : "Bot 已创建，点击「启用」上线");
      resetManual();
      await refresh();
    } catch (error) {
      notify(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleBot = async (bot: FeishuBot) => {
    if (!servicePort) return;
    setBusyBotId(bot.botId);
    try {
      await request<FeishuBot>(
        servicePort,
        `/api/harness/bots/${encodeURIComponent(bot.botId)}/${bot.enabled ? "disable" : "enable"}`,
        { method: "POST" },
      );
      notify(bot.enabled ? "已停用" : "已启用");
      await refresh();
    } catch (error) {
      notify(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyBotId(null);
    }
  };

  const testBot = async (bot: FeishuBot) => {
    if (!servicePort) return;
    setBusyBotId(bot.botId);
    try {
      const result = await request<FeishuBot>(
        servicePort,
        `/api/harness/bots/${encodeURIComponent(bot.botId)}/test`,
        { method: "POST" },
        30_000,
      );
      if (result.connectionState === "CONNECTED") {
        notify("连接成功，Bot 已在线");
      } else {
        const label = stateMeta(result.connectionState).label;
        notify(`状态：${label}${result.lastError ? `（${result.lastError}）` : ""}`);
      }
      await refresh();
    } catch (error) {
      notify(`测试失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyBotId(null);
    }
  };

  const deleteBot = async (bot: FeishuBot) => {
    if (!servicePort) return;
    if (!window.confirm(`删除 Bot「${bot.botName || bot.botId}」？长连接会断开，配置不可恢复。`)) return;
    setBusyBotId(bot.botId);
    try {
      await request<void>(servicePort, `/api/harness/bots/${encodeURIComponent(bot.botId)}`, { method: "DELETE" });
      notify("已删除");
      await refresh();
    } catch (error) {
      notify(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyBotId(null);
    }
  };

  if (!servicePort) {
    return (
      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>飞书 Bot</h2>
            <p>智能体服务未连接，无法管理飞书机器人。</p>
          </div>
        </div>
        <div className="empty-card">请先在「服务」中确认本地智能体服务已启动。</div>
      </section>
    );
  }

  return (
    <>
      {notice ? (
        <div className="plugin-notice" onClick={() => setNotice("")}>{notice}</div>
      ) : null}

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>一键绑定飞书</h2>
            <p>打开绑定页，用手机飞书扫码确认，应用会自动创建——Bot 自动上线，全程无需手动填凭证。</p>
          </div>
          <span className="settings-pill">推荐</span>
        </div>
        {!pairing ? (
          <div className="pairing-start-row">
            <input
              className="pairing-name-input"
              placeholder="应用名称（默认 DeepSeek Bot）"
              value={pairingName}
              onChange={(event) => setPairingName(event.target.value)}
            />
            <button className="primary-action compact" onClick={() => void startPairing()} disabled={pairStarting}>
              {pairStarting ? "发起中…" : "开始绑定"}
            </button>
          </div>
        ) : (
          <div className="pairing-status-card">
            <div className={`pairing-status-title ${pairing.status === "SAVED" ? "ok" : pairing.status === "FAILED" || pairing.status === "EXPIRED" ? "bad" : ""}`}>
              {pairing.status === "WAITING" && "⏳ 等待扫码确认…"}
              {pairing.status === "SAVED" && "✅ 绑定成功，Bot 已创建并上线"}
              {pairing.status === "CANCELLED" && "已取消"}
              {pairing.status === "FAILED" && `❌ 绑定失败${pairing.error ? `：${pairing.error}` : ""}`}
              {pairing.status === "EXPIRED" && "⚠️ 二维码已过期，请重新发起"}
            </div>
            {pairing.status === "WAITING" ? (
              <>
                <div className="pairing-meta">确认码：{pairing.userCode}</div>
                <div className="pairing-actions">
                  <button className="ghost-action compact" onClick={openPairingUrl}>打开绑定页（飞书扫码）</button>
                  <button
                    className="ghost-action compact"
                    onClick={() => {
                      if (pairing?.url) {
                        void navigator.clipboard?.writeText(pairing.url).catch(() => {});
                        notify("链接已复制，可粘贴到浏览器打开");
                      }
                    }}
                  >
                    复制链接
                  </button>
                  <button className="danger-action compact" onClick={() => void cancelPairing()}>取消</button>
                </div>
                <div className="pairing-meta muted">
                  在电脑浏览器打开绑定页后，用手机飞书「扫一扫」页面二维码并确认即可。剩余 {Math.max(1, Math.ceil(pairing.expireIn / 60))} 分钟
                </div>
              </>
            ) : null}
            {pairing.status === "SAVED" ? (
              <>
                <div className="pairing-meta">新应用 App ID：{pairing.appId}</div>
                <div className="pairing-meta">Bot ID：{pairing.botId}（已启用，可在下方列表管理）</div>
                <div className="pairing-actions">
                  <button className="ghost-action compact" onClick={() => { pairingIdRef.current = null; setPairing(null); }}>完成</button>
                </div>
              </>
            ) : null}
          </div>
        )}
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>我的 Bot</h2>
            <p>启用即建立长连接；状态实时反映连接健康度。每个飞书会话自动派生独立 Agent。</p>
          </div>
          <button className="ghost-action compact" onClick={() => openManual(null)}>+ 手动添加</button>
        </div>

        {loading && bots.length === 0 ? <div className="set-empty">加载中…</div> : null}
        {loadError ? <div className="set-empty">{loadError}</div> : null}
        {!loading && !loadError && bots.length === 0 ? (
          <div className="set-empty">还没有 Bot，用上方「一键绑定」或「手动添加」创建。</div>
        ) : null}

        {bots.map((bot) => {
          const meta = stateMeta(bot.connectionState);
          return (
            <article key={bot.botId} className="bot-card">
              <div className="bot-card-top">
                <span className={meta.live ? "bot-dot live" : "bot-dot"} style={meta.live ? undefined : { background: bot.connectionState === "ERROR" ? "#ef4444" : bot.connectionState === "CONNECTING" ? "#f59e0b" : "#9ca3af" }} />
                <strong>{bot.botName || bot.botId}</strong>
                <span className="bot-card-sub">{bot.botId} · {bot.appId}</span>
                <span className={`set-chip ${meta.live ? "live" : ""}`}>{meta.label}</span>
                {bot.enabled ? <span className="set-chip">已启用</span> : null}
                {!bot.secretConfigured ? <span className="set-chip warn">缺 Secret</span> : null}
              </div>
              <div className="bot-card-info">
                <div>Agent：{bot.agentBaseId || "-"} · 渠道：{bot.channelCode || "默认"}{bot.cwd ? ` · 目录：${bot.cwd}` : ""}</div>
                {bot.lastError ? <div className="bot-card-error">{bot.lastError}</div> : null}
              </div>
              <div className="bot-card-actions">
                <button className="ghost-action compact" onClick={() => void testBot(bot)} disabled={busyBotId === bot.botId}>测试连接</button>
                <button
                  className={bot.enabled ? "ghost-action compact" : "primary-action compact"}
                  onClick={() => void toggleBot(bot)}
                  disabled={busyBotId === bot.botId}
                >
                  {bot.enabled ? "停用" : "启用"}
                </button>
                <button className="ghost-action compact" onClick={() => openManual(bot)}>编辑</button>
                <button className="danger-action compact" onClick={() => void deleteBot(bot)} disabled={busyBotId === bot.botId}>删除</button>
              </div>
            </article>
          );
        })}
      </section>

      {showManual ? (
        <div className="modal-overlay" onClick={resetManual}>
          <div className="modal model-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing ? `编辑 Bot：${editing.botName || editing.botId}` : "手动添加 Bot"}</h3>
              <button className="modal-close" onClick={resetManual}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <label className="form-field span-2">
                  <span>Bot ID</span>
                  <input
                    value={botId}
                    disabled={!!editing}
                    placeholder="小写字母/数字/连字符，例如 feishu-main（留空自动生成）"
                    onChange={(event) => setBotId(event.target.value)}
                  />
                </label>
                <label className="form-field span-2">
                  <span>展示名</span>
                  <input value={botName} placeholder="例如：小傅的飞书助手" onChange={(event) => setBotName(event.target.value)} />
                </label>
                <label className="form-field span-2">
                  <span>App ID</span>
                  <input value={appId} disabled={!!editing} placeholder="cli_a5xxxxxxxxxxxxxxx" onChange={(event) => setAppId(event.target.value)} />
                </label>
                <label className="form-field span-2">
                  <span>App Secret</span>
                  <input
                    type="password"
                    value={appSecret}
                    placeholder={editing?.secretConfigured ? "已配置则留空保持不变" : "飞书应用凭证"}
                    onChange={(event) => setAppSecret(event.target.value)}
                  />
                </label>
                <label className="form-field span-2">
                  <span>Agent 基础 ID</span>
                  <input value={agentBaseId} placeholder="会话 Agent 前缀，例如 feishu-assistant" onChange={(event) => setAgentBaseId(event.target.value)} />
                </label>
                <label className="form-field span-2">
                  <span>模型渠道（可选）</span>
                  <input value={channelCode} placeholder="留空使用当前激活渠道" onChange={(event) => setChannelCode(event.target.value)} />
                </label>
                <label className="form-field span-2">
                  <span>Agent 工作目录（可选）</span>
                  <input value={cwd} placeholder="留空使用进程目录" onChange={(event) => setCwd(event.target.value)} />
                </label>
                <label className="form-field span-2 pairing-check">
                  <input type="checkbox" checked={groupRequireMention} onChange={(event) => setGroupRequireMention(event.target.checked)} />
                  <span>群聊仅响应 @机器人 的消息（推荐）</span>
                </label>
              </div>
              <p className="pairing-hint">App Secret 保存后写入服务端本地凭据文件（~/.dsh/.credentials.yaml），不会回显。</p>
            </div>
            <div className="modal-actions">
              <button className="ghost-action" onClick={resetManual}>取消</button>
              <button className="primary-action compact" onClick={() => void saveManual()} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
