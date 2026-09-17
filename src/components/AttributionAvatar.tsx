import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DigitalHuman } from "../types";
import { HEALTH_TEXT, healthDotClass } from "./DigitalHumanCatalog";

type Props = {
  name: string;
  avatar: string;
  color: string;
  /** 执行中/输出中：头像带呼吸动效 */
  live?: boolean;
  /** 完整的数字人档案；有则点击弹出角色信息卡，缺省时展示归属快照 */
  human?: DigitalHuman | null;
  /** 归属时的任务描述（来自消息归属快照） */
  taskLabel?: string | null;
};

const APPROVAL_TEXT: Record<DigitalHuman["approvalPolicy"], string> = {
  AUTO_ALLOW: "全部自动",
  WRITE_REQUIRES_APPROVAL: "写操作需审批",
  ALWAYS_CONFIRM: "逐次确认",
};

/**
 * 归属小头像：内嵌在消息/执行行内，不占单独一行。
 * 点击弹出角色信息卡（名称、用途、能力标签、来源、健康、审批策略）。
 */
export const AttributionAvatar = memo(function AttributionAvatar({ name, avatar, color, live, human, taskLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || cardRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openCard = (event: React.MouseEvent) => {
    // 位于 <summary> 内时阻止触发展开/折叠
    event.preventDefault();
    event.stopPropagation();
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 264;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      // 默认在锚点下方；空间不足时翻转到上方
      const estimatedHeight = 210;
      const below = rect.bottom + 8;
      const top = below + estimatedHeight > window.innerHeight
        ? Math.max(8, rect.top - estimatedHeight - 8)
        : below;
      setPos({ left, top });
    }
    setOpen((value) => !value);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`msg-attribution-inline${live ? " live" : ""}${open ? " open" : ""}`}
        title={`${name} · 点击查看角色信息`}
        aria-label={`${name}，点击查看角色信息`}
        onClick={openCard}
      >
        <span className="msg-attribution-avatar" style={{ background: human?.themeColor || color }}>
          {human?.avatarRef || avatar}
        </span>
      </button>
      {open && pos ? createPortal(
        <div className="attribution-card" ref={cardRef} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label={`${name} 的角色信息`}>
          <div className="attribution-card-head">
            <span className="attribution-card-avatar" style={{ background: human?.themeColor || color }}>
              {human?.avatarRef || avatar}
            </span>
            <div className="attribution-card-title">
              <b>{human?.displayName || name}</b>
              <span className="attribution-card-sub">
                {human ? (human.endpoint.type === "local-dsh" ? "本地 DSH" : "远端 DSH") : "数字人"}
                {human?.endpoint.healthState ? (
                  <>
                    {" · "}
                    <span className={`dot ${healthDotClass(human.endpoint.healthState)}`} />
                    {HEALTH_TEXT[human.endpoint.healthState]}
                  </>
                ) : null}
              </span>
            </div>
          </div>
          {human?.purpose ? <p className="attribution-card-purpose">{human.purpose}</p> : null}
          {!human?.purpose && taskLabel ? <p className="attribution-card-purpose">{taskLabel}</p> : null}
          {human && human.roleTags.length > 0 ? (
            <div className="attribution-card-tags">
              {human.roleTags.map((tag) => <span key={tag} className="dh-tag">{tag}</span>)}
            </div>
          ) : null}
          {human ? (
            <div className="attribution-card-meta">
              <span>审批 {APPROVAL_TEXT[human.approvalPolicy]}</span>
              <span>并发 {human.concurrencyLimit}</span>
            </div>
          ) : (
            <p className="attribution-card-purpose dim">
              数字人档案暂不可用（可能已被删除），当前展示消息归属信息
            </p>
          )}
        </div>,
        document.body,
      ) : null}
    </>
  );
});
