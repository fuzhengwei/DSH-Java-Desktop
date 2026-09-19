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
};

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() || path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const EXT_META: Array<{ exts: string[]; meta: FileTypeMeta }> = [
  { exts: ["drawio"], meta: { Icon: DrawIoIcon, color: "#F08701", kindLabel: "Draw.io 图表" } },
  { exts: ["md", "markdown"], meta: { Icon: MarkdownIcon, color: "#4A6CF0", kindLabel: "Markdown" } },
  { exts: ["doc", "docx", "rtf", "odt", "wps"], meta: { Icon: WordDocIcon, color: "#2B579A", kindLabel: "Word 文档" } },
  { exts: ["xls", "xlsx", "xlsm", "csv", "ets"], meta: { Icon: ExcelSheetIcon, color: "#1E7145", kindLabel: "表格" } },
  { exts: ["pdf"], meta: { Icon: PdfFileIcon, color: "#E2574C", kindLabel: "PDF" } },
  { exts: ["ppt", "pptx", "dps"], meta: { Icon: FileIcon, color: "#D24726", kindLabel: "演示文稿" } },
  { exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "ico"], meta: { Icon: ImageFileIcon, color: "#8B5CF6", kindLabel: "图片" } },
  { exts: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "flv"], meta: { Icon: VideoFileIcon, color: "#DB2777", kindLabel: "视频" } },
  { exts: ["mp3", "wav", "aac", "flac", "ogg", "m4a"], meta: { Icon: AudioFileIcon, color: "#D97706", kindLabel: "音频" } },
  {
    exts: ["json", "js", "ts", "tsx", "jsx", "java", "py", "rs", "go", "c", "h", "cpp", "hpp", "sh", "html", "htm", "css", "scss", "xml", "yml", "yaml", "toml", "sql", "kt", "swift"],
    meta: { Icon: CodeFileIcon, color: "#0E9F8A", kindLabel: "代码" },
  },
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
