import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { DrawIoEmbed, type DrawIoEmbedRef } from "../lib/react-drawio";

/**
 * draw.io 文件预览/编辑器：
 *  - 渲染走 embed.diagrams.net 的 iframe（需要外网）；
 *  - 预览模式为 chromeless 查看器，编辑模式开启 autosave 并防抖回写本地 .drawio 文件；
 *  - 8 秒未收到 embed 事件时提示网络不可用，避免用户面对空白画布。
 */

type Props = {
  /** .drawio 文件绝对路径 */
  path: string;
  /** 关闭按钮（Dock 内使用时） */
  onClose?: () => void;
  /** 紧凑模式（对话内嵌卡片） */
  compact?: boolean;
};

const OFFLINE_HINT_MS = 8_000;
const SAVE_DEBOUNCE_MS = 800;

export function DrawioPreview({ path, onClose, compact }: Props) {
  const displayName = path.split("/").filter(Boolean).pop() || path;
  const [xml, setXml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [connected, setConnected] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const embedRef = useRef<DrawIoEmbedRef>(null);
  const latestXmlRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void invoke<string>("read_local_text_file", { path })
      .then((content) => {
        if (cancelled) return;
        setXml(content);
        latestXmlRef.current = content;
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path]);

  // 离线探测：embed.diagrams.net 加载不出来时给出明确提示
  useEffect(() => {
    if (loading || error || connected) return;
    const timer = window.setTimeout(() => {
      setOfflineHint(true);
    }, OFFLINE_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [loading, error, connected]);

  const [offlineHint, setOfflineHint] = useState(false);

  const persistXml = useMemo(() => {
    const write = async (content: string) => {
      setSaveState("saving");
      try {
        await invoke("write_local_text_file", { path, contents: content });
        setSaveState("saved");
      } catch (caught) {
        console.error("保存 draw.io 文件失败", caught);
        setSaveState("error");
      }
    };
    return {
      /** 防抖写入：autosave 高频触发时合并 */
      debounced(content: string) {
        latestXmlRef.current = content;
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => void write(latestXmlRef.current), SAVE_DEBOUNCE_MS);
      },
      immediate() {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        void write(latestXmlRef.current);
      },
    };
  }, [path]);

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
  }, []);

  const urlParameters = useMemo(() => (mode === "preview"
    ? { chrome: true, nav: true, spin: true, lightbox: false }
    : { ui: "kennedy" as const, spin: true, libraries: true, saveAndExit: false }), [mode]);

  const header = (
    <div className={`drawio-head${compact ? " compact" : ""}`}>
      <span className="file-kind-badge kind-drawio">Draw.io</span>
      <span className="file-preview-name" title={path}>{displayName}</span>
      {mode === "edit" ? (
        <>
          <button type="button" className="drawio-save" onClick={() => persistXml.immediate()} disabled={saveState === "saving"}>
            {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败，重试" : "保存"}
          </button>
          <button type="button" className={`drawio-mode${mode === "edit" ? " active" : ""}`} onClick={() => setMode("preview")}>预览</button>
        </>
      ) : (
        <button type="button" className="drawio-mode" onClick={() => setMode("edit")}>编辑</button>
      )}
      {onClose ? (
        <button type="button" className="file-preview-close" onClick={onClose} aria-label="关闭预览">✕</button>
      ) : null}
    </div>
  );

  if (loading) {
    return (
      <div className={`file-preview${compact ? " compact" : ""}`}>
        {header}
        <div className="file-preview-loading">正在读取图表…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className={`file-preview${compact ? " compact" : ""}`}>
        {header}
        <div className="file-preview-error">{error}</div>
      </div>
    );
  }

  return (
    <div className={`file-preview drawio-preview${compact ? " compact" : ""}`}>
      {header}
      {offlineHint && !connected ? (
        <div className="drawio-offline-hint">图表编辑器（embed.diagrams.net）加载超时，请检查网络后重试；文件内容不受影响。</div>
      ) : null}
      <div className="drawio-canvas">
        <DrawIoEmbed
          key={mode}
          ref={embedRef}
          xml={xml}
          autosave={mode === "edit"}
          exportFormat="xmlsvg"
          urlParameters={urlParameters}
          onLoad={() => { setConnected(true); setOfflineHint(false); }}
          onConfigure={() => { setConnected(true); setOfflineHint(false); }}
          onAutoSave={mode === "edit" ? (data) => {
            setConnected(true);
            if (data.xml) persistXml.debounced(data.xml);
          } : undefined}
        />
      </div>
    </div>
  );
}
