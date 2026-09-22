import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExtensionCliConfig,
  ExtensionMcpApplyResult,
  ExtensionMcpServer,
  ExtensionSkillSummary,
} from "../lib/agent-client";
import {
  getExtensionCliConfig,
  installExtensionSkill,
  listExtensionSkills,
  listMcpServers,
  removeExtensionSkill,
  removeMcpServer,
  setExtensionCliConfig,
  setExtensionSkillEnabled,
  testMcpServer,
  uploadExtensionSkillZip,
  upsertMcpServer,
} from "../lib/agent-client";

/** 共享：通知/错误横幅。 */
export function ExtensionNotices({ notice, error, onClearNotice, onClearError }: {
  notice: string;
  error: string;
  onClearNotice: () => void;
  onClearError: () => void;
}) {
  return (
    <>
      {notice ? <div className="plugin-notice" onClick={onClearNotice}>{notice}</div> : null}
      {error ? <div className="plugin-notice" style={{ color: "#c0392b" }} onClick={onClearError}>{error}</div> : null}
    </>
  );
}

/** 共享：服务未连接占位。 */
export function ExtensionDisconnected({ text }: { text: string }) {
  return (
    <section className="settings-panel">
      <div className="settings-panel-head">
        <div>
          <h2>未连接</h2>
          <p>{text}</p>
        </div>
      </div>
      <div className="empty-card">请先在「服务」中确认本地智能体服务已启动。</div>
    </section>
  );
}

/** 状态提示 hooks：Skills / MCP / CLI 三个面板共用同一套通知语义。 */
export function useExtensionNotify() {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const notify = useCallback((message: string) => {
    setNotice(message);
    setError("");
  }, []);
  const fail = useCallback((message: string) => {
    setError(message);
    setNotice("");
  }, []);
  return { notice, error, notify, fail, setNotice, setError };
}

// ═══════════════════════════════════════════════════════
// Skills 技能面板（独立设置项）
// ═══════════════════════════════════════════════════════

