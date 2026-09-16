import { useCallback, useEffect, useMemo, useState } from "react";
import type { HarnessPlugin, PluginCandidate, PluginConfigItem } from "../types";
import {
  activatePlugin,
  analyzePluginJar,
  analyzePluginMaven,
  disablePlugin,
  installPlugin,
  listPluginConfig,
  listPlugins,
  savePluginConfig,
  uninstallPlugin,
} from "../lib/agent-client";

type PluginsSettingsProps = {
  servicePort: number | null;
};

function pluginStatusLabel(status?: string): string {
  const map: Record<string, string> = {
    REGISTERED: "已注册",
    ACTIVE: "运行中",
    FAILED: "失败",
    DISABLED: "已停用",
    UNINSTALLED: "已卸载",
  };
  return (status && map[status]) || status || "未知";
}

function pluginStatusClass(status?: string): string {
  if (status === "ACTIVE") return "online";
  if (status === "FAILED") return "offline";
  return "muted";
}

export default function PluginsSettings({ servicePort }: PluginsSettingsProps) {
  const [plugins, setPlugins] = useState<HarnessPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [installMode, setInstallMode] = useState<"jar" | "maven">("jar");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMessage, setAnalyzeMessage] = useState("");
  const [candidate, setCandidate] = useState<PluginCandidate | null>(null);
  const [candidates, setCandidates] = useState<PluginCandidate[]>([]);
  const [pomXml, setPomXml] = useState("");
  const [installing, setInstalling] = useState(false);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [configs, setConfigs] = useState<PluginConfigItem[] | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const notify = useCallback((message: string) => {
    setNotice(message);
  }, []);

  const refresh = useCallback(async () => {
    if (!servicePort) return;
    setLoading(true);
    setLoadError("");
    try {
      setPlugins(await listPlugins(servicePort));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [servicePort]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visiblePlugins = useMemo(() => {
    const all = plugins.filter((plugin) => plugin.status !== "UNINSTALLED");
    const query = search.trim().toLowerCase();
    if (!query) return all;
    return all.filter((plugin) =>
      [plugin.pluginId, plugin.displayName, plugin.runtimeType, plugin.status]
        .some((value) => String(value || "").toLowerCase().includes(query)),
    );
  }, [plugins, search]);

  const metrics = useMemo(
    () => [
      { label: "已安装", value: visiblePlugins.length },
      { label: "运行中", value: visiblePlugins.filter((p) => p.status === "ACTIVE").length },
      { label: "已停用", value: visiblePlugins.filter((p) => p.status === "DISABLED").length },
      { label: "失败", value: visiblePlugins.filter((p) => p.status === "FAILED").length },
    ],
    [visiblePlugins],
  );

  const analyzeJarFile = async (file: File) => {
    if (!servicePort) return;
    setCandidate(null);
    setCandidates([]);
    setAnalyzing(true);
    setAnalyzeMessage("分析中…");
    try {
      setCandidate(await analyzePluginJar(servicePort, file));
      setAnalyzeMessage("");
    } catch (error) {
      setAnalyzeMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalyzing(false);
    }
  };

  const analyzePom = async () => {
    if (!servicePort || !pomXml.trim()) return;
    setAnalyzing(true);
    setCandidate(null);
    setCandidates([]);
    try {
      const result = await analyzePluginMaven(servicePort, pomXml);
      setCandidates(result);
      setCandidate(result.find((item) => item.valid) || null);
      if (result.length === 0) setAnalyzeMessage("未识别到有效插件");
    } catch (error) {
      setAnalyzeMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalyzing(false);
    }
  };

  const installAndActivate = async () => {
    if (!servicePort || !candidate?.valid) return;
    setInstalling(true);
    try {
      await installPlugin(servicePort, candidate);
      await activatePlugin(servicePort, candidate.pluginId || "");
      setCandidate(null);
      setCandidates([]);
      setPomXml("");
      await refresh();
      notify(`插件 ${candidate.displayName || candidate.pluginId} 已安装并启用`);
    } catch (error) {
      notify(`安装失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInstalling(false);
    }
  };

  const runLifecycle = async (plugin: HarnessPlugin, action: "enable" | "disable" | "uninstall") => {
    if (!servicePort) return;
    setBusyPluginId(plugin.pluginId);
    try {
      if (action === "enable") {
        await activatePlugin(servicePort, plugin.pluginId);
        notify(`插件 ${plugin.displayName || plugin.pluginId} 已启用`);
      } else if (action === "disable") {
        await disablePlugin(servicePort, plugin.pluginId);
        notify(`插件 ${plugin.displayName || plugin.pluginId} 已停用`);
      } else {
        await uninstallPlugin(servicePort, plugin.pluginId);
        if (selectedPluginId === plugin.pluginId) {
          setSelectedPluginId(null);
          setConfigs(null);
        }
        notify(`插件 ${plugin.displayName || plugin.pluginId} 已卸载`);
      }
      await refresh();
    } catch (error) {
      notify(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyPluginId(null);
    }
  };

  const openConfig = async (pluginId: string) => {
    if (!servicePort) return;
    if (selectedPluginId === pluginId) {
      setSelectedPluginId(null);
      setConfigs(null);
      return;
    }
    setSelectedPluginId(pluginId);
    setConfigs(null);
    setConfigLoading(true);
    try {
      setConfigs(await listPluginConfig(servicePort, pluginId));
    } catch (error) {
      notify(`配置加载失败：${error instanceof Error ? error.message : String(error)}`);
      setConfigs([]);
    } finally {
      setConfigLoading(false);
    }
  };

  const saveConfigs = async () => {
    if (!servicePort || !selectedPluginId || !configs) return;
    setSavingConfig(true);
    try {
      const payload = configs.filter((item) => item.key && item.key.trim());
      await savePluginConfig(servicePort, selectedPluginId, payload);
      setConfigs(await listPluginConfig(servicePort, selectedPluginId));
      notify("配置已保存");
    } catch (error) {
      notify(`配置保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingConfig(false);
    }
  };

  if (!servicePort) {
    return (
      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>插件管理</h2>
            <p>智能体服务未连接，无法管理插件。</p>
          </div>
        </div>
        <div className="empty-card">请先在「智能体服务」中确认服务已启动。</div>
      </section>
    );
  }

  const selectedPlugin = visiblePlugins.find((plugin) => plugin.pluginId === selectedPluginId) || null;

  return (
    <>
      {notice ? (
        <div className="plugin-notice" onClick={() => setNotice("")}>{notice}</div>
      ) : null}
      <div className="service-status-grid plugin-metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className="service-status-card">
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>安装插件</h2>
            <p>选择本地 JAR 或粘贴 POM 依赖，识别后一键安装并启用。</p>
          </div>
          <span className="settings-pill">自动识别</span>
        </div>

        <div className="plugin-mode-tabs">
          <button
            className={installMode === "jar" ? "plugin-mode-tab active" : "plugin-mode-tab"}
            onClick={() => setInstallMode("jar")}
          >
            选择 JAR
          </button>
          <button
            className={installMode === "maven" ? "plugin-mode-tab active" : "plugin-mode-tab"}
            onClick={() => setInstallMode("maven")}
          >
            POM 配置
          </button>
        </div>

        {installMode === "jar" ? (
          <label className="plugin-drop">
            <input
              type="file"
              accept=".jar"
              style={{ display: "none" }}
              disabled={analyzing}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void analyzeJarFile(file);
                event.target.value = "";
              }}
            />
            <div className="plugin-drop-text">
              <strong>{analyzing ? "分析中…" : "点击选择 JAR 包"}</strong>
              <span>系统会读取 META-INF/plugin.yaml，识别后直接安装使用</span>
            </div>
          </label>
        ) : (
          <>
            <textarea
              className="plugin-pom-input"
              placeholder={"<dependency>\n  <groupId>com.example</groupId>\n  <artifactId>example-plugin</artifactId>\n  <version>1.0.0</version>\n</dependency>"}
              value={pomXml}
              onChange={(event) => setPomXml(event.target.value)}
            />
            <div className="plugin-install-actions">
              <button className="ghost-action" onClick={() => void analyzePom()} disabled={analyzing || !pomXml.trim()}>
                {analyzing ? "分析中…" : "分析 POM"}
              </button>
            </div>
          </>
        )}

        {candidates.length > 1 ? (
          <div className="plugin-candidate-list">
            {candidates.map((item, index) => (
              <CandidateCard
                key={index}
                candidate={item}
                selected={candidate === item}
                onClick={() => setCandidate(item.valid ? item : null)}
              />
            ))}
          </div>
        ) : candidate || analyzeMessage ? (
          <CandidateCard candidate={candidate} message={analyzeMessage} />
        ) : null}

        {candidate?.valid ? (
          <div className="plugin-install-actions">
            <button className="primary-action compact" onClick={() => void installAndActivate()} disabled={installing}>
              {installing ? "安装中…" : "安装并启用"}
            </button>
          </div>
        ) : null}
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>已安装插件</h2>
            <p>启用后插件会作为 Agent 工具自动注册，对话中直接描述目标即可使用。</p>
          </div>
          <div className="plugin-list-head-actions">
            <input
              className="plugin-search"
              placeholder="搜索名称、ID 或状态"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button className="ghost-action compact" onClick={() => void refresh()} disabled={loading}>
              {loading ? "刷新中…" : "刷新"}
            </button>
          </div>
        </div>

        {loadError ? <div className="empty-card">插件加载失败：{loadError}</div> : null}
        {!loadError && visiblePlugins.length === 0 ? (
          <div className="empty-card">{search ? "没有匹配的插件" : "暂无插件，先在上方安装一个"}</div>
        ) : null}

        <div className="plugin-list">
          {visiblePlugins.map((plugin) => (
            <article
              key={plugin.pluginId}
              className={`plugin-row ${selectedPluginId === plugin.pluginId ? "selected" : ""}`}
            >
              <div className="plugin-row-main">
                <strong>{plugin.displayName || plugin.pluginId}</strong>
                <span>
                  {plugin.pluginId}
                  {plugin.pluginVersion ? ` · v${plugin.pluginVersion}` : ""}
                </span>
                <small>{plugin.sourcePath || "—"}</small>
              </div>
              <div className="plugin-row-badges">
                <span className={`status-chip ${pluginStatusClass(plugin.status)}`}>
                  {pluginStatusLabel(plugin.status)}
                </span>
                <span className="status-chip muted">{plugin.runtimeType || "—"}</span>
              </div>
              <div className="plugin-row-actions">
                <button
                  className="ghost-action"
                  onClick={() => void openConfig(plugin.pluginId)}
                  disabled={busyPluginId === plugin.pluginId}
                >
                  {selectedPluginId === plugin.pluginId ? "收起" : "配置"}
                </button>
                {plugin.status === "ACTIVE" || plugin.status === "REGISTERED" ? (
                  <button
                    className="ghost-action"
                    onClick={() => void runLifecycle(plugin, "disable")}
                    disabled={busyPluginId === plugin.pluginId}
                  >
                    停用
                  </button>
                ) : (
                  <button
                    className="ghost-action"
                    onClick={() => void runLifecycle(plugin, "enable")}
                    disabled={busyPluginId === plugin.pluginId}
                  >
                    启用
                  </button>
                )}
                <button
                  className="danger-action"
                  onClick={() => void runLifecycle(plugin, "uninstall")}
                  disabled={busyPluginId === plugin.pluginId}
                >
                  卸载
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {selectedPlugin ? (
        <section className="settings-panel">
          <div className="settings-panel-head">
            <div>
              <h2>插件配置 · {selectedPlugin.displayName || selectedPlugin.pluginId}</h2>
              <p>键值参数会注入插件 configure(context)，保存后生效。</p>
            </div>
            <button className="ghost-action compact" onClick={() => { setSelectedPluginId(null); setConfigs(null); }}>
              收起
            </button>
          </div>
          {configLoading || configs === null ? (
            <div className="empty-card">配置加载中…</div>
          ) : (
            <>
              {configs.length === 0 ? <div className="empty-card">暂无配置，点击下方「添加配置」。</div> : null}
              <div className="plugin-config-rows">
                {configs.map((item, index) => (
                  <div key={index} className="plugin-config-row">
                    <input
                      placeholder="key"
                      value={item.key || ""}
                      onChange={(event) =>
                        setConfigs(configs.map((row, i) => (i === index ? { ...row, key: event.target.value } : row)))
                      }
                    />
                    <input
                      placeholder="value"
                      value={item.value || ""}
                      onChange={(event) =>
                        setConfigs(configs.map((row, i) => (i === index ? { ...row, value: event.target.value } : row)))
                      }
                    />
                    <button
                      className="danger-action"
                      onClick={() => setConfigs(configs.filter((_, i) => i !== index))}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
              <div className="plugin-install-actions">
                <button className="ghost-action" onClick={() => setConfigs([...configs, { key: "", value: "" }])}>
                  添加配置
                </button>
                <button className="primary-action compact" onClick={() => void saveConfigs()} disabled={savingConfig}>
                  {savingConfig ? "保存中…" : "保存配置"}
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>安装后如何使用</h2>
            <p>插件会作为 Agent 工具自动注册，无需手动编写调用代码。</p>
          </div>
        </div>
        <ul className="plugin-usage-list">
          <li>插件激活后，能力说明会进入 Agent 系统提示词。</li>
          <li>每个工具注册为 plugin__&lt;插件ID&gt;__&lt;toolName&gt;。</li>
          <li>对话中直接描述目标即可，Agent 会自动选择匹配的插件工具。</li>
          <li>插件运行参数通过卡片上的「配置」维护。</li>
        </ul>
      </section>
    </>
  );
}

function CandidateCard({
  candidate,
  message,
  selected,
  onClick,
}: {
  candidate: PluginCandidate | null;
  message?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const valid = Boolean(candidate?.valid);
  return (
    <div
      className={`plugin-candidate ${valid ? "valid" : "invalid"} ${onClick ? "clickable" : ""} ${selected ? "selected" : ""}`}
      onClick={onClick}
    >
      <div className="plugin-candidate-head">
        <div>
          <strong>{candidate ? candidate.displayName || candidate.artifactId || "未识别" : "自动识别"}</strong>
          <small>
            {candidate
              ? [candidate.pluginId, candidate.pluginVersion, candidate.sourcePath].filter(Boolean).join(" · ") || "—"
              : "—"}
          </small>
        </div>
        <span className={`status-chip ${valid ? "online" : "offline"}`}>{valid ? "插件" : "无效"}</span>
      </div>
      {candidate && valid ? (
        <div className="plugin-candidate-meta">
          <span>入口：{candidate.entrypoint || "Java SPI 自动发现"}</span>
          <span>作者：{candidate.author || "—"}</span>
          <span>说明：{candidate.description || "—"}</span>
        </div>
      ) : (
        <div className="plugin-candidate-message">
          {message || candidate?.message || "请选择有效的插件文件"}
        </div>
      )}
    </div>
  );
}
