import { memo, useEffect, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ServerRoomView } from "../lib/digital-human-client";
import { EChartBlock } from "./EChartBlock";
import { FilePreview, extractFilePaths } from "./FilePreview";
import { XIcon } from "./icons";

type Props = {
  artifact: { artifactId?: string; title: string; producerName?: string };
  room: ServerRoomView | null;
  onClose: () => void;
};

function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function artifactLabel(kind?: string): string {
  const normalized = (kind || "markdown").toLowerCase();
  if (["doc", "docx", "word"].includes(normalized)) return "Word";
  if (["sheet", "excel", "xlsx", "xls", "csv"].includes(normalized)) return "Excel";
  if (["chart", "echart", "echarts"].includes(normalized)) return "ECharts";
  if (["markdown", "md"].includes(normalized)) return "Markdown";
  return kind || "Markdown";
}

function kindFromPath(path: string): string | null {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (["doc", "docx"].includes(ext)) return "word";
  if (["xls", "xlsx", "csv", "tsv"].includes(ext)) return "excel";
  if (["md", "markdown"].includes(ext)) return "markdown";
  return null;
}

function parseEchartsOption(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("echartsOption")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { echartsOption?: unknown };
    return parsed.echartsOption ? JSON.stringify(parsed.echartsOption, null, 2) : null;
  } catch {
    return null;
  }
}

/** 产物右侧滑出预览（workbuddy 式侧滑面板） */
const ArtifactPreview = memo(function ArtifactPreview({ artifact, room, onClose }: Props) {
  // 从房间产物里按标题找完整内容
  const full = (room?.artifacts || []).find((a) => (
    artifact.artifactId ? a.artifactId === artifact.artifactId : a.title === artifact.title
  ));
  const kind = full?.kind || "markdown";
  const content = full?.content || "";
  const markdownContent = full?.previewMarkdown || full?.summary || (content.trim().startsWith("{") ? "" : content) || "（暂无内容）";
  const filePaths = useMemo(() => {
    const paths = [...(full?.filePath ? [full.filePath] : []), ...extractFilePaths(content)];
    return Array.from(new Set(paths));
  }, [content, full?.filePath]);
  const echartOption = useMemo(() => (
    full?.echartsOption ? JSON.stringify(full.echartsOption, null, 2) : parseEchartsOption(content)
  ), [content, full?.echartsOption]);
  const previewKind = echartOption ? "echarts" : kindFromPath(filePaths[0] || "") || kind;
  const markdownComponents = useMemo(() => ({
    pre: ({ children }: { children?: ReactNode }) => {
      const child = Array.isArray(children) ? children[0] : children;
      const className = (child as { props?: { className?: string } })?.props?.className || "";
      const match = /language-(\w+)/.exec(className);
      if (match && ["echart", "echarts"].includes(match[1])) {
        const code = extractText(child).trim();
        if (code.startsWith("{")) return <EChartBlock code={code} />;
      }
      return <pre>{children}</pre>;
    },
  }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="artifact-preview" role="complementary" aria-label="产物预览">
      <div className="artifact-preview-head">
        <div className="artifact-preview-title-wrap">
          <span className="artifact-preview-icon">📄</span>
          <div className="artifact-preview-heading">
            <div className="artifact-preview-title">{artifact.title}</div>
            <div className="artifact-preview-meta">
              {artifact.producerName ? `${artifact.producerName} · ` : ""}{artifactLabel(previewKind)}
            </div>
          </div>
        </div>
        <button type="button" className="artifact-preview-close" onClick={onClose} aria-label="关闭预览" title="关闭 (Esc)">
          <XIcon className="icon-14" />
        </button>
      </div>
      <div className="artifact-preview-body">
        <div className="artifact-preview-content markdown-body">
          {echartOption ? <EChartBlock code={echartOption} /> : null}
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{markdownContent}</ReactMarkdown>
          {filePaths.slice(0, 2).map((filePath) => (
            <FilePreview key={filePath} path={filePath} compact />
          ))}
        </div>
      </div>
    </aside>
  );
});

export default ArtifactPreview;
