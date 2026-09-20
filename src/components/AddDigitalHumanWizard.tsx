import { useCallback, useEffect, useRef, useState } from "react";
import type { DigitalHuman, DigitalHumanEndpointType, DiscoverResult } from "../types";
import {
  createDigitalHuman,
  discoverDigitalHuman,
  saveCredential,
  type DigitalHumanDraft,
} from "../lib/digital-human-client";
import { XIcon } from "./icons";

const AVATAR_OPTIONS = ["🛠️", "📊", "✍️", "☕", "🔍", "🚀", "🧪", "📦", "🛡️", "📚", "🤖", "🌐"];
const COLOR_OPTIONS = ["#4160f0", "#2f855a", "#b7791f", "#7c5cd6", "#c53030", "#0e7490", "#be5a0e", "#4a5568"];
const STEPS = ["来源", "连接", "身份", "权限", "确认"] as const;

type HumanTemplate = {
  id: string;
  name: string;
  avatar: string;
  color: string;
  purpose: string;
  tags: string;
  approvalPolicy: DigitalHuman["approvalPolicy"];
  concurrencyLimit: number;
};

const HUMAN_TEMPLATES: HumanTemplate[] = [
  {
    id: "dev",
    name: "代码工程师",
    avatar: "🛠️",
    color: "#4160f0",
    purpose: "负责阅读代码、定位缺陷、实现功能、重构模块并给出可验证的修改说明",
    tags: "coding, refactor, bugfix, code-review",
    approvalPolicy: "WRITE_REQUIRES_APPROVAL",
    concurrencyLimit: 1,
  },
  {
    id: "qa",
    name: "测试工程师",
    avatar: "🧪",
    color: "#0e7490",
    purpose: "负责设计测试用例、运行验证、复现问题、整理风险与回归检查清单",
    tags: "testing, qa, regression, validation",
    approvalPolicy: "WRITE_REQUIRES_APPROVAL",
    concurrencyLimit: 1,
  },
  {
    id: "ops",
    name: "运维管家",
    avatar: "🛡️",
    color: "#c53030",
    purpose: "负责服务器巡检、日志排查、部署脚本、环境诊断与变更回滚建议",
    tags: "server-ops, deployment, logs, shell",
    approvalPolicy: "ALWAYS_CONFIRM",
    concurrencyLimit: 1,
  },
  {
    id: "pm",
    name: "产品经理",
    avatar: "📊",
    color: "#b7791f",
    purpose: "负责需求澄清、任务拆解、验收标准、优先级判断与协作结论汇总",
    tags: "product, planning, acceptance, summary",
    approvalPolicy: "WRITE_REQUIRES_APPROVAL",
    concurrencyLimit: 2,
  },
  {
    id: "writer",
    name: "文档助手",
    avatar: "✍️",
    color: "#7c5cd6",
    purpose: "负责沉淀说明文档、发布记录、会议纪要、操作手册与面向用户的交付材料",
    tags: "docs, writing, release-note, handbook",
    approvalPolicy: "WRITE_REQUIRES_APPROVAL",
    concurrencyLimit: 1,
  },
];

type WizardProps = {
  open: boolean;
  port: number | null;
  onClose: () => void;
  onCreated: (human: DigitalHuman) => void;
  /** 项目语境下打开：归属项目路径（写入数字人 projectPath） */
  projectPath?: string;
  /** 归属项目的展示名，仅用于文案 */
  projectName?: string;
};

type FormState = {
  source: DigitalHumanEndpointType;
  baseUrl: string;
  token: string;
  displayName: string;
  avatarRef: string;
  themeColor: string;
  purpose: string;
  roleTagsText: string;
  approvalPolicy: DigitalHuman["approvalPolicy"];
  concurrencyLimit: number;
};

const initialForm: FormState = {
  source: "remote-dsh",
  baseUrl: "",
  token: "",
  displayName: "",
  avatarRef: AVATAR_OPTIONS[0],
  themeColor: COLOR_OPTIONS[0],
  purpose: "",
  roleTagsText: "",
  approvalPolicy: "WRITE_REQUIRES_APPROVAL",
  concurrencyLimit: 1,
};

