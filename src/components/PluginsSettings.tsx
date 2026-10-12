import i18n from "../i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HarnessPlugin, PluginCandidate, PluginConfigItem } from "../types";
import { activatePlugin, analyzePluginJar, analyzePluginMaven, disablePlugin, installPlugin, listPluginConfig, listPlugins, savePluginConfig, uninstallPlugin } from "../lib/agent-client";
const t = i18n.t.bind(i18n);
type PluginsSettingsProps = {
  servicePort: number | null;
};
function pluginStatusLabel(status?: string): string {
  const map: Record<string, string> = {
    REGISTERED: t("PluginsSettings.0"),
    ACTIVE: t("PluginsSettings.1"),
    FAILED: t("PluginsSettings.2"),
    DISABLED: t("PluginsSettings.3"),
    UNINSTALLED: t("PluginsSettings.4")
  };
  return status && map[status] || status || t("PluginsSettings.5");
}
function pluginStatusClass(status?: string): string {
  if (status === "ACTIVE") return "online";
  if (status === "FAILED") return "offline";
  return "muted";
}
export default function PluginsSettings({
  servicePort
}: PluginsSettingsProps) {
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
    const all = plugins.filter(plugin => plugin.status !== "UNINSTALLED");
    const query = search.trim().toLowerCase();
    if (!query) return all;
    return all.filter(plugin => [plugin.pluginId, plugin.displayName, plugin.runtimeType, plugin.status].some(value => String(value || "").toLowerCase().includes(query)));
  }, [plugins, search]);
  const metrics = useMemo(() => [{
    label: t("PluginsSettings.6"),
    value: visiblePlugins.length
  }, {
    label: t("PluginsSettings.7"),
    value: visiblePlugins.filter(p => p.status === "ACTIVE").length
  }, {
    label: t("PluginsSettings.8"),
    value: visiblePlugins.filter(p => p.status === "DISABLED").length
  }, {
    label: t("PluginsSettings.9"),
    value: visiblePlugins.filter(p => p.status === "FAILED").length
  }], [visiblePlugins]);
  const analyzeJarFile = async (file: File) => {
    if (!servicePort) return;
    setCandidate(null);
    setCandidates([]);
    setAnalyzing(true);
    setAnalyzeMessage(t("PluginsSettings.10"));
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
      setCandidate(result.find(item => item.valid) || null);
      if (result.length === 0) setAnalyzeMessage(t("PluginsSettings.11"));
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
      notify(t("PluginsSettings.65", {
        v0: candidate.displayName || candidate.pluginId
      }));
    } catch (error) {
      notify(t("PluginsSettings.66", {
        v0: error instanceof Error ? error.message : String(error)
      }));
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
        notify(t("PluginsSettings.67", {
          v0: plugin.displayName || plugin.pluginId
        }));
      } else if (action === "disable") {
        await disablePlugin(servicePort, plugin.pluginId);
        notify(t("PluginsSettings.68", {
          v0: plugin.displayName || plugin.pluginId
        }));
      } else {
        await uninstallPlugin(servicePort, plugin.pluginId);
        if (selectedPluginId === plugin.pluginId) {
          setSelectedPluginId(null);
          setConfigs(null);
        }
        notify(t("PluginsSettings.69", {
          v0: plugin.displayName || plugin.pluginId
        }));
      }
      await refresh();
    } catch (error) {
      notify(t("PluginsSettings.70", {
        v0: error instanceof Error ? error.message : String(error)
      }));
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
      notify(t("PluginsSettings.71", {
        v0: error instanceof Error ? error.message : String(error)
      }));
      setConfigs([]);
    } finally {
      setConfigLoading(false);
    }
  };
  const saveConfigs = async () => {
    if (!servicePort || !selectedPluginId || !configs) return;
    setSavingConfig(true);
    try {
      const payload = configs.filter(item => item.key && item.key.trim());
      await savePluginConfig(servicePort, selectedPluginId, payload);
      setConfigs(await listPluginConfig(servicePort, selectedPluginId));
      notify(t("PluginsSettings.12"));
    } catch (error) {
      notify(t("PluginsSettings.72", {
        v0: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setSavingConfig(false);
    }
  };
  if (!servicePort) {
    return <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>{t("PluginsSettings.13")}</h2>
            <p>{t("PluginsSettings.14")}</p>
          </div>
        </div>
        <div className="empty-card">{t("PluginsSettings.15")}</div>
      </section>;
  }
  const selectedPlugin = visiblePlugins.find(plugin => plugin.pluginId === selectedPluginId) || null;
  return <>
      {notice ? <div className="plugin-notice" onClick={() => setNotice("")}>{notice}</div> : null}
      <div className="service-status-grid plugin-metrics">
        {metrics.map(metric => <div key={metric.label} className="service-status-card">
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>)}
      </div>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>{t("PluginsSettings.16")}</h2>
            <p>{t("PluginsSettings.17")}</p>
          </div>
          <span className="settings-pill">{t("PluginsSettings.18")}</span>
        </div>

        <div className="plugin-mode-tabs">
          <button className={installMode === "jar" ? "plugin-mode-tab active" : "plugin-mode-tab"} onClick={() => setInstallMode("jar")}>{t("PluginsSettings.19")}</button>
          <button className={installMode === "maven" ? "plugin-mode-tab active" : "plugin-mode-tab"} onClick={() => setInstallMode("maven")}>{t("PluginsSettings.20")}</button>
        </div>

        {installMode === "jar" ? <label className="plugin-drop">
            <input type="file" accept=".jar" style={{
          display: "none"
        }} disabled={analyzing} onChange={event => {
          const file = event.target.files?.[0];
          if (file) void analyzeJarFile(file);
          event.target.value = "";
        }} />
            <div className="plugin-drop-text">
              <strong>{analyzing ? t("PluginsSettings.21") : t("PluginsSettings.22")}</strong>
              <span>{t("PluginsSettings.23")}</span>
            </div>
          </label> : <>
            <textarea className="plugin-pom-input" placeholder={"<dependency>\n  <groupId>com.example</groupId>\n  <artifactId>example-plugin</artifactId>\n  <version>1.0.0</version>\n</dependency>"} value={pomXml} onChange={event => setPomXml(event.target.value)} />
            <div className="plugin-install-actions">
              <button className="ghost-action" onClick={() => void analyzePom()} disabled={analyzing || !pomXml.trim()}>
                {analyzing ? t("PluginsSettings.24") : t("PluginsSettings.25")}
              </button>
            </div>
          </>}

        {candidates.length > 1 ? <div className="plugin-candidate-list">
            {candidates.map((item, index) => <CandidateCard key={index} candidate={item} selected={candidate === item} onClick={() => setCandidate(item.valid ? item : null)} />)}
          </div> : candidate || analyzeMessage ? <CandidateCard candidate={candidate} message={analyzeMessage} /> : null}

        {candidate?.valid ? <div className="plugin-install-actions">
            <button className="primary-action compact" onClick={() => void installAndActivate()} disabled={installing}>
              {installing ? t("PluginsSettings.26") : t("PluginsSettings.27")}
            </button>
          </div> : null}
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>{t("PluginsSettings.28")}</h2>
            <p>{t("PluginsSettings.29")}</p>
          </div>
          <div className="plugin-list-head-actions">
            <input className="plugin-search" placeholder={t("PluginsSettings.30")} value={search} onChange={event => setSearch(event.target.value)} />
            <button className="ghost-action compact" onClick={() => void refresh()} disabled={loading}>
              {loading ? t("PluginsSettings.31") : t("PluginsSettings.32")}
            </button>
          </div>
        </div>

        {loadError ? <div className="empty-card">{t("PluginsSettings.33")}{loadError}</div> : null}
        {!loadError && visiblePlugins.length === 0 ? <div className="empty-card">{search ? t("PluginsSettings.34") : t("PluginsSettings.35")}</div> : null}

        <div className="plugin-list">
          {visiblePlugins.map(plugin => <article key={plugin.pluginId} className={`plugin-row ${selectedPluginId === plugin.pluginId ? "selected" : ""}`}>
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
                <button className="ghost-action" onClick={() => void openConfig(plugin.pluginId)} disabled={busyPluginId === plugin.pluginId}>
                  {selectedPluginId === plugin.pluginId ? t("PluginsSettings.36") : t("PluginsSettings.37")}
                </button>
                {plugin.status === "ACTIVE" || plugin.status === "REGISTERED" ? <button className="ghost-action" onClick={() => void runLifecycle(plugin, "disable")} disabled={busyPluginId === plugin.pluginId}>{t("PluginsSettings.38")}</button> : <button className="ghost-action" onClick={() => void runLifecycle(plugin, "enable")} disabled={busyPluginId === plugin.pluginId}>{t("PluginsSettings.39")}</button>}
                <button className="danger-action" onClick={() => void runLifecycle(plugin, "uninstall")} disabled={busyPluginId === plugin.pluginId}>{t("PluginsSettings.40")}</button>
              </div>
            </article>)}
        </div>
      </section>

      {selectedPlugin ? <section className="settings-panel">
          <div className="settings-panel-head">
            <div>
              <h2>{t("PluginsSettings.41")}{selectedPlugin.displayName || selectedPlugin.pluginId}</h2>
              <p>{t("PluginsSettings.42")}</p>
            </div>
            <button className="ghost-action compact" onClick={() => {
          setSelectedPluginId(null);
          setConfigs(null);
        }}>{t("PluginsSettings.43")}</button>
          </div>
          {configLoading || configs === null ? <div className="empty-card">{t("PluginsSettings.44")}</div> : <>
              {configs.length === 0 ? <div className="empty-card">{t("PluginsSettings.45")}</div> : null}
              <div className="plugin-config-rows">
                {configs.map((item, index) => <div key={index} className="plugin-config-row">
                    <input placeholder="key" value={item.key || ""} onChange={event => setConfigs(configs.map((row, i) => i === index ? {
              ...row,
              key: event.target.value
            } : row))} />
                    <input placeholder="value" value={item.value || ""} onChange={event => setConfigs(configs.map((row, i) => i === index ? {
              ...row,
              value: event.target.value
            } : row))} />
                    <button className="danger-action" onClick={() => setConfigs(configs.filter((_, i) => i !== index))}>{t("PluginsSettings.46")}</button>
                  </div>)}
              </div>
              <div className="plugin-install-actions">
                <button className="ghost-action" onClick={() => setConfigs([...configs, {
            key: "",
            value: ""
          }])}>{t("PluginsSettings.47")}</button>
                <button className="primary-action compact" onClick={() => void saveConfigs()} disabled={savingConfig}>
                  {savingConfig ? t("PluginsSettings.48") : t("PluginsSettings.49")}
                </button>
              </div>
            </>}
        </section> : null}

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>{t("PluginsSettings.50")}</h2>
            <p>{t("PluginsSettings.51")}</p>
          </div>
        </div>
        <ul className="plugin-usage-list">
          <li>{t("PluginsSettings.52")}</li>
          <li>{t("PluginsSettings.53")}</li>
          <li>{t("PluginsSettings.54")}</li>
          <li>{t("PluginsSettings.55")}</li>
        </ul>
      </section>
    </>;
}
function CandidateCard({
  candidate,
  message,
  selected,
  onClick
}: {
  candidate: PluginCandidate | null;
  message?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const valid = Boolean(candidate?.valid);
  return <div className={`plugin-candidate ${valid ? "valid" : "invalid"} ${onClick ? "clickable" : ""} ${selected ? "selected" : ""}`} onClick={onClick}>
      <div className="plugin-candidate-head">
        <div>
          <strong>{candidate ? candidate.displayName || candidate.artifactId || t("PluginsSettings.56") : t("PluginsSettings.57")}</strong>
          <small>
            {candidate ? [candidate.pluginId, candidate.pluginVersion, candidate.sourcePath].filter(Boolean).join(" · ") || "—" : "—"}
          </small>
        </div>
        <span className={`status-chip ${valid ? "online" : "offline"}`}>{valid ? t("PluginsSettings.58") : t("PluginsSettings.59")}</span>
      </div>
      {candidate && valid ? <div className="plugin-candidate-meta">
          <span>{t("PluginsSettings.60")}{candidate.entrypoint || t("PluginsSettings.61")}</span>
          <span>{t("PluginsSettings.62")}{candidate.author || "—"}</span>
          <span>{t("PluginsSettings.63")}{candidate.description || "—"}</span>
        </div> : <div className="plugin-candidate-message">
          {message || candidate?.message || t("PluginsSettings.64")}
        </div>}
    </div>;
}