export function SkillsSettings({ servicePort }: { servicePort: number | null }) {
  const { notice, error, notify, fail, setNotice, setError } = useExtensionNotify();
  const [skills, setSkills] = useState<ExtensionSkillSummary[]>([]);
  const [loading, setLoading] = useState(false);

  // 添加技能弹窗：null = 关闭；"zip" = 压缩包上传；"git" = Git 仓库
  const [installMode, setInstallMode] = useState<null | "zip" | "git">(null);

  // Git 安装表单
  const [gitUrl, setGitUrl] = useState("");
  const [skillSubdir, setSkillSubdir] = useState("");
  const [skillName, setSkillName] = useState("");
  const [installing, setInstalling] = useState(false);

  // 压缩包上传
  const [zipSubdir, setZipSubdir] = useState("");
  const [zipName, setZipName] = useState("");
  const [uploading, setUploading] = useState(false);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const closeInstall = () => {
    setInstallMode(null);
    setZipSubdir("");
    setZipName("");
  };

  const refresh = useCallback(async () => {
    if (!servicePort) return;
    setLoading(true);
    try {
      setSkills(await listExtensionSkills(servicePort));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [servicePort, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!servicePort) {
    return <ExtensionDisconnected text="智能体服务未连接，无法管理技能。" />;
  }

  const installSkill = async () => {
    if (!servicePort || !gitUrl.trim()) return;
    setInstalling(true);
    try {
      const result = await installExtensionSkill(servicePort, gitUrl.trim(), skillSubdir.trim() || undefined, skillName.trim() || undefined);
      if (result.success) {
        notify(result.message);
        setGitUrl("");
        setSkillSubdir("");
        setSkillName("");
        closeInstall();
        await refresh();
      } else {
        fail(result.message);
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const uploadZip = async (file: File) => {
    if (!servicePort) return;
    setUploading(true);
    try {
      const result = await uploadExtensionSkillZip(servicePort, file, zipSubdir.trim() || undefined, zipName.trim() || undefined);
      if (result.success) {
        notify(result.message);
        closeInstall();
        await refresh();
      } else {
        fail(result.message);
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const toggleSkill = async (skill: ExtensionSkillSummary) => {
    if (!servicePort) return;
    try {
      await setExtensionSkillEnabled(servicePort, skill.name, !skill.enabled);
      notify(`技能 ${skill.name} 已${skill.enabled ? "停用" : "启用"}`);
      await refresh();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  const removeSkill = async (skill: ExtensionSkillSummary) => {
    if (!servicePort) return;
    if (!window.confirm(`确定删除技能「${skill.name}」？该操作会从磁盘移除技能目录。`)) return;
    try {
      await removeExtensionSkill(servicePort, skill.name);
      notify(`技能 ${skill.name} 已删除`);
      await refresh();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <ExtensionNotices
        notice={notice}
        error={error}
        onClearNotice={() => setNotice("")}
        onClearError={() => setError("")}
      />

      {/* ── 已安装技能（列表在上） ── */}
      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>已安装技能</h2>
            <p>技能目录会注入 Agent，启用后可通过 skill 工具加载。</p>
          </div>
          <div className="plugin-list-head-actions">
            <button className="ghost-action compact" onClick={() => void refresh()} disabled={loading}>
              {loading ? "刷新中…" : "刷新"}
            </button>
            <button className="primary-action compact" onClick={() => setInstallMode("zip")}>
              添加技能
            </button>
          </div>
        </div>
        {skills.length === 0 ? (
          <div className="empty-card">暂无技能。点击右上角「添加技能」安装，安装后可在对话中通过 skill 工具加载。</div>
        ) : (
          <div className="plugin-list">
            {skills.map((skill) => (
              <article key={skill.name} className="plugin-row">
                <div className="plugin-row-main">
                  <strong>{skill.name}</strong>
                  <span>{skill.source}</span>
                  <small>{skill.description || skill.path}</small>
                </div>
                <div className="plugin-row-badges">
                  <span className={`status-chip ${skill.enabled ? "online" : "muted"}`}>
                    {skill.enabled ? "启用" : "停用"}
                  </span>
                </div>
                <div className="plugin-row-actions">
                  <button className="ghost-action" onClick={() => void toggleSkill(skill)}>
                    {skill.enabled ? "停用" : "启用"}
                  </button>
                  {skill.removable ? (
                    <button className="danger-action" onClick={() => void removeSkill(skill)}>删除</button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ── 添加技能弹窗：压缩包 / Git 两种方式标签页切换 ── */}
      {installMode ? (
        <div className="modal-overlay" onClick={closeInstall}>
          <div className="modal skill-install-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>添加技能</h3>
              <button className="modal-close" onClick={closeInstall}>×</button>
            </div>
            <div className="skill-install-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={installMode === "zip"}
                className={installMode === "zip" ? "skill-install-tab active" : "skill-install-tab"}
                onClick={() => setInstallMode("zip")}
              >
                压缩包上传
              </button>
              <button
                role="tab"
                aria-selected={installMode === "git"}
                className={installMode === "git" ? "skill-install-tab active" : "skill-install-tab"}
                onClick={() => setInstallMode("git")}
              >
                Git 仓库
              </button>
            </div>

            {installMode === "zip" ? (
              <div className="modal-body">
                <div className="form-grid">
                  <label className="form-field">
                    <span>压缩包内子目录（可选）</span>
                    <input
                      value={zipSubdir}
                      placeholder="留空自动搜索 SKILL.md"
                      onChange={(event) => setZipSubdir(event.target.value)}
                    />
                  </label>
                  <label className="form-field">
                    <span>技能名（可选）</span>
                    <input
                      value={zipName}
                      placeholder="kebab-case，留空自动命名"
                      onChange={(event) => setZipName(event.target.value)}
                    />
                  </label>
                  <label className="form-field span-2">
                    <span>压缩包文件（.zip，内需含 SKILL.md）</span>
                    <input
                      ref={zipInputRef}
                      type="file"
                      accept=".zip,application/zip"
                      disabled={uploading}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadZip(file);
                      }}
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div className="modal-body">
                <div className="form-grid">
                  <label className="form-field span-2">
                    <span>Git 仓库地址</span>
                    <input
                      value={gitUrl}
                      placeholder="https://github.com/user/awesome-skill.git（仓库内需含 SKILL.md）"
                      onChange={(event) => setGitUrl(event.target.value)}
                    />
                  </label>
                  <label className="form-field">
                    <span>子目录（可选）</span>
                    <input
                      value={skillSubdir}
                      placeholder="仓库内技能目录，留空自动搜索 SKILL.md"
                      onChange={(event) => setSkillSubdir(event.target.value)}
                    />
                  </label>
                  <label className="form-field">
                    <span>技能名（可选）</span>
                    <input
                      value={skillName}
                      placeholder="kebab-case，留空自动命名"
                      onChange={(event) => setSkillName(event.target.value)}
                    />
                  </label>
                </div>
              </div>
            )}

            <div className="modal-actions">
              {installMode === "git" ? (
                <>
                  <span className="skill-install-hint">对话里也可以直接说「帮我装一个 xx 技能」让 Agent 自行拉取安装。</span>
                  <button className="primary-action compact" onClick={() => void installSkill()} disabled={installing || !gitUrl.trim()}>
                    {installing ? "拉取安装中…" : "从 Git 安装"}
                  </button>
                </>
              ) : (
                <span className="skill-install-hint">选择 .zip 后立即上传安装；安装完成后出现在上方列表。</span>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ═══════════════════════════════════════════════════════
// MCP 服务面板（独立设置项）
// ═══════════════════════════════════════════════════════

type McpDraft = {
  editingName: string | null;
  name: string;
  transport: string;
  command: string;
  argsText: string;
  url: string;
  headersText: string;
};

const emptyMcpDraft: McpDraft = {
  editingName: null,
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  url: "",
  headersText: "",
};

function draftFromServer(server: ExtensionMcpServer): McpDraft {
  return {
    editingName: server.name,
    name: server.name,
    transport: server.transport || "stdio",
    command: server.command || "",
    argsText: (server.args || []).join(" "),
    url: server.url || "",
    headersText: Object.entries(server.headers || {})
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  };
}

function parseKeyValueText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    const eq = trimmed.indexOf("=");
    const splitAt = colon >= 0 && (eq < 0 || colon < eq) ? colon : eq;
    if (splitAt <= 0) continue;
    const key = trimmed.slice(0, splitAt).trim();
    const value = trimmed.slice(splitAt + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function McpSettings({ servicePort }: { servicePort: number | null }) {
  const { notice, error, notify, fail, setNotice, setError } = useExtensionNotify();
  const [mcpServers, setMcpServers] = useState<ExtensionMcpServer[]>([]);
  const [mcpDraft, setMcpDraft] = useState<McpDraft | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpTestResult, setMcpTestResult] = useState<ExtensionMcpApplyResult | null>(null);

  const refresh = useCallback(async () => {
    if (!servicePort) return;
    try {
      setMcpServers(await listMcpServers(servicePort));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }, [servicePort, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!servicePort) {
    return <ExtensionDisconnected text="智能体服务未连接，无法管理 MCP 服务。" />;
  }

  const buildMcpPayload = (draft: McpDraft) => ({
    name: draft.name.trim(),
    transport: draft.transport,
    command: draft.transport === "stdio" ? draft.command.trim() : undefined,
    args: draft.transport === "stdio" && draft.argsText.trim()
      ? draft.argsText.trim().split(/\s+/)
      : undefined,
    url: draft.transport !== "stdio" ? draft.url.trim() : undefined,
    headers: draft.transport !== "stdio" && draft.headersText.trim()
      ? parseKeyValueText(draft.headersText)
      : undefined,
  });

  const saveMcp = async () => {
    if (!servicePort || !mcpDraft || !mcpDraft.name.trim()) return;
    setMcpBusy(true);
    setMcpTestResult(null);
    try {
      const result = await upsertMcpServer(servicePort, buildMcpPayload(mcpDraft));
      if (result.success) {
        notify(`MCP server ${result.name}：${result.message}`);
        setMcpDraft(null);
        await refresh();
      } else {
        setMcpTestResult(result);
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpBusy(false);
    }
  };

  const testMcp = async () => {
    if (!servicePort || !mcpDraft || !mcpDraft.name.trim()) return;
    setMcpBusy(true);
    setMcpTestResult(null);
    try {
      setMcpTestResult(await testMcpServer(servicePort, buildMcpPayload(mcpDraft)));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpBusy(false);
    }
  };

  const removeMcp = async (server: ExtensionMcpServer) => {
    if (!servicePort) return;
    if (!window.confirm(`确定移除 MCP server「${server.name}」？其工具会立即注销。`)) return;
    try {
      await removeMcpServer(servicePort, server.name);
      notify(`MCP server ${server.name} 已移除`);
      await refresh();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <ExtensionNotices
        notice={notice}
        error={error}
        onClearNotice={() => setNotice("")}
        onClearError={() => setError("")}
      />

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>MCP 服务</h2>
            <p>连接后远端工具以 mcp__服务名__工具名 注册，对话中直接使用。保存前会自动测试连通性。</p>
          </div>
          <div className="plugin-list-head-actions">
            {!mcpDraft ? (
              <button className="primary-action compact" onClick={() => { setMcpDraft({ ...emptyMcpDraft }); setMcpTestResult(null); }}>
                添加 MCP 服务
              </button>
            ) : null}
          </div>
        </div>

        {mcpDraft ? (
          <div className="plugin-config-rows" style={{ flexDirection: "column", gap: 8 }}>
            <div className="form-grid">
              <label className="form-field">
                <span>名称</span>
                <input
                  value={mcpDraft.name}
                  placeholder="例如：filesystem"
                  disabled={Boolean(mcpDraft.editingName)}
                  onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>传输方式</span>
                <select value={mcpDraft.transport} onChange={(event) => setMcpDraft({ ...mcpDraft, transport: event.target.value })}>
                  <option value="stdio">stdio（本地进程）</option>
                  <option value="sse">SSE（远程）</option>
                  <option value="streamable-http">Streamable HTTP（远程）</option>
                </select>
              </label>
              {mcpDraft.transport === "stdio" ? (
                <>
                  <label className="form-field">
                    <span>启动命令</span>
                    <input
                      value={mcpDraft.command}
                      placeholder="例如：npx"
                      onChange={(event) => setMcpDraft({ ...mcpDraft, command: event.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    <span>参数（空格分隔）</span>
                    <input
                      value={mcpDraft.argsText}
                      placeholder='-y @modelcontextprotocol/server-filesystem /tmp'
                      onChange={(event) => setMcpDraft({ ...mcpDraft, argsText: event.target.value })}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="form-field">
                    <span>URL</span>
                    <input
                      value={mcpDraft.url}
                      placeholder="https://example.com/mcp"
                      onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.target.value })}
                    />
                  </label>
                  <label className="form-field span-2">
                    <span>请求头（每行 key: value）</span>
                    <textarea
                      className="plugin-pom-input"
                      style={{ minHeight: 64 }}
                      value={mcpDraft.headersText}
                      placeholder={"Authorization: Bearer sk-..."}
                      onChange={(event) => setMcpDraft({ ...mcpDraft, headersText: event.target.value })}
                    />
                  </label>
                </>
              )}
            </div>
            {mcpTestResult ? (
              <div className={`plugin-candidate ${mcpTestResult.success ? "valid" : "invalid"}`}>
                <div className="plugin-candidate-message">{mcpTestResult.message}</div>
                {mcpTestResult.tools.length > 0 ? (
                  <div className="plugin-candidate-meta">
                    <span>工具：{mcpTestResult.tools.join("、")}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="plugin-install-actions">
              <button className="ghost-action" onClick={() => void testMcp()} disabled={mcpBusy || !mcpDraft.name.trim()}>
                {mcpBusy ? "连接中…" : "测试连接"}
              </button>
              <button className="ghost-action" onClick={() => { setMcpDraft(null); setMcpTestResult(null); }}>取消</button>
              <button className="primary-action compact" onClick={() => void saveMcp()} disabled={mcpBusy || !mcpDraft.name.trim()}>
                {mcpBusy ? "处理中…" : "保存并连接"}
              </button>
            </div>
          </div>
        ) : null}

        {mcpServers.length === 0 && !mcpDraft ? (
          <div className="empty-card">暂无 MCP 服务配置。</div>
        ) : (
          <div className="plugin-list">
            {mcpServers.map((server) => (
              <article key={server.name} className="plugin-row">
                <div className="plugin-row-main">
                  <strong>{server.name}</strong>
                  <span>{server.transport} · {server.presetSource === "preset" ? "内置预置" : "自定义"}</span>
                  <small>{server.transport === "stdio" ? [server.command, ...(server.args || [])].filter(Boolean).join(" ") : server.url}</small>
                </div>
                <div className="plugin-row-badges">
                  <span className="status-chip muted">{server.transport}</span>
                </div>
                <div className="plugin-row-actions">
                  <button className="ghost-action" onClick={() => { setMcpDraft(draftFromServer(server)); setMcpTestResult(null); }}>
                    编辑
                  </button>
                  <button className="danger-action" onClick={() => void removeMcp(server)}>移除</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// ═══════════════════════════════════════════════════════
// CLI 子智能体面板（独立设置项）
// ═══════════════════════════════════════════════════════

export function CliSettings({ servicePort }: { servicePort: number | null }) {
  const { notice, error, notify, fail, setNotice, setError } = useExtensionNotify();
  const [cli, setCli] = useState<ExtensionCliConfig | null>(null);
  const [cliDraft, setCliDraft] = useState<ExtensionCliConfig | null>(null);
  const [cliSaving, setCliSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!servicePort) return;
    try {
      const config = await getExtensionCliConfig(servicePort);
      setCli(config);
      setCliDraft(config);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }, [servicePort, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!servicePort) {
    return <ExtensionDisconnected text="智能体服务未连接，无法管理 CLI 子智能体。" />;
  }

  const saveCli = async () => {
    if (!servicePort || !cliDraft) return;
    setCliSaving(true);
    try {
      const saved = await setExtensionCliConfig(servicePort, cliDraft);
      setCli(saved);
      setCliDraft(saved);
      notify(saved.effectiveNotice || "CLI 配置已保存");
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setCliSaving(false);
    }
  };

  return (
    <>
      <ExtensionNotices
        notice={notice}
        error={error}
        onClearNotice={() => setNotice("")}
        onClearError={() => setError("")}
      />

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>CLI 子智能体</h2>
            <p>配置外部 CLI 命令（如 claude、codex），Agent 可通过 subagent 工具调度它们执行任务。</p>
          </div>
        </div>
        {cliDraft ? (
          <>
            <div className="form-grid">
              <label className="form-field">
                <span>claude 命令</span>
                <input
                  value={cliDraft.claudeCommand}
                  placeholder="claude"
                  onChange={(event) => setCliDraft({ ...cliDraft, claudeCommand: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>codex 命令</span>
                <input
                  value={cliDraft.codexCommand}
                  placeholder="codex"
                  onChange={(event) => setCliDraft({ ...cliDraft, codexCommand: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>ACP 子智能体命令</span>
                <input
                  value={cliDraft.acpSubagentCommand}
                  placeholder="例如：acp-cli --stdio"
                  onChange={(event) => setCliDraft({ ...cliDraft, acpSubagentCommand: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>ACP 主通道命令</span>
                <input
                  value={cliDraft.acpCommand}
                  placeholder="留空使用内置通道（修改需重启服务）"
                  onChange={(event) => setCliDraft({ ...cliDraft, acpCommand: event.target.value })}
                />
              </label>
            </div>
            <div className="plugin-install-actions">
              <button className="primary-action compact" onClick={() => void saveCli()} disabled={cliSaving}>
                {cliSaving ? "保存中…" : "保存 CLI 配置"}
              </button>
            </div>
            {cli?.effectiveNotice ? <div className="plugin-candidate-message">{cli.effectiveNotice}</div> : null}
          </>
        ) : (
          <div className="empty-card">CLI 配置加载中…</div>
        )}
      </section>
    </>
  );
}
