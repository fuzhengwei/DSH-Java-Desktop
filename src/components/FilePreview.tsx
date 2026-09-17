import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 通用文件预览：按扩展名路由渲染方式。
 *  - md / markdown / txt / csv / json / 代码 → 文本渲染（md 走 Markdown，代码高亮底色）
 *  - docx → mammoth 转 HTML
 *  - xlsx / csv → SheetJS 表格渲染（csv 走文本也可，但表格化更直观）
 *  - png/jpg/gif/webp/svg → 图片
 *  - pdf → <iframe>（系统 webview 自带 PDF 能力）
 *  - 其它 → 提示不支持
 */

export type FileKind = "markdown" | "text" | "code" | "docx" | "xlsx" | "image" | "pdf" | "html" | "unknown";

export function fileKindOf(name: string): FileKind {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["txt", "log"].includes(ext)) return "text";
  if (["csv", "tsv"].includes(ext)) return "xlsx"; // 表格化展示
  if (["json", "ts", "tsx", "js", "jsx", "css", "rs", "py", "java", "xml", "yaml", "yml", "toml", "sh", "sql"].includes(ext)) return "code";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm") return "html";
  return "unknown";
}

const KIND_LABEL: Record<FileKind, string> = {
  markdown: "Markdown",
  text: "文本",
  code: "代码",
  docx: "Word",
  xlsx: "表格",
  image: "图片",
  pdf: "PDF",
  html: "网页",
  unknown: "文件",
};

type Props = {
  /** 文件绝对路径（磁盘文件） */
  path: string;
  /** 可选显示名（默认取 path 末段） */
  name?: string;
  /** 关闭按钮（Dock 内使用时） */
  onClose?: () => void;
  /** 紧凑模式（对话内嵌卡片） */
  compact?: boolean;
};

/** 从消息正文中提取首个本地文件引用（供对话内嵌渲染调用） */
export function extractFilePaths(text: string): string[] {
  const results: string[] = [];
  const re = /(?:\/[^\s<>）)」】"'，。；]+?\.(?:md|markdown|txt|csv|docx|xlsx|xls|json|pdf|png|jpe?g|gif|webp|svg|html?))/gi;
  for (const match of text.matchAll(re)) {
    const cleaned = match[0].replace(/[.,;:!?）)」】'"]+$/, "");
    if (!results.includes(cleaned)) results.push(cleaned);
  }
  return results;
}

export const FilePreview = function FilePreview({ path, name, onClose, compact }: Props) {
  const displayName = name || path.split("/").filter(Boolean).pop() || path;
  const kind = useMemo(() => fileKindOf(displayName), [displayName]);
  const [text, setText] = useState("");
  const [binary, setBinary] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        if (kind === "docx" || kind === "xlsx" || kind === "image" || kind === "pdf" || kind === "html") {
          const base64 = await invoke<string>("read_local_file_base64", { path });
          if (cancelled) return;
          setBinary(base64);
          // docx/xlsx 需要解析库，动态加载（二进制先存着，交给 lib 渲染）
        } else {
          const content = await invoke<string>("read_local_text_file", { path });
          if (cancelled) return;
          setText(content);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path, kind]);

  const header = (
    <div className={`file-preview-head${compact ? " compact" : ""}`}>
      <span className={`file-kind-badge kind-${kind}`}>{KIND_LABEL[kind]}</span>
      <span className="file-preview-name" title={path}>{displayName}</span>
      {onClose ? (
        <button type="button" className="file-preview-close" onClick={onClose} aria-label="关闭预览">✕</button>
      ) : null}
    </div>
  );

  if (loading) {
    return (
      <div className={`file-preview${compact ? " compact" : ""}`}>
        {header}
        <div className="file-preview-loading">正在读取文件…</div>
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
    <div className={`file-preview${compact ? " compact" : ""}`}>
      {header}
      <div className="file-preview-body">
        {kind === "markdown" ? (
          <div className="file-preview-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        ) : kind === "text" ? (
          <pre className="file-preview-plain">{text}</pre>
        ) : kind === "code" ? (
          <pre className="file-preview-code"><code>{text}</code></pre>
        ) : kind === "docx" ? (
          <DocxPreview base64={binary} />
        ) : kind === "xlsx" ? (
          <SheetPreview base64={binary} name={displayName} />
        ) : kind === "image" ? (
          <img className="file-preview-image" alt={displayName} src={`data:image;base64,${binary}`} />
        ) : kind === "pdf" ? (
          <iframe className="file-preview-frame" title={displayName} src={`data:application/pdf;base64,${binary}`} />
        ) : kind === "html" ? (
          <iframe className="file-preview-frame" title={displayName} srcDoc={binaryToText(binary)} sandbox="allow-scripts" />
        ) : (
          <div className="file-preview-error">暂不支持预览该格式，可在系统中直接打开</div>
        )}
      </div>
    </div>
  );
};

function binaryToText(base64: string): string {
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return "";
  }
}

/** docx 渲染：mammoth 体积较大，动态 import 按需加载 */
function DocxPreview({ base64 }: { base64: string }) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mammoth = await import("mammoth/mammoth.browser");
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
        if (!cancelled) setHtml(result.value);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => { cancelled = true; };
  }, [base64]);
  if (error) return <div className="file-preview-error">Word 渲染失败：{error}</div>;
  return <div className="file-preview-docx" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** xlsx/csv 渲染：SheetJS 动态加载 */
