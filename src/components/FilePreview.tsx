import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import hljs from "highlight.js/lib/common";
import remarkGfmCompatible from "../lib/remark-gfm-compatible";
import { rehypeHighlight, languageFromExtension } from "../lib/markdown-plugins";
import { FileActionsArea } from "./FileActionsMenu";
import { DrawioPreview } from "./DrawioPreview";
import { DiffView, useFileDiff } from "./DiffView";
import { CompressIcon, ExpandIcon, PanelCollapseIcon } from "./icons";

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

export type FileKind = "markdown" | "text" | "code" | "docx" | "xlsx" | "image" | "pdf" | "html" | "drawio" | "binary" | "unknown";

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
  // 已知二进制：十六进制 + 字符串视图（如 .class 可看到常量池里的类名/方法名）
  if (["class", "jar", "war", "so", "dylib", "dll", "exe", "bin", "o", "a",
    "zip", "tar", "gz", "7z", "rar", "bz2", "xz",
    "woff", "woff2", "ttf", "otf", "eot", "mp4", "mp3", "wav", "mov", "webm"].includes(ext)) return "binary";
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
  binary: "二进制",
  unknown: "文件",
};

type Props = {
  /** 文件绝对路径（磁盘文件） */
  path: string;
  /** 可选显示名（默认取 path 末段） */
  name?: string;
  /** 关闭按钮（Dock 内使用时） */
  onClose?: () => void;
  /** 收回：收起整个右侧 Dock 面板（Dock 内文件预览时提供） */
  onCollapse?: () => void;
  /** 放大/还原：把文件预览区放大到铺满窗口（Dock 内文件预览时提供） */
  onToggleMaximize?: () => void;
  /** 当前是否处于放大状态（控制放大按钮图标切换） */
  maximized?: boolean;
  /** 紧凑模式（对话内嵌卡片） */
  compact?: boolean;
  /** 文件所在工程根（用于定位 git 仓库展示 Diff；不传则不启用 Diff） */
  basePath?: string;
  /** 代码预览中选中片段 → 「加入对话」（作为代码片段资源注入输入框） */
  onAddCodeSnippet?: (snippet: CodeSnippet) => void;
};

