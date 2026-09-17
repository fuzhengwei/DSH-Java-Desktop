import { memo, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ServerRoomView } from "../lib/digital-human-client";
import { XIcon } from "./icons";

type Props = {
  artifact: { title: string; producerName?: string };
  room: ServerRoomView | null;
  onClose: () => void;
};

/** 产物右侧滑出预览（workbuddy 式侧滑面板） */
const ArtifactPreview = memo(function ArtifactPreview({ artifact, room, onClose }: Props) {
  // 从房间产物里按标题找完整内容
  const full = (room?.artifacts || []).find((a) => a.title === artifact.title);
  const content = (full as { content?: string } | undefined)?.content || "（暂无内容）";

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
              {artifact.producerName ? `${artifact.producerName} · ` : ""}markdown
            </div>
          </div>
        </div>
        <button type="button" className="artifact-preview-close" onClick={onClose} aria-label="关闭预览" title="关闭 (Esc)">
          <XIcon className="icon-14" />
        </button>
      </div>
      <div className="artifact-preview-body">
        <div className="artifact-preview-content markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </aside>
  );
});

export default ArtifactPreview;
