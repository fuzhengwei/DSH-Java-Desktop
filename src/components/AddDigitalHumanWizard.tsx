import i18n from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DigitalHuman, DigitalHumanEndpointType, DiscoverResult } from "../types";
import { createDigitalHuman, discoverDigitalHuman, saveCredential, type DigitalHumanDraft } from "../lib/digital-human-client";
import { XIcon } from "./icons";
const t = i18n.t.bind(i18n);
const AVATAR_OPTIONS = ["🛠️", "📊", "✍️", "☕", "🔍", "🚀", "🧪", "📦", "🛡️", "📚", "🤖", "🌐"];
const COLOR_OPTIONS = ["#4160f0", "#2f855a", "#b7791f", "#7c5cd6", "#c53030", "#0e7490", "#be5a0e", "#4a5568"];
const STEPS = [t("AddDigitalHumanWizard.0"), t("AddDigitalHumanWizard.1"), t("AddDigitalHumanWizard.2"), t("AddDigitalHumanWizard.3"), t("AddDigitalHumanWizard.4")] as const;
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
const HUMAN_TEMPLATES: HumanTemplate[] = [{
  id: "dev",
  name: t("AddDigitalHumanWizard.5"),
  avatar: "🛠️",
  color: "#4160f0",
  purpose: t("AddDigitalHumanWizard.6"),
  tags: "coding, refactor, bugfix, code-review",
  approvalPolicy: "WRITE_REQUIRES_APPROVAL",
  concurrencyLimit: 1
}, {
  id: "qa",
  name: t("AddDigitalHumanWizard.7"),
  avatar: "🧪",
  color: "#0e7490",
  purpose: t("AddDigitalHumanWizard.8"),
  tags: "testing, qa, regression, validation",
  approvalPolicy: "WRITE_REQUIRES_APPROVAL",
  concurrencyLimit: 1
}, {
  id: "ops",
  name: t("AddDigitalHumanWizard.9"),
  avatar: "🛡️",
  color: "#c53030",
  purpose: t("AddDigitalHumanWizard.10"),
  tags: "server-ops, deployment, logs, shell",
  approvalPolicy: "ALWAYS_CONFIRM",
  concurrencyLimit: 1
}, {
  id: "pm",
  name: t("AddDigitalHumanWizard.11"),
  avatar: "📊",
  color: "#b7791f",
  purpose: t("AddDigitalHumanWizard.12"),
  tags: "product, planning, acceptance, summary",
  approvalPolicy: "WRITE_REQUIRES_APPROVAL",
  concurrencyLimit: 2
}, {
  id: "writer",
  name: t("AddDigitalHumanWizard.13"),
  avatar: "✍️",
  color: "#7c5cd6",
  purpose: t("AddDigitalHumanWizard.14"),
  tags: "docs, writing, release-note, handbook",
  approvalPolicy: "WRITE_REQUIRES_APPROVAL",
  concurrencyLimit: 1
}];
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
  concurrencyLimit: 1
};
export default function AddDigitalHumanWizard({
  open,
  port,
  onClose,
  onCreated,
  projectPath,
  projectName
}: WizardProps) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>(initialForm);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoverResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const discoverSeqRef = useRef(0);
  const credentialRefRef = useRef("");
  const patch = useCallback((partial: Partial<FormState>) => {
    setForm(current => ({
      ...current,
      ...partial
    }));
  }, []);
  const applyTemplate = useCallback((template: HumanTemplate) => {
    patch({
      displayName: template.name,
      avatarRef: template.avatar,
      themeColor: template.color,
      purpose: template.purpose,
      roleTagsText: template.tags,
      approvalPolicy: template.approvalPolicy,
      concurrencyLimit: template.concurrencyLimit
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
      setDiscovery({
        ...result
      });
      if (result.reachable && result.suggested) {
        const suggested = result.suggested;
        patch({
          displayName: suggested.displayName || form.displayName,
          purpose: suggested.purpose || form.purpose,
          roleTagsText: suggested.roleTags?.join(", ") || form.roleTagsText,
          approvalPolicy: suggested.approvalPolicy || form.approvalPolicy,
          concurrencyLimit: suggested.maxConcurrentTasks || form.concurrencyLimit
        });
      }
      // 把 credentialRef 暂存到 token 字段同位（提交时复用）
      if (credentialRef) patch({
        token: form.token
      });
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
        roleTags: form.roleTagsText.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
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
          latencyMs: discovery?.latencyMs
        },
        // 项目语境下创建：归属随创建直接落到服务端 digital_human.project_path
        projectPath: projectPath || undefined
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
  return <div className="modal-overlay" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
      <div className="wizard" role="dialog" aria-label={t("AddDigitalHumanWizard.15")}>
        <div className="wizard-head">
          <div className="wizard-title-row">
            <h2>{t("AddDigitalHumanWizard.16")}{projectName ? <span className="wizard-scope">{t("AddDigitalHumanWizard.17")}{projectName}」</span> : null}</h2>
            <button type="button" className="wizard-close" onClick={onClose} aria-label={t("AddDigitalHumanWizard.18")}>
              <XIcon className="icon-14" />
            </button>
          </div>
          <div className="wizard-steps" aria-label={t("AddDigitalHumanWizard.88", {
          v0: step,
          v1: STEPS[step - 1]
        })}>
            {STEPS.map((label, index) => <div key={label} className={`wizard-step${index + 1 < step ? " done" : index + 1 === step ? " cur" : ""}`}>
                <span className="wizard-step-bar" />
                <span className="wizard-step-label">{label}</span>
              </div>)}
          </div>
        </div>

        <div className="wizard-body">
          {step === 1 ? <>
              <p className="wizard-hint">{t("AddDigitalHumanWizard.19")}</p>
              <div className="wizard-src-grid">
                <SourceCard icon="🌐" name={t("AddDigitalHumanWizard.20")} selected={form.source === "remote-dsh"} desc={t("AddDigitalHumanWizard.21")} onClick={() => patch({
              source: "remote-dsh"
            })} />
                <SourceCard icon="💻" name={t("AddDigitalHumanWizard.22")} selected={form.source === "local-dsh"} desc={t("AddDigitalHumanWizard.23")} onClick={() => patch({
              source: "local-dsh"
            })} />
                <SourceCard icon="🤝" name="A2A Agent" selected={form.source === "a2a"} desc={t("AddDigitalHumanWizard.24")} onClick={() => patch({
              source: "a2a"
            })} />
              </div>
            </> : null}

          {step === 2 ? form.source === "local-dsh" ? <div className="wizard-local-note">
                <div className="wizard-local-icon">💻</div>
                <p><b>{t("AddDigitalHumanWizard.25")}</b>{t("AddDigitalHumanWizard.26")}</p>
                <p className="wizard-hint">{t("AddDigitalHumanWizard.27")}</p>
              </div> : <>
                <label className="wizard-field">
                  <span className="wizard-label">{t("AddDigitalHumanWizard.28")}<small>{form.source === "a2a" ? "A2A Agent Base URL" : t("AddDigitalHumanWizard.29")}</small></span>
                  <input className="wizard-input" placeholder={form.source === "a2a" ? "https://agent.example.com" : "https://ops.example.com:8080"} value={form.baseUrl} onChange={event => {
              patch({
                baseUrl: event.target.value
              });
              setDiscovery(null);
            }} />
                </label>
                <label className="wizard-field">
                  <span className="wizard-label">{t("AddDigitalHumanWizard.30")}<small>{t("AddDigitalHumanWizard.31")}</small></span>
                  <input className="wizard-input" type="password" placeholder={t("AddDigitalHumanWizard.32")} value={form.token} onChange={event => patch({
              token: event.target.value
            })} />
                </label>
                <div className={`wizard-discover${discovery?.reachable ? " ok" : discovery?.error ? " fail" : ""}`}>
                  {discovering ? <><span className="dh-spinner" /><span>{t("AddDigitalHumanWizard.33")}{form.source === "a2a" ? "/.well-known/agent.json" : "/.well-known/dsh-agent-card"} …</span></> : discovery?.reachable ? <>
                      <span className="wizard-discover-avatar" style={{
                background: form.themeColor
              }}>{form.avatarRef}</span>
                      <span className="wizard-discover-info">
                        <b>{t("AddDigitalHumanWizard.34")}{discovery.suggested?.displayName || t("AddDigitalHumanWizard.35")}</b>
                        <small>{t("AddDigitalHumanWizard.36")}{discovery.protocolVersion}
                          {discovery.suggested?.purpose ? ` · ${discovery.suggested.purpose}` : ""}
                        </small>
                      </span>
                      <span className="dh-health-pill on">{t("AddDigitalHumanWizard.37")}{discovery.latencyMs ? ` · ${discovery.latencyMs}ms` : ""}</span>
                    </> : discovery?.error ? <>
                      <span className="wizard-discover-fail-icon">⚠</span>
                      <span className="wizard-discover-info">
                        <b>{discovery.error.message}</b>
                        <small>{t("AddDigitalHumanWizard.38")}</small>
                      </span>
                    </> : <span className="wizard-hint">{t("AddDigitalHumanWizard.39")}</span>}
                </div>
                <button type="button" className="ghost-action compact" disabled={!form.baseUrl.trim() || discovering} onClick={() => void runDiscover()}>
                  {discovering ? t("AddDigitalHumanWizard.40") : t("AddDigitalHumanWizard.41")}
                </button>
              </> : null}

          {step === 3 ? <>
              <div className="wizard-template-block">
                <div className="wizard-template-head">
                  <span>{t("AddDigitalHumanWizard.42")}</span>
                  <small>{t("AddDigitalHumanWizard.43")}</small>
                </div>
                <div className="wizard-template-grid">
                  {HUMAN_TEMPLATES.map(template => <button key={template.id} type="button" className={`wizard-template-card${form.displayName === template.name ? " sel" : ""}`} onClick={() => applyTemplate(template)}>
                      <span className="wizard-template-avatar" style={{
                  background: template.color
                }}>{template.avatar}</span>
                      <span>
                        <b>{template.name}</b>
                        <small>{template.tags.split(",").slice(0, 2).join(" · ")}</small>
                      </span>
                    </button>)}
                </div>
              </div>
              <label className="wizard-field">
                <span className="wizard-label">{t("AddDigitalHumanWizard.44")}</span>
                <input className="wizard-input" placeholder={t("AddDigitalHumanWizard.45")} value={form.displayName} onChange={event => patch({
              displayName: event.target.value
            })} />
              </label>
              <div className="wizard-field">
                <span className="wizard-label">{t("AddDigitalHumanWizard.46")}</span>
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
                  {COLOR_OPTIONS.map(color => <button key={color} type="button" aria-label={t("AddDigitalHumanWizard.89", {
                v0: color
              })} className={`wizard-color-dot${form.themeColor === color ? " sel" : ""}`} style={{
                background: color
              }} onClick={() => patch({
                themeColor: color
              })} />)}
                </div>
              </div>
              <label className="wizard-field">
                <span className="wizard-label">{t("AddDigitalHumanWizard.47")}<small>{t("AddDigitalHumanWizard.48")}</small></span>
                <textarea className="wizard-input" rows={2} placeholder={t("AddDigitalHumanWizard.49")} value={form.purpose} onChange={event => patch({
              purpose: event.target.value
            })} />
              </label>
              <label className="wizard-field">
                <span className="wizard-label">{t("AddDigitalHumanWizard.50")}<small>{t("AddDigitalHumanWizard.51")}</small></span>
                <input className="wizard-input" placeholder={t("AddDigitalHumanWizard.52")} value={form.roleTagsText} onChange={event => patch({
              roleTagsText: event.target.value
            })} />
              </label>
            </> : null}

          {step === 4 ? <>
              <div className="wizard-field">
                <span className="wizard-label">{t("AddDigitalHumanWizard.53")}</span>
                <div className="wizard-radio-group">
                  {([["WRITE_REQUIRES_APPROVAL", t("AddDigitalHumanWizard.54"), t("AddDigitalHumanWizard.55")], ["AUTO_ALLOW", t("AddDigitalHumanWizard.56"), t("AddDigitalHumanWizard.57")], ["ALWAYS_CONFIRM", t("AddDigitalHumanWizard.58"), t("AddDigitalHumanWizard.59")]] as const).map(([value, name, desc]) => <button key={value} type="button" className={`wizard-radio${form.approvalPolicy === value ? " sel" : ""}`} onClick={() => patch({
                approvalPolicy: value
              })}>
                      <b>{name}</b>
                      <small>{desc}</small>
                    </button>)}
                </div>
              </div>
              <label className="wizard-field">
                <span className="wizard-label">{t("AddDigitalHumanWizard.60")}<small>{t("AddDigitalHumanWizard.61")}</small></span>
                <input className="wizard-input wizard-input-narrow" type="number" min={1} max={8} value={form.concurrencyLimit} onChange={event => patch({
              concurrencyLimit: Number(event.target.value) || 1
            })} />
              </label>
            </> : null}

          {step === 5 ? <>
              <div className="wizard-summary">
                <span className="wizard-discover-avatar lg" style={{
              background: form.themeColor
            }}>{form.avatarRef}</span>
                <div>
                  <b className="wizard-summary-name">{form.displayName}</b>
                  <small className="wizard-summary-sub">
                    {form.source === "local-dsh" ? t("AddDigitalHumanWizard.62") : form.baseUrl} · {form.source === "a2a" ? "a2a.v1" : "dsh.v1"}
                  </small>
                </div>
                <span className="dh-health-pill on">{t("AddDigitalHumanWizard.63")}</span>
              </div>
              {projectName ? <p className="wizard-hint wizard-scope-hint">{t("AddDigitalHumanWizard.64")}{projectName}{t("AddDigitalHumanWizard.65")}</p> : null}
              <div className="wizard-trust-cols">
                <div className="wizard-trust-col green">
                  <h5>{t("AddDigitalHumanWizard.66")}</h5>{t("AddDigitalHumanWizard.67")}<br />
                  {form.purpose || t("AddDigitalHumanWizard.68")}<br />{t("AddDigitalHumanWizard.69")}</div>
                <div className="wizard-trust-col amber">
                  <h5>{t("AddDigitalHumanWizard.70")}</h5>
                  {form.approvalPolicy === "AUTO_ALLOW" ? <>{t("AddDigitalHumanWizard.71")}<br />{t("AddDigitalHumanWizard.72")}</> : form.approvalPolicy === "ALWAYS_CONFIRM" ? <>{t("AddDigitalHumanWizard.73")}<br />{t("AddDigitalHumanWizard.74")}</> : <>{t("AddDigitalHumanWizard.75")}<br />{t("AddDigitalHumanWizard.76")}<br />{t("AddDigitalHumanWizard.77")}</>}
                </div>
                <div className="wizard-trust-col gray">
                  <h5>{t("AddDigitalHumanWizard.78")}</h5>{t("AddDigitalHumanWizard.79")}<br />{t("AddDigitalHumanWizard.80")}<br />{t("AddDigitalHumanWizard.81")}</div>
              </div>
            </> : null}

          {error ? <div className="error-banner">{error}</div> : null}
        </div>

        <div className="wizard-foot">
          <button type="button" className="ghost-action compact" onClick={onClose}>{t("AddDigitalHumanWizard.82")}</button>
          <span className="wizard-foot-spacer" />
          {step > 1 ? <button type="button" className="ghost-action compact" onClick={() => setStep(value => value - 1)}>{t("AddDigitalHumanWizard.83")}</button> : null}
          {step < 5 ? <button type="button" className="primary-action compact" disabled={!canNext} title={!canNext && step === 2 && form.source === "remote-dsh" ? t("AddDigitalHumanWizard.84") : undefined} onClick={() => setStep(value => value + 1)}>{t("AddDigitalHumanWizard.85")}</button> : <button type="button" className="primary-action compact" disabled={submitting} onClick={() => void submit()}>
              {submitting ? t("AddDigitalHumanWizard.86") : t("AddDigitalHumanWizard.87")}
            </button>}
        </div>
      </div>
    </div>;
}
function SourceCard({
  icon,
  name,
  desc,
  selected,
  disabled,
  onClick
}: {
  icon: string;
  name: string;
  desc: string;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return <button type="button" className={`wizard-src-card${selected ? " sel" : ""}${disabled ? " disabled" : ""}`} disabled={disabled} onClick={onClick}>
      <span className="wizard-src-icon">{icon}</span>
      <b>{name}</b>
      <small>{desc}</small>
    </button>;
}