function SheetPreview({ base64, name }: { base64: string; name: string }) {
  const [sheets, setSheets] = useState<Array<{ name: string; html: string }>>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const XLSX = await import("xlsx");
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const wb = XLSX.read(bytes.buffer, { type: "array" });
        const list = wb.SheetNames.map((sheetName) => ({
          name: sheetName,
          html: XLSX.utils.sheet_to_html(wb.Sheets[sheetName]),
        }));
        if (!cancelled) setSheets(list);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => { cancelled = true; };
  }, [base64, name]);
  if (error) return <div className="file-preview-error">表格渲染失败：{error}</div>;
  return (
    <div className="file-preview-sheet">
      {sheets.map((sheet) => (
        <div key={sheet.name} className="file-preview-sheet-tab">
          <div className="file-preview-sheet-title">{sheet.name}</div>
          <div className="file-preview-sheet-grid" dangerouslySetInnerHTML={{ __html: sheet.html }} />
        </div>
      ))}
    </div>
  );
}

/** 对话内嵌文件渲染卡片：正文中出现本地文件路径时自动渲染 */
export function InlineFileCards({ content, onOpenFile }: { content: string; onOpenFile?: (path: string) => void }) {
  const paths = useMemo(() => extractFilePaths(content), [content]);
  if (paths.length === 0) return null;
  return (
    <div className="inline-file-cards">
      {paths.slice(0, 3).map((filePath) => (
        <InlineFileCard key={filePath} path={filePath} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function InlineFileCard({ path, onOpenFile }: { path: string; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const name = path.split("/").filter(Boolean).pop() || path;
  if (!open) {
    return (
      <span className="inline-file-trigger-wrap">
        <button type="button" className="inline-file-trigger" onClick={() => setOpen(true)} title={path}>
          <span className="file-kind-badge">{fileKindOf(name) === "unknown" ? "文件" : KIND_LABEL[fileKindOf(name)]}</span>
          <span className="inline-file-name">{name}</span>
          <span className="inline-file-hint">点击渲染预览</span>
        </button>
        {onOpenFile ? (
          <button type="button" className="inline-file-dock" onClick={() => onOpenFile(path)} title="在右侧面板打开">
            在右侧打开 ↗
          </button>
        ) : null}
      </span>
    );
  }
  return <FilePreview path={path} compact onClose={() => setOpen(false)} />;
}
