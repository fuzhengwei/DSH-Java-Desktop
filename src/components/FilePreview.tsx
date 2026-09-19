import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfmCompatible from "../lib/remark-gfm-compatible";
import { FileActionsArea } from "./FileActionsMenu";
import { DrawioPreview } from "./DrawioPreview";

/**
 * 通用文件预览：按扩展名路由渲染方式。
 *  - md / markdown / txt / csv / json / 代码 → 文本渲染（md 走 Markdown，代码高亮底色）
 *  - docx → mammoth 转 HTML
 *  - xlsx / csv → SheetJS 表格渲染（csv 走文本也可，但表格化更直观）
 *  - png/jpg/gif/webp/svg → 图片
 *  - pdf → <iframe>（系统 webview 自带 PDF 能力）
 *  - drawio → embed.diagrams.net 渲染/编辑
 *  - 其它 → 提示不支持
 */

export type FileKind = "markdown" | "text" | "code" | "docx" | "xlsx" | "image" | "pdf" | "html" | "drawio" | "unknown";

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
  if (ext === "drawio") return "drawio";
  return "unknown";
}

/** 将 Markdown 链接中的本地文件 URL 转成 read_local_* 可读取的磁盘路径。 */
export function localFilePathFromHref(href?: string): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value) return null;

  try {
    if (value.toLowerCase().startsWith("file:")) {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      const path = decodeURIComponent(url.pathname);
      return fileKindOf(path) === "unknown" ? null : path;
    }
    if (value.startsWith("/")) {
      const path = decodeURIComponent(value.split(/[?#]/, 1)[0]);
      return fileKindOf(path) === "unknown" ? null : path;
    }
  } catch {
    return null;
  }
  return null;
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
  drawio: "Draw.io",
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

/** 消息正文中可识别为本地文件路径的扩展名（文档 + 代码） */
const PATH_EXTENSIONS = [
  "md", "markdown", "txt", "log", "csv", "tsv", "docx", "xlsx", "xls", "json", "pdf", "drawio",
  "png", "jpe?g", "gif", "webp", "svg", "ico", "bmp", "html?",
  // 代码类：Agent 操作代码时给出的文件也要能渲染成卡片
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "c", "h", "cpp", "hpp", "cc", "java", "kt", "kts",
  "rs", "go", "rb", "php", "swift", "vue", "svelte", "css", "scss", "less", "xml",
  "yaml", "yml", "toml", "sh", "bash", "zsh", "sql", "gradle", "properties", "ini", "cfg", "conf",
];

/** 扩展名交替项：按长度降序，避免 ".tsx" 被 ".ts" 抢先截断 */
const EXT_ALTERNATION = [...PATH_EXTENSIONS].sort((a, b) => b.length - a.length).join("|");

const LOCAL_PATH_RE = new RegExp(
  // 要求路径中至少含一个 "/"：既匹配绝对路径（/Users/x/y.ts），也匹配相对路径（src/lib/x.ts）
  `[^\\s<>（）()"'"|,；]*\\/[^\\s<>（）()"'"|,；]+\\.(?:${EXT_ALTERNATION})`,
  "gi",
);

/** 第二遍提取：允许含空格的绝对路径（如 macOS 的 "/Users/x/Application Support/y.html"）。
 *  锚定常见绝对路径根目录，避免把 URL 路径段误判为本地文件；
 *  懒匹配到第一个已知扩展名为止，避免把路径后的正文吞进来。 */
const ABSOLUTE_PATH_SPACES_RE = new RegExp(
  `(?:/(?:Users|tmp|var|private|home|Volumes|opt|Applications)/(?:[^\\s]| )*?)\\.(?:${EXT_ALTERNATION})`,
  "gi",
);

/** 修剪带空格候选路径的正文尾巴：空格后的末段若不含 "/"，视为路径外的文字，逐段剔除 */
function trimSpacedPathCandidate(raw: string): string | null {
  let candidate = raw.trim();
  while (candidate.includes(" ")) {
    const lastSegment = candidate.split(" ").pop() || "";
    if (lastSegment.includes("/")) break;
    candidate = candidate.slice(0, candidate.lastIndexOf(" ")).trimEnd();
  }
  return new RegExp(`\\.(?:${EXT_ALTERNATION})$`, "i").test(candidate) ? candidate : null;
}

/** 从消息正文中提取本地文件引用（供对话内嵌渲染调用） */
export function extractFilePaths(text: string): string[] {
  const results: string[] = [];
  for (const match of text.matchAll(LOCAL_PATH_RE)) {
    const cleaned = decodeLocalPath(match[0].replace(/[.,;:!?）)」】'")>]+$/, ""));
    if (!results.includes(cleaned)) results.push(cleaned);
  }
  for (const match of text.matchAll(ABSOLUTE_PATH_SPACES_RE)) {
    const raw = match[0];
    // 跳过 URL（https:、file: 等冒号后紧跟的路径段）
    const prevChar = match.index != null && match.index > 0 ? text[match.index - 1] : "";
    if (prevChar === ":" || raw.startsWith("//")) continue;
    const cleaned = trimSpacedPathCandidate(decodeLocalPath(raw));
    if (cleaned && !results.includes(cleaned)) results.push(cleaned);
  }
  return results;
}

/** 把 a/b/../c、./x 归一化成规整路径 */
function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return (path.startsWith("/") ? "/" : "") + segments.join("/");
}

/**
 * 为提取到的原始路径生成候选绝对路径：
 *  - 绝对路径（/、~/ 开头）→ 原样；
 *  - 相对路径 → 优先按当前项目根解析（Agent 回复里常写 src/App.tsx），原路径兜底。
 */
function resolvePathCandidates(raw: string, basePath?: string): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  if (raw.startsWith("/") || raw.startsWith("~")) {
    push(raw);
  } else {
    if (basePath) push(normalizePath(`${basePath}/${raw}`));
    push(raw);
  }
  return candidates;
}

function decodeLocalPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 扩展名徽标文案：代码类显示大写扩展名（TS/TSX/JAVA…），其余按类型显示中文 */
function badgeLabelOf(name: string): { text: string; kind: FileKind } {
  const kind = fileKindOf(name);
  if (kind === "code") {
    const ext = (name.split(".").pop() || "").toUpperCase();
    return { text: ext.slice(0, 5) || "代码", kind };
  }
  if (kind === "unknown") return { text: "文件", kind };
  return { text: KIND_LABEL[kind], kind };
}

function formatFileSize(size: number | null): string {
  if (size == null || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export const FilePreview = function FilePreview(props: Props) {
  const displayName = props.name || props.path.split("/").filter(Boolean).pop() || props.path;
  const kind = useMemo(() => fileKindOf(displayName), [displayName]);

  // draw.io 有独立的查看/编辑器（含头部），直接整体接管渲染，避免双层头部
  if (kind === "drawio") {
    return <DrawioPreview path={props.path} onClose={props.onClose} compact={props.compact} />;
  }
  return <FilePreviewBody {...props} />;
};

function FilePreviewBody({ path, name, onClose, compact }: Props) {
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
    <FileActionsArea path={path}>
      <div className={`file-preview-head${compact ? " compact" : ""}`}>
        <span className={`file-kind-badge kind-${kind}`}>{KIND_LABEL[kind]}</span>
        <span className="file-preview-name" title={path}>{displayName}</span>
        {onClose ? (
          <button type="button" className="file-preview-close" onClick={onClose} aria-label="关闭预览">✕</button>
        ) : null}
      </div>
    </FileActionsArea>
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
            <ReactMarkdown remarkPlugins={[remarkGfmCompatible]}>{text}</ReactMarkdown>
          </div>
        ) : kind === "text" ? (
          <pre className="file-preview-plain">{text}</pre>
        ) : kind === "code" ? (
          <CodeView code={text} />
        ) : kind === "docx" ? (
          <DocxPreview base64={binary} />
        ) : kind === "xlsx" ? (
          <SheetPreview base64={binary} name={displayName} />
        ) : kind === "image" ? (
          <img className="file-preview-image" alt={displayName} src={`data:image;base64,${binary}`} />
        ) : kind === "pdf" ? (
          <iframe className="file-preview-frame" title={displayName} src={`data:application/pdf;base64,${binary}`} />
        ) : kind === "html" ? (
          <HtmlPreview base64={binary} name={displayName} />
        ) : (
          <div className="file-preview-error">暂不支持预览该格式，可在系统中直接打开</div>
        )}
      </div>
    </div>
  );
};;

function binaryToText(base64: string): string {
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return "";
  }
}

/** 匹配引用 echarts 的 CDN script 标签（如 jsdelivr / unpkg / cdnjs） */
const ECHARTS_CDN_SCRIPT_RE = /<script[^>]*\bsrc\s*=\s*["'][^"']*echarts[^"']*["'][^>]*>\s*<\/script>/gi;
const ECHARTS_CDN_SCRIPT_TEST_RE = /<script[^>]*\bsrc\s*=\s*["'][^"']*echarts[^"']*["'][^>]*>\s*<\/script>/i;

/**
 * HTML 文件预览：若页面通过 CDN 引入 echarts，则替换为应用内置的 echarts 源码内联执行，
 * 断网或 CDN 不可达（jsdelivr 国内不稳定）时图表也能正常渲染。其余页面原样渲染。
 */
function HtmlPreview({ base64, name }: { base64: string; name: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let text = binaryToText(base64);
      if (ECHARTS_CDN_SCRIPT_TEST_RE.test(text)) {
        try {
          const mod = await import("../lib/echarts-embed");
          const source = mod.default.replace(/<\/script>/gi, "<\\/script>");
          text = text.replace(ECHARTS_CDN_SCRIPT_RE, () => `<script>${source}<\/script>`);
        } catch {
          // 内置源码加载失败：保留原 CDN 引用
        }
      }
      if (!cancelled) setHtml(text);
    })();
    return () => { cancelled = true; };
  }, [base64]);
  return (
    <iframe
      className="file-preview-frame"
      title={name}
      srcDoc={html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}

/** 代码视图上限：超出则截断展示，避免超大文件卡死渲染 */
const CODE_VIEW_MAX_LINES = 20_000;

/** 代码文件查看器：行号栏 + 源码，对齐 IDE 的阅读体验 */
function CodeView({ code }: { code: string }) {
  const allLines = code.split("\n");
  const truncated = allLines.length > CODE_VIEW_MAX_LINES;
  const shown = truncated ? allLines.slice(0, CODE_VIEW_MAX_LINES) : allLines;
  const gutter = Array.from({ length: shown.length }, (_, index) => index + 1).join("\n");
  return (
    <div className="file-preview-codeblock">
      {truncated ? (
        <div className="file-preview-truncated">文件过长，仅显示前 {CODE_VIEW_MAX_LINES.toLocaleString()} 行</div>
      ) : null}
      <div className="code-view">
        <pre className="code-view-gutter" aria-hidden="true">{gutter}</pre>
        <pre className="code-view-lines"><code>{shown.join("\n")}</code></pre>
      </div>
    </div>
  );
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

/** 对话内嵌文件渲染卡片：正文中出现本地文件路径（绝对或相对项目根）时自动渲染 */
export function InlineFileCards({ content, onOpenFile, basePath }: {
  content: string;
  onOpenFile?: (path: string) => void;
  /** 当前项目根路径：用于把 Agent 回复中的相对路径（src/App.tsx）解析为可读取的绝对路径 */
  basePath?: string;
}) {
  const rawPaths = useMemo(() => extractFilePaths(content), [content]);
  const [entries, setEntries] = useState<Map<string, { path: string; size: number | null; exists: boolean }> | null>(null);

  useEffect(() => {
    if (rawPaths.length === 0) {
      setEntries(new Map());
      return;
    }
    setEntries(null);
    let cancelled = false;
    const candidateLists = rawPaths.map((raw) => resolvePathCandidates(raw, basePath));
    const allCandidates = candidateLists.flat();
    void Promise.all([
      invoke<string[]>("existing_local_files", { paths: allCandidates }).catch(() => [] as string[]),
      invoke<(number | null)[]>("local_file_metas", { paths: allCandidates }).catch(() => [] as (number | null)[]),
    ]).then(([existingList, sizeList]) => {
      if (cancelled) return;
      const existingSet = new Set(existingList);
      const sizeByPath = new Map<string, number | null>();
      allCandidates.forEach((candidate, index) => sizeByPath.set(candidate, sizeList[index] ?? null));
      const next = new Map<string, { path: string; size: number | null; exists: boolean }>();
      rawPaths.forEach((raw, index) => {
        const found = candidateLists[index].find((candidate) => existingSet.has(candidate));
        next.set(raw, found
          ? { path: found, size: sizeByPath.get(found) ?? null, exists: true }
          : { path: candidateLists[index][0], size: null, exists: false });
      });
      setEntries(next);
    });
    return () => { cancelled = true; };
  }, [rawPaths, basePath]);

  if (rawPaths.length === 0 || !entries) return null;
  // 相对路径解析不到真实文件的多半是正文误匹配，直接不渲染；显式绝对路径保留（提示已不存在）
  const visible = rawPaths.filter((raw) => {
    const entry = entries.get(raw);
    return entry && (entry.exists || raw.startsWith("/") || raw.startsWith("~"));
  });
  return (
    <div className="inline-file-cards">
      {visible.slice(0, 6).map((raw) => {
        const entry = entries.get(raw)!;
        return (
          <InlineFileCard
            key={raw}
            path={entry.path}
            size={entry.size}
            exists={entry.exists}
            onOpenFile={onOpenFile}
          />
        );
      })}
    </div>
  );
}

function InlineFileCard({ path, size, exists, onOpenFile }: { path: string; size: number | null; exists: boolean; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const name = path.split("/").filter(Boolean).pop() || path;
  const badge = badgeLabelOf(name);
  const sizeLabel = formatFileSize(size);
  // html/pdf 这类整页内容内嵌展示又窄又挤：有右侧面板时隐藏内嵌入口，主点击直接在右侧打开（与 Excel 一致）
  const fullPageKind = ["html", "pdf"].includes(badge.kind);
  const allowInline = !onOpenFile || !fullPageKind;
  // 有右侧面板回调时主点击直接在面板打开（对齐文件产物的查看体验），否则内嵌展开
  const handleMainClick = () => {
    if (onOpenFile) onOpenFile(path);
    else setOpen(true);
  };
  if (!open) {
    return (
      <FileActionsArea path={exists ? path : null}>
        <span className="inline-file-trigger-wrap">
          <button
            type="button"
            className="inline-file-trigger"
            onClick={handleMainClick}
            title={exists ? `${path}（右键可打开/另存为）` : `${path}（文件已不存在）`}
            disabled={!exists}
          >
            <span className={`file-kind-badge kind-${badge.kind}`}>{badge.text}</span>
            <span className="inline-file-name">{name}</span>
            {sizeLabel ? <span className="inline-file-size">{sizeLabel}</span> : null}
            <span className="inline-file-hint">{exists ? (onOpenFile ? "点击在右侧打开" : "点击预览") : "文件不存在"}</span>
          </button>
          {exists && allowInline ? (
            <button type="button" className="inline-file-dock" onClick={() => setOpen(true)} title="在对话内展开预览">
              内嵌预览 ⌄
            </button>
          ) : null}
        </span>
      </FileActionsArea>
    );
  }
  return <FilePreview path={path} compact onClose={() => setOpen(false)} />;
}