/** 文件预览中选中的代码片段（含定位信息，供对话引用） */
export type CodeSnippet = {
  path: string;
  name: string;
  code: string;
  startLine: number;
  endLine: number;
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

function formatFileSize(size: number | null): string {
  if (size == null || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 按扩展名推导图片 MIME 类型。WebView 对 data URL 要求子类型正确：
 *  特别是 SVG 必须用 image/svg+xml，写成裸 image 无法渲染。 */
function imageMimeOf(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "ico": return "image/x-icon";
    default: return "image/png";
  }
}

// ── 统一文件卡片 ─────────────────────────────────────────────
// 对话内嵌文件、数字人房间产物、群聊交付物共用同一套卡片视觉：
// 类型色块图标（代码类显示大写扩展名）+ 文件名 + 类型/大小元信息 + 动作文案。

/** 图标色块上的短文案 */
const KIND_ICON_TEXT: Record<FileKind, string> = {
  markdown: "MD", text: "TXT", code: "CODE", docx: "DOC", xlsx: "XLS",
  image: "IMG", pdf: "PDF", html: "HTML", drawio: "DRAW", binary: "BIN", unknown: "FILE",
};

/**
 * 按文件名（或产物 kind 提示）推导卡片的图标、类型与中文标签。
 *  - fileName 优先：真实文件能拿到精确扩展名（代码类显示 TS/JAVA 等大写扩展名）；
 *  - 无文件名时用 kindHint（artifact.kind，如 "markdown"/"echarts"）近似推断。
 */
export function fileCardIcon(opts: { fileName?: string; kindHint?: string }): { text: string; kind: FileKind; label: string } {
  const fileName = (opts.fileName || "").trim();
  if (fileName) {
    const kind = fileKindOf(fileName);
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    if (kind === "code") {
      const lang = languageFromExtension(fileName);
      const label = lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : "代码";
      return { text: ext.slice(0, 4).toUpperCase() || "CODE", kind, label };
    }
    if (kind === "xlsx" && (ext === "csv" || ext === "tsv")) return { text: "CSV", kind, label: "表格" };
    return { text: KIND_ICON_TEXT[kind], kind, label: KIND_LABEL[kind] };
  }
  const hint = (opts.kindHint || "").trim();
  if (hint) {
    const mapped = fileKindOf(`x.${hint.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
    if (mapped !== "unknown") return { text: KIND_ICON_TEXT[mapped], kind: mapped, label: KIND_LABEL[mapped] };
    if (/echart|chart/i.test(hint)) return { text: "图表", kind: "image", label: "图表" };
    return { text: hint.slice(0, 4).toUpperCase(), kind: "unknown", label: hint };
  }
  return { text: "FILE", kind: "unknown", label: "文件" };
}

export type FileCardState = "ready" | "pending" | "missing";

/**
 * 统一文件卡片。三种用法：
 *  - 默认（button）：自带点击 + 右键菜单，消息流内直接使用；
 *  - dock：传入 dock 节点（如「内嵌预览」按钮）拼在主按钮右侧，共享外框；
 *  - nested：渲染为 span，嵌在另一个按钮内部（群聊交付卡），点击交给外层。
 */
export function FileCard(props: {
  title: string;
  icon: { text: string; kind: FileKind };
  /** 第二行元信息：类型 · 大小 / 生成中 / 已失效（由调用方按状态组好） */
  meta: string;
  state?: FileCardState;
  /** 就绪态动作文案，默认「查看 →」 */
  actionText?: string;
  onClick?: () => void;
  /** 右键菜单绑定的真实文件路径 */
  menuPath?: string | null;
  /** 不可点时的悬浮提示（生成中 / 已失效原因） */
  disabledTitle?: string;
  dock?: ReactNode;
  nested?: boolean;
}) {
  const { title, icon, meta, state = "ready", actionText, onClick, menuPath = null, disabledTitle, dock, nested } = props;
  const clickable = !nested && state === "ready" && Boolean(onClick);
  const action = state === "pending" ? "稍后可查看" : state === "missing" ? "已失效" : (actionText || "查看 →");
  const body = (
    <>
      <span className={`file-card-icon kind-${icon.kind}`} aria-hidden="true">{icon.text}</span>
      <span className="file-card-text">
        <span className="file-card-title" title={title}>{title}</span>
        <span className="file-card-meta">{meta}</span>
      </span>
      <span className="file-card-action">{action}</span>
    </>
  );
  if (nested) {
    return <span className={`file-card nested${state !== "ready" ? ` ${state}` : ""}`}>{body}</span>;
  }
  return (
    <FileActionsArea path={menuPath}>
      <span className="file-card-row">
        <button
          type="button"
          className={`file-card${clickable ? " clickable" : state !== "ready" ? ` ${state}` : ""}`}
          title={clickable ? `${title}（右键可打开/另存为）` : (disabledTitle || title)}
          disabled={!clickable}
          onClick={clickable ? onClick : undefined}
        >
          {body}
        </button>
        {dock}
      </span>
    </FileActionsArea>
  );
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

/** 文本/代码类文件：有 Git 变更时头部出现「源码 / Diff」切换 */
function FilePreviewBody({ path, name, onClose, onCollapse, onToggleMaximize, maximized, compact, basePath, onAddCodeSnippet }: Props) {
  const displayName = name || path.split("/").filter(Boolean).pop() || path;
  const kind = useMemo(() => fileKindOf(displayName), [displayName]);
  const [text, setText] = useState("");
  const [binary, setBinary] = useState("");
  const [binaryFallback, setBinaryFallback] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // "source" 默认源码视图；文件有 Git 差异时才允许切 "diff"
  const [view, setView] = useState<"source" | "diff">("source");
  const diffable = Boolean(basePath) && (kind === "code" || kind === "text" || kind === "markdown");
  const { diff } = useFileDiff(diffable ? (basePath as string) : "", path);
  const hasDiff = Boolean(diff?.available && !diff.isBinary);

  // 文件被外部（Agent / 其他进程）改写后自动刷新：
  // 轮询 mtime+size 指纹，变化则 bump 版本号触发下方读取 effect 重跑。
  const [contentVersion, setContentVersion] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let last = "";
    const poll = () => {
      void invoke<{ mtimeMs: number; size: number } | null>("local_file_stamp", { path })
        .then((stamp) => {
          if (cancelled || !stamp) return;
          const key = `${stamp.mtimeMs}:${stamp.size}`;
          if (key !== last) {
            const first = last === "";
            last = key;
            if (!first) setContentVersion((value) => value + 1);
          }
        })
        .catch(() => { /* 文件暂不可访问：忽略 */ });
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [path]);

  // Agent 改动使 Diff 首次出现时自动切到 Diff 视图（改动消失则回到源码）
  const hasDiffRef = useRef(hasDiff);
  useEffect(() => {
    if (hasDiffRef.current !== hasDiff) {
      hasDiffRef.current = hasDiff;
      if (diffable) setView(hasDiff ? "diff" : "source");
    }
  }, [hasDiff, diffable]);

  useEffect(() => {
    // 文件切换时重置视图，避免在新文件上停留在失效的 Diff
    setView("source");
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setBinaryFallback(false);
    void (async () => {
      try {
        if (kind === "docx" || kind === "xlsx" || kind === "image" || kind === "pdf" || kind === "html" || kind === "binary") {
          const base64 = await invoke<string>("read_local_file_base64", { path });
          if (cancelled) return;
          setBinary(base64);
          // docx/xlsx 需要解析库，动态加载（二进制先存着，交给 lib 渲染）
        } else {
          try {
            const content = await invoke<string>("read_local_text_file", { path });
            if (cancelled) return;
            setText(content);
          } catch (textError) {
            // 无扩展名的二进制（非法 UTF-8）等：降级为十六进制视图而不是报错
            const base64 = await invoke<string>("read_local_file_base64", { path });
            if (cancelled) return;
            setBinary(base64);
            setBinaryFallback(true);
            void textError;
          }
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path, kind, contentVersion]);

  const header = (
    <FileActionsArea path={path}>
      <div className={`file-preview-head${compact ? " compact" : ""}`}>
        <span className={`file-kind-badge kind-${binaryFallback ? "binary" : kind}`}>{KIND_LABEL[binaryFallback ? "binary" : kind]}</span>
        <span className="file-preview-name" title={path}>{displayName}</span>
        {diffable && hasDiff ? (
          <span className="file-preview-viewtoggle" role="tablist" aria-label="视图切换">
            <button
              type="button"
              className={view === "source" ? "active" : ""}
              onClick={() => setView("source")}
            >
              源码
            </button>
            <button
              type="button"
              className={view === "diff" ? "active" : ""}
              onClick={() => setView("diff")}
            >
              Diff
              {diff ? (
                <em className="rail-diff">
                  {diff.insertions > 0 ? <em className="rail-diff-add">+{diff.insertions}</em> : null}
                  {diff.deletions > 0 ? <em className="rail-diff-del">-{diff.deletions}</em> : null}
                </em>
              ) : null}
            </button>
          </span>
        ) : null}
        {onToggleMaximize ? (
          <button
            type="button"
            className="file-preview-btn"
            onClick={onToggleMaximize}
            aria-label={maximized ? "还原大小" : "放大预览"}
            title={maximized ? "还原大小" : "放大预览"}
          >
            {maximized ? <CompressIcon className="icon-14" /> : <ExpandIcon className="icon-14" />}
          </button>
        ) : null}
        {onCollapse ? (
          <button
            type="button"
            className="file-preview-btn"
            onClick={onCollapse}
            aria-label="收回面板"
            title="收回面板"
          >
            <PanelCollapseIcon className="icon-14" />
          </button>
        ) : null}
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

  const diffView = diffable && view === "diff" && hasDiff ? (
    <DiffView basePath={basePath as string} filePath={path} />
  ) : null;

  const sourceBody = (
    <>
      {kind === "markdown" ? (
        <div className="file-preview-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfmCompatible]} rehypePlugins={[rehypeHighlight]}>{text}</ReactMarkdown>
        </div>
      ) : kind === "text" ? (
        <pre className="file-preview-plain">{text}</pre>
      ) : kind === "code" ? (
        <CodeView code={text} name={displayName} onAddSnippet={onAddCodeSnippet ? (code, startLine, endLine) => onAddCodeSnippet({ path, name: displayName, code, startLine, endLine }) : undefined} />
      ) : kind === "docx" ? (
        <DocxPreview base64={binary} />
      ) : kind === "xlsx" ? (
        <SheetPreview base64={binary} name={displayName} />
      ) : kind === "image" ? (
        <img className="file-preview-image" alt={displayName} src={`data:${imageMimeOf(displayName)};base64,${binary}`} />
      ) : kind === "pdf" ? (
        <iframe className="file-preview-frame" title={displayName} src={`data:application/pdf;base64,${binary}`} />
      ) : kind === "html" ? (
        <HtmlPreview base64={binary} name={displayName} />
      ) : kind === "binary" || binaryFallback ? (
        <BinaryView base64={binary} />
      ) : (
        <div className="file-preview-error">暂不支持预览该格式，可在系统中直接打开</div>
      )}
    </>
  );

  return (
    <div className={`file-preview${compact ? " compact" : ""}`}>
      {header}
      {diffView ? (
        <div className="file-preview-body diff-body">{diffView}</div>
      ) : (
        <div className="file-preview-body">{sourceBody}</div>
      )}
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

/** 十六进制视图的字节上限（前端渲染性能考虑，.class 一般远小于此） */
const HEX_DUMP_LIMIT = 4096;

/**
 * 二进制文件预览：文件概要（大小 / 魔数 / class 版本）+ 十六进制转储（前 4KB）
 * + 可打印字符串（≥5 字符，前 100 条）。对 .class 而言字符串区就是常量池，
 * 能直接看到类名、方法名、描述符等关键信息。
 */
function BinaryView({ base64 }: { base64: string }) {
  const bytes = useMemo(() => {
    try {
      const raw = atob(base64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    } catch {
      return new Uint8Array(0);
    }
  }, [base64]);

  const summary = useMemo(() => {
    const lines: string[] = [];
    lines.push(`大小：${formatFileSize(bytes.length)}`);
    if (bytes.length >= 4) {
      const magic = Array.from(bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" ").toUpperCase();
      if (magic === "CA FE BA BE") {
        const major = bytes.length >= 8 ? (bytes[6] << 8) | bytes[7] : 0;
        const javaVersion = major >= 45 ? major - 44 : 0; // major 52 → Java 8，以此类推
        lines.push(`类型：Java 字节码（CAFEBABE，class 版本 ${major}${javaVersion > 0 ? ` / Java ${javaVersion}` : ""}）`);
      } else {
        lines.push(`魔数：${magic}`);
      }
    }
    return lines;
  }, [bytes]);

  const hexDump = useMemo(() => {
    const slice = bytes.slice(0, HEX_DUMP_LIMIT);
    const rows: string[] = [];
    for (let offset = 0; offset < slice.length; offset += 16) {
      const chunk = Array.from(slice.slice(offset, offset + 16));
      const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
      const ascii = chunk.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
      rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
    }
    return rows.join("\n");
  }, [bytes]);

  const strings = useMemo(() => {
    const found: string[] = [];
    const scanLimit = Math.min(bytes.length, 1024 * 1024); // 大文件只扫前 1MB，防卡顿
    let run = "";
    for (let i = 0; i < scanLimit && found.length < 100; i++) {
      const b = bytes[i];
      if (b >= 0x20 && b < 0x7f) {
        run += String.fromCharCode(b);
      } else {
        if (run.length >= 5) found.push(run);
        run = "";
      }
    }
    if (run.length >= 5 && found.length < 100) found.push(run);
    return found;
  }, [bytes]);

  if (bytes.length === 0) {
    return <div className="file-preview-error">文件为空或读取失败</div>;
  }
  return (
    <div className="file-preview-binary">
      <div className="binary-summary">
        {summary.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      <div className="binary-section-title">十六进制（前 {Math.min(bytes.length, HEX_DUMP_LIMIT)} 字节）</div>
      <pre className="binary-hex">{hexDump}</pre>
      {strings.length > 0 ? (
        <>
          <div className="binary-section-title">内嵌字符串（前 {strings.length} 条{bytes.length > 1024 * 1024 ? "，扫描前 1MB" : ""}）</div>
          <ul className="binary-strings">
            {strings.map((entry, index) => (
              <li key={`${index}-${entry}`} className="binary-string-item">{entry}</li>
            ))}
          </ul>
        </>
      ) : null}
      {bytes.length > HEX_DUMP_LIMIT ? (
        <div className="binary-more">仅展示前 {HEX_DUMP_LIMIT / 1024}KB，完整内容可在系统中打开</div>
      ) : null}
    </div>
  );
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
/** 自动语言探测的字符上限：超大文件直接按纯文本展示，避免 highlightAuto 卡顿 */
const AUTO_DETECT_MAX_CHARS = 100_000;

/** 代码文件查看器：行号栏 + 源码，对齐 IDE 的阅读体验；支持选中片段「加入对话」 */
function CodeView({ code, name, onAddSnippet }: { code: string; name?: string; onAddSnippet?: (code: string, startLine: number, endLine: number) => void }) {
  const allLines = code.split("\n");
  const truncated = allLines.length > CODE_VIEW_MAX_LINES;
  const shown = truncated ? allLines.slice(0, CODE_VIEW_MAX_LINES) : allLines;
  const shownText = shown.join("\n");
  const gutter = Array.from({ length: shown.length }, (_, index) => index + 1).join("\n");
  const codeElRef = useRef<HTMLElement | null>(null);
  // 当前选中片段（plain 文本 + 行号范围）；null 表示无有效选中
  const [selection, setSelection] = useState<{ code: string; startLine: number; endLine: number } | null>(null);

  // 按扩展名做语法高亮；未知扩展名且内容不大时自动探测，失败则回退纯文本
  const highlightedHtml = useMemo(() => {
    try {
      const lang = name ? languageFromExtension(name) : null;
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(shownText, { language: lang, ignoreIllegals: true }).value;
      }
      if (shownText.length <= AUTO_DETECT_MAX_CHARS) {
        return hljs.highlightAuto(shownText).value;
      }
    } catch {
      // 高亮失败回退纯文本
    }
    return null;
  }, [shownText, name]);

  // 计算 selection 锚点在 code 元素纯文本中的偏移（TreeWalker 累加文本节点长度）
  const textOffsetOf = (codeEl: HTMLElement, range: Range, atStart: boolean): number | null => {
    const targetNode = atStart ? range.startContainer : range.endContainer;
    const targetOffset = atStart ? range.startOffset : range.endOffset;
    let count = 0;
    let hit = false;
    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node) {
      if (node === targetNode) {
        count += targetOffset;
        hit = true;
        break;
      }
      count += (node.textContent || "").length;
      node = walker.nextNode();
    }
    return hit ? count : null;
  };

  // selectionchange：仅当选中发生在本代码块内时计算片段与行号范围
  useEffect(() => {
    const handleSelectionChange = () => {
      const codeEl = codeElRef.current;
      if (!codeEl || !onAddSnippet) return;
      const domSelection = document.getSelection();
      if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = domSelection.getRangeAt(0);
      if (!codeEl.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const startOffset = textOffsetOf(codeEl, range, true);
      const endOffset = textOffsetOf(codeEl, range, false);
      if (startOffset == null || endOffset == null || endOffset <= startOffset) {
        setSelection(null);
        return;
      }
      const selected = shownText.slice(startOffset, endOffset);
      const startLine = shownText.slice(0, startOffset).split("\n").length;
      const endLine = startLine + selected.split("\n").length - 1;
      setSelection({ code: selected, startLine, endLine });
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [shownText, onAddSnippet]);

  const selectionLineCount = selection ? selection.endLine - selection.startLine + 1 : 0;

  return (
    <div className="file-preview-codeblock">
      {truncated ? (
        <div className="file-preview-truncated">文件过长，仅显示前 {CODE_VIEW_MAX_LINES.toLocaleString()} 行</div>
      ) : null}
      <div className={`code-view${selection ? " has-selection" : ""}`}>
        <pre className="code-view-gutter" aria-hidden="true">{gutter}</pre>
        <pre className="code-view-lines">
          {highlightedHtml != null
            ? <code ref={codeElRef} dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
            : <code ref={codeElRef}>{shownText}</code>}
        </pre>
        {selection && onAddSnippet ? (
          <button
            type="button"
            className="code-selection-add"
            title={`将第 ${selection.startLine}-${selection.endLine} 行加入对话`}
            onMouseDown={(event) => {
              // 阻止按钮抢焦点导致选区在 click 前被清空
              event.preventDefault();
            }}
            onClick={() => {
              onAddSnippet(selection.code, selection.startLine, selection.endLine);
              setSelection(null);
              document.getSelection()?.removeAllRanges();
            }}
          >
            加入对话（{selectionLineCount} 行 · L{selection.startLine}-{selection.endLine}）
          </button>
        ) : null}
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
export function InlineFileCards({ content, onOpenFile, basePath, onAddCodeSnippet }: {
  content: string;
  onOpenFile?: (path: string) => void;
  /** 当前项目根路径：用于把 Agent 回复中的相对路径（src/App.tsx）解析为可读取的绝对路径 */
  basePath?: string;
  /** 内嵌代码预览中选中片段 → 加入对话 */
  onAddCodeSnippet?: (snippet: CodeSnippet) => void;
}) {
  const rawPaths = useMemo(() => extractFilePaths(content), [content]);
  const [entries, setEntries] = useState<Map<string, { path: string; size: number | null; exists: boolean }> | null>(null);
  // 全部缺失时延迟复检（Agent 收尾 flush 可能晚于 done 事件），最多两次
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (rawPaths.length === 0) {
      setEntries(new Map());
      setAttempt(0);
      return;
    }
    setEntries(null);
    let cancelled = false;
    let retryTimer: number | undefined;
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
      const hasMissing = [...next.values()].some((entry) => !entry.exists);
      if (hasMissing && attempt < 2) {
        retryTimer = window.setTimeout(() => setAttempt((value) => value + 1), 1500 * (attempt + 1));
      }
    });
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [rawPaths, basePath, attempt]);

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
            onAddCodeSnippet={onAddCodeSnippet}
          />
        );
      })}
    </div>
  );
}

function InlineFileCard({ path, size, exists, onOpenFile, onAddCodeSnippet }: { path: string; size: number | null; exists: boolean; onOpenFile?: (path: string) => void; onAddCodeSnippet?: (snippet: CodeSnippet) => void }) {
  const [open, setOpen] = useState(false);
  const name = path.split("/").filter(Boolean).pop() || path;
  const icon = fileCardIcon({ fileName: name });
  const sizeLabel = formatFileSize(size);
  // html/pdf 这类整页内容内嵌展示又窄又挤：有右侧面板时隐藏内嵌入口，主点击直接在右侧打开（与 Excel 一致）
  const fullPageKind = ["html", "pdf"].includes(icon.kind);
  const allowInline = !onOpenFile || !fullPageKind;
  // 有右侧面板回调时主点击直接在面板打开（对齐文件产物的查看体验），否则内嵌展开
  const handleMainClick = () => {
    if (onOpenFile) onOpenFile(path);
    else setOpen(true);
  };
  if (open) {
    return <FilePreview path={path} compact onClose={() => setOpen(false)} onAddCodeSnippet={onAddCodeSnippet} />;
  }
  return (
    <FileCard
      title={name}
      icon={icon}
      meta={exists ? [icon.label, sizeLabel].filter(Boolean).join(" · ") : "文件已不存在"}
      state={exists ? "ready" : "missing"}
      actionText={onOpenFile ? "查看 →" : "预览"}
      onClick={exists ? handleMainClick : undefined}
      menuPath={exists ? path : null}
      disabledTitle={`${path}（文件已不存在）`}
      dock={exists && allowInline ? (
        <button type="button" className="file-card-dock" onClick={() => setOpen(true)} title="在对话内展开预览">
          内嵌预览
        </button>
      ) : null}
    />
  );
}