export default function AddDigitalHumanWizard({ open, port, onClose, onCreated, projectPath, projectName }: WizardProps) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>(initialForm);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoverResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const discoverSeqRef = useRef(0);
  const credentialRefRef = useRef("");

  const patch = useCallback((partial: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...partial }));
  }, []);

  const applyTemplate = useCallback((template: HumanTemplate) => {
    patch({
      displayName: template.name,
      avatarRef: template.avatar,
      themeColor: template.color,
      purpose: template.purpose,
      roleTagsText: template.tags,
      approvalPolicy: template.approvalPolicy,
      concurrencyLimit: template.concurrencyLimit,
    });
  }, [patch]);

  useEffect(() => {
    if (open) {
      setStep(1);
      setForm(initialForm);
      setDiscovery(null);
      setError("");
      credentialRefRef.current = "";
    }
  }, [open]);

  const runDiscover = useCallback(async () => {
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl || discovering) return;
    const seq = ++discoverSeqRef.current;
    setDiscovering(true);
    setDiscovery(null);
    setError("");
    // 凭据先存安全区，再拿引用去探测
    const credentialRef = form.token.trim() ? `cred_${Date.now().toString(36)}` : "";
    try {
      if (credentialRef) await saveCredential(credentialRef, form.token.trim());
      const result = await discoverDigitalHuman(port, baseUrl, form.source, credentialRef || undefined);
      if (seq !== discoverSeqRef.current) return;
      setDiscovery({ ...result });
      if (result.reachable && result.suggested) {
        const suggested = result.suggested;
        patch({
          displayName: suggested.displayName || form.displayName,
          purpose: suggested.purpose || form.purpose,
          roleTagsText: suggested.roleTags?.join(", ") || form.roleTagsText,
          approvalPolicy: suggested.approvalPolicy || form.approvalPolicy,
          concurrencyLimit: suggested.maxConcurrentTasks || form.concurrencyLimit,
        });
      }
      // 把 credentialRef 暂存到 token 字段同位（提交时复用）
      if (credentialRef) patch({ token: form.token });
      credentialRefRef.current = credentialRef;
    } catch (caught) {
      if (seq === discoverSeqRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (seq === discoverSeqRef.current) setDiscovering(false);
    }
  }, [discovering, form, patch, port]);

  const canNext = (() => {
    if (step === 1) return Boolean(form.source);
    if (step === 2) {
      if (form.source === "local-dsh") return true;
      return Boolean(form.baseUrl.trim()) && Boolean(discovery?.reachable);
    }
    if (step === 3) return Boolean(form.displayName.trim()) && Boolean(form.purpose.trim());
    return true;
  })();

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const draft: DigitalHumanDraft = {
        displayName: form.displayName.trim(),
        avatarRef: form.avatarRef,
        purpose: form.purpose.trim(),
        roleTags: form.roleTagsText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        themeColor: form.themeColor,
        approvalPolicy: form.approvalPolicy,
        concurrencyLimit: Math.max(1, Math.min(8, form.concurrencyLimit || 1)),
        endpoint: {
          type: form.source,
          baseUrl: form.source === "remote-dsh" || form.source === "a2a" ? form.baseUrl.trim().replace(/\/+$/, "") : undefined,
          credentialRef: credentialRefRef.current || undefined,
          protocolVersion: discovery?.protocolVersion || (form.source === "a2a" ? "a2a.v1" : "dsh.v1"),
          healthState: form.source === "local-dsh" ? "online" : discovery?.reachable ? "online" : "unknown",
          lastCheckedAt: new Date().toISOString(),
          latencyMs: discovery?.latencyMs,
        },
        // 项目语境下创建：归属随创建直接落到服务端 digital_human.project_path
        projectPath: projectPath || undefined,
      };
      const human = await createDigitalHuman(port, draft);
      onCreated(human);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }, [discovery, form, onClose, onCreated, port, projectPath, submitting]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="wizard" role="dialog" aria-label="添加数字人">
        <div className="wizard-head">
          <div className="wizard-title-row">
            <h2>添加数字人{projectName ? <span className="wizard-scope">归属项目「{projectName}」</span> : null}</h2>
            <button type="button" className="wizard-close" onClick={onClose} aria-label="关闭">
              <XIcon className="icon-14" />
            </button>
          </div>
          <div className="wizard-steps" aria-label={`第 ${step} 步，共 5 步：${STEPS[step - 1]}`}>
            {STEPS.map((label, index) => (
              <div key={label} className={`wizard-step${index + 1 < step ? " done" : index + 1 === step ? " cur" : ""}`}>
                <span className="wizard-step-bar" />
                <span className="wizard-step-label">{label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="wizard-body">
          {step === 1 ? (
            <>
              <p className="wizard-hint">数字人 = 一个有名字、有职责、有真实执行环境的智能体服务。</p>
              <div className="wizard-src-grid">
                <SourceCard
                  icon="🌐" name="远端 DSH 服务" selected={form.source === "remote-dsh"}
                  desc="连接部署在其他机器上的 deepseek-harness-java，例如服务器上的运维数字人"
                  onClick={() => patch({ source: "remote-dsh" })}
                />
                <SourceCard
                  icon="💻" name="本地 DSH" selected={form.source === "local-dsh"}
                  desc="使用本机运行的智能体服务，配置为独立角色与职责"
                  onClick={() => patch({ source: "local-dsh" })}
                />
                <SourceCard
                  icon="🤝" name="A2A Agent" selected={form.source === "a2a"}
                  desc="接入支持 A2A 协议的外部智能体，作为协作成员参与分工"
                  onClick={() => patch({ source: "a2a" })}
                />
              </div>
            </>
          ) : null}

          {step === 2 ? (
            form.source === "local-dsh" ? (
              <div className="wizard-local-note">
                <div className="wizard-local-icon">💻</div>
                <p><b>本地数字人</b>将直接使用本机运行的智能体服务执行任务，无需填写地址与凭据。</p>
                <p className="wizard-hint">下一步为它设置名称、头像与职责。</p>
              </div>
            ) : (
              <>
                <label className="wizard-field">
                  <span className="wizard-label">服务地址<small>{form.source === "a2a" ? "A2A Agent Base URL" : "远端 DSH 的 Base URL"}</small></span>
                  <input
                    className="wizard-input"
                    placeholder={form.source === "a2a" ? "https://agent.example.com" : "https://ops.example.com:8080"}
                    value={form.baseUrl}
                    onChange={(event) => {
                      patch({ baseUrl: event.target.value });
                      setDiscovery(null);
                    }}
                  />
                </label>
                <label className="wizard-field">
                  <span className="wizard-label">访问凭据<small>仅保存在本机安全存储，不会进入日志</small></span>
                  <input
                    className="wizard-input"
                    type="password"
                    placeholder="Token（可选）"
                    value={form.token}
                    onChange={(event) => patch({ token: event.target.value })}
                  />
                </label>
                <div className={`wizard-discover${discovery?.reachable ? " ok" : discovery?.error ? " fail" : ""}`}>
                  {discovering ? (
                    <><span className="dh-spinner" /><span>正在探测 {form.source === "a2a" ? "/.well-known/agent.json" : "/.well-known/dsh-agent-card"} …</span></>
                  ) : discovery?.reachable ? (
                    <>
                      <span className="wizard-discover-avatar" style={{ background: form.themeColor }}>{form.avatarRef}</span>
                      <span className="wizard-discover-info">
                        <b>发现数字人：{discovery.suggested?.displayName || "未命名"}</b>
                        <small>
                          协议 {discovery.protocolVersion}
                          {discovery.suggested?.purpose ? ` · ${discovery.suggested.purpose}` : ""}
                        </small>
                      </span>
                      <span className="dh-health-pill on">连接正常{discovery.latencyMs ? ` · ${discovery.latencyMs}ms` : ""}</span>
                    </>
                  ) : discovery?.error ? (
                    <>
                      <span className="wizard-discover-fail-icon">⚠</span>
                      <span className="wizard-discover-info">
                        <b>{discovery.error.message}</b>
                        <small>可修改地址后重试；本地开发使用 HTTP 时请确认服务已启动</small>
                      </span>
                    </>
                  ) : (
                    <span className="wizard-hint">填写地址后点击「探测」验证连接与能力</span>
                  )}
                </div>
                <button
                  type="button"
                  className="ghost-action compact"
                  disabled={!form.baseUrl.trim() || discovering}
                  onClick={() => void runDiscover()}
                >
                  {discovering ? "探测中…" : "探测"}
                </button>
              </>
            )
          ) : null}

          {step === 3 ? (
            <>
              <div className="wizard-template-block">
                <div className="wizard-template-head">
                  <span>选择办公角色模板</span>
                  <small>点击后自动填充人设、能力标签和安全策略</small>
                </div>
                <div className="wizard-template-grid">
                  {HUMAN_TEMPLATES.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className={`wizard-template-card${form.displayName === template.name ? " sel" : ""}`}
                      onClick={() => applyTemplate(template)}
                    >
                      <span className="wizard-template-avatar" style={{ background: template.color }}>{template.avatar}</span>
                      <span>
                        <b>{template.name}</b>
                        <small>{template.tags.split(",").slice(0, 2).join(" · ")}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <label className="wizard-field">
                <span className="wizard-label">名称</span>
                <input
                  className="wizard-input"
                  placeholder="例如：服务器管家"
                  value={form.displayName}
                  onChange={(event) => patch({ displayName: event.target.value })}
                />
              </label>
              <div className="wizard-field">
                <span className="wizard-label">头像与主题色</span>
                <div className="wizard-avatar-picker">
                  {AVATAR_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className={`wizard-avatar-opt${form.avatarRef === emoji ? " sel" : ""}`}
                      style={{ background: form.themeColor }}
                      onClick={() => patch({ avatarRef: emoji })}
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
                      onClick={() => patch({ themeColor: color })}
                    />
                  ))}
                </div>
              </div>
              <label className="wizard-field">
                <span className="wizard-label">用途描述<small>给你看，也用于自动分工时匹配能力</small></span>
                <textarea
                  className="wizard-input"
                  rows={2}
                  placeholder="例如：负责服务器巡检、日志排查、部署脚本与变更回滚"
                  value={form.purpose}
                  onChange={(event) => patch({ purpose: event.target.value })}
                />
              </label>
              <label className="wizard-field">
                <span className="wizard-label">能力标签<small>逗号分隔，如 server-ops, 日志排查</small></span>
                <input
                  className="wizard-input"
                  placeholder="server-ops, deployment, 日志排查"
                  value={form.roleTagsText}
                  onChange={(event) => patch({ roleTagsText: event.target.value })}
                />
              </label>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="wizard-field">
                <span className="wizard-label">审批策略</span>
                <div className="wizard-radio-group">
                  {([
                    ["WRITE_REQUIRES_APPROVAL", "读自动 / 写审批", "推荐：读取类操作自动执行，写入与命令需确认"],
                    ["AUTO_ALLOW", "全部自动", "仅用于完全可信的内网只读服务"],
                    ["ALWAYS_CONFIRM", "逐次确认", "高危环境：每个工具调用都需人工确认"],
                  ] as const).map(([value, name, desc]) => (
                    <button
                      key={value}
                      type="button"
                      className={`wizard-radio${form.approvalPolicy === value ? " sel" : ""}`}
                      onClick={() => patch({ approvalPolicy: value })}
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
                  type="number" min={1} max={8}
                  value={form.concurrencyLimit}
                  onChange={(event) => patch({ concurrencyLimit: Number(event.target.value) || 1 })}
                />
              </label>
            </>
          ) : null}

          {step === 5 ? (
            <>
              <div className="wizard-summary">
                <span className="wizard-discover-avatar lg" style={{ background: form.themeColor }}>{form.avatarRef}</span>
                <div>
                  <b className="wizard-summary-name">{form.displayName}</b>
                  <small className="wizard-summary-sub">
                    {form.source === "local-dsh" ? "本地 DSH" : form.baseUrl} · {form.source === "a2a" ? "a2a.v1" : "dsh.v1"}
                  </small>
                </div>
                <span className="dh-health-pill on">就绪</span>
              </div>
              {projectName ? (
                <p className="wizard-hint wizard-scope-hint">
                  添加后将归属到项目「{projectName}」，该项目的对话与输入框可直接调用它；不归属任何项目的数字人请在底部「数字人」目录中添加。
                </p>
              ) : null}
              <div className="wizard-trust-cols">
                <div className="wizard-trust-col green">
                  <h5>✓ 将启用</h5>
                  接收你明确派发的任务<br />
                  {form.purpose || "执行职责范围内的操作"}<br />
                  产出结果与报告
                </div>
                <div className="wizard-trust-col amber">
                  <h5>● 需要审批</h5>
                  {form.approvalPolicy === "AUTO_ALLOW"
                    ? <>无（全部自动执行）<br />请确认服务可信</>
                    : form.approvalPolicy === "ALWAYS_CONFIRM"
                      ? <>所有工具调用<br />逐次人工确认</>
                      : <>修改文件<br />执行写命令<br />高危操作</>}
                </div>
                <div className="wizard-trust-col gray">
                  <h5>— 不会共享</h5>
                  本地其他项目文件<br />
                  其他数字人的凭据<br />
                  未被任务引用的历史会话
                </div>
              </div>
            </>
          ) : null}

          {error ? <div className="error-banner">{error}</div> : null}
        </div>

        <div className="wizard-foot">
          <button type="button" className="ghost-action compact" onClick={onClose}>取消</button>
          <span className="wizard-foot-spacer" />
          {step > 1 ? (
            <button type="button" className="ghost-action compact" onClick={() => setStep((value) => value - 1)}>
              上一步
            </button>
          ) : null}
          {step < 5 ? (
            <button
              type="button"
              className="primary-action compact"
              disabled={!canNext}
              title={!canNext && step === 2 && form.source === "remote-dsh" ? "请先探测并确认连接正常" : undefined}
              onClick={() => setStep((value) => value + 1)}
            >
              下一步
            </button>
          ) : (
            <button
              type="button"
              className="primary-action compact"
              disabled={submitting}
              onClick={() => void submit()}
            >
              {submitting ? "添加中…" : "确认添加"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceCard({ icon, name, desc, selected, disabled, onClick }: {
  icon: string; name: string; desc: string; selected?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`wizard-src-card${selected ? " sel" : ""}${disabled ? " disabled" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="wizard-src-icon">{icon}</span>
      <b>{name}</b>
      <small>{desc}</small>
    </button>
  );
}
