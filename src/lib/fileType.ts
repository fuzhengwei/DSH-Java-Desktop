import type { ComponentType } from "react";
import {
  ArchiveFileIcon,
  AudioFileIcon,
  CodeFileIcon,
  DrawIoIcon,
  ExcelSheetIcon,
  FileIcon,
  FolderIcon,
  ImageFileIcon,
  MarkdownIcon,
  PdfFileIcon,
  VideoFileIcon,
  WordDocIcon,
} from "../components/icons";

/**
 * 文件产物标签的类型识别：按扩展名映射图标 / 颜色 / 类别文案。
 * 目录与失效路径由 local_path_kinds 命令在运行时判定后覆盖。
 */

export type LocalPathKind = "file" | "dir" | "missing";

export type FileTypeMeta = {
  Icon: ComponentType<{ className?: string }>;
  color: string;
  kindLabel: string;
  /** 目录树等紧凑场景的短徽标（如 J / TS / PY）；缺省回退 Icon */
  badge?: string;
};

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() || path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 代码类语言徽标配色（对齐各语言社区惯用色） */
const CODE_META = (badge: string, color: string, kindLabel: string): FileTypeMeta => ({
  Icon: CodeFileIcon, color, kindLabel, badge,
});

const EXT_META: Array<{ exts: string[]; meta: FileTypeMeta }> = [
  { exts: ["drawio"], meta: { Icon: DrawIoIcon, color: "#F08701", kindLabel: "Draw.io 图表" } },
  { exts: ["md", "markdown"], meta: { Icon: MarkdownIcon, color: "#4A6CF0", kindLabel: "Markdown", badge: "MD" } },
  { exts: ["doc", "docx", "rtf", "odt", "wps"], meta: { Icon: WordDocIcon, color: "#2B579A", kindLabel: "Word 文档" } },
  { exts: ["xls", "xlsx", "xlsm", "csv", "ets"], meta: { Icon: ExcelSheetIcon, color: "#1E7145", kindLabel: "表格" } },
  { exts: ["pdf"], meta: { Icon: PdfFileIcon, color: "#E2574C", kindLabel: "PDF" } },
  { exts: ["ppt", "pptx", "dps"], meta: { Icon: FileIcon, color: "#D24726", kindLabel: "演示文稿" } },
  { exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "ico"], meta: { Icon: ImageFileIcon, color: "#8B5CF6", kindLabel: "图片" } },
  { exts: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "flv"], meta: { Icon: VideoFileIcon, color: "#DB2777", kindLabel: "视频" } },
  { exts: ["mp3", "wav", "aac", "flac", "ogg", "m4a"], meta: { Icon: AudioFileIcon, color: "#D97706", kindLabel: "音频" } },
  // 代码类：按语言细分徽标，一眼区分文件类型
  { exts: ["java"], meta: CODE_META("J", "#E76F00", "Java") },
  { exts: ["kt", "kts"], meta: CODE_META("K", "#8B5CF6", "Kotlin") },
  { exts: ["ts", "tsx"], meta: CODE_META("TS", "#3178C6", "TypeScript") },
  { exts: ["js", "jsx", "mjs", "cjs"], meta: CODE_META("JS", "#B7950B", "JavaScript") },
  { exts: ["json"], meta: CODE_META("{}", "#8A8F98", "JSON") },
  { exts: ["py"], meta: CODE_META("PY", "#3572A5", "Python") },
  { exts: ["go"], meta: CODE_META("GO", "#00A3C4", "Go") },
  { exts: ["rs"], meta: CODE_META("RS", "#CE4A2B", "Rust") },
  { exts: ["c", "h"], meta: CODE_META("C", "#5C6BC0", "C") },
  { exts: ["cpp", "hpp", "cc", "hh"], meta: CODE_META("C++", "#F34B7D", "C++") },
  { exts: ["cs"], meta: CODE_META("C#", "#68217A", "C#") },
  { exts: ["rb"], meta: CODE_META("RB", "#CC342D", "Ruby") },
  { exts: ["php"], meta: CODE_META("PHP", "#777BB4", "PHP") },
  { exts: ["swift"], meta: CODE_META("SW", "#F05138", "Swift") },
  { exts: ["sh", "bash", "zsh"], meta: CODE_META("$", "#5B9E3F", "Shell") },
  { exts: ["html", "htm"], meta: CODE_META("<>", "#E34C26", "HTML") },
  { exts: ["css", "scss", "less"], meta: CODE_META("#", "#563D7C", "样式") },
  { exts: ["xml"], meta: CODE_META("<>", "#0060AC", "XML") },
  { exts: ["yml", "yaml"], meta: CODE_META("Y", "#6B7280", "YAML") },
  { exts: ["toml", "ini", "cfg", "conf", "properties"], meta: CODE_META("CFG", "#9C6123", "配置") },
  { exts: ["sql"], meta: CODE_META("SQL", "#D28445", "SQL") },
  { exts: ["gradle"], meta: CODE_META("G", "#02303A", "Gradle") },
  { exts: ["vue"], meta: CODE_META("V", "#42B883", "Vue") },
  { exts: ["jar", "zip", "tar", "gz", "tgz", "rar", "7z", "dmg"], meta: { Icon: ArchiveFileIcon, color: "#B45309", kindLabel: "压缩包" } },
];

const DIR_META: FileTypeMeta = { Icon: FolderIcon, color: "#3E8EED", kindLabel: "文件夹" };
const FILE_META: FileTypeMeta = { Icon: FileIcon, color: "#8A8F98", kindLabel: "文件" };

/** 按扩展名返回文件类型元信息；kind 为 dir 时返回文件夹样式。 */
export function fileTypeMeta(path: string, kind?: LocalPathKind): FileTypeMeta {
  if (kind === "dir") return DIR_META;
  const ext = extensionOf(path);
  for (const entry of EXT_META) {
    if (entry.exts.includes(ext)) return entry.meta;
  }
  return FILE_META;
}

/** 取路径最后一段作为展示名。 */
export function pathBasename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || path;
}

/** 取除最后一段外的目录部分（正斜杠展示）。 */
export function pathDirname(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length > 1 ? segments.slice(0, -1).join("/") : "";
}
