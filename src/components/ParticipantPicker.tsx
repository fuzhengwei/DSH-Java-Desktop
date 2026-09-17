import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DigitalHuman, RoomProjection } from "../types";
import { HumanAvatar, HEALTH_TEXT, healthDotClass, PRESENCE_TEXT } from "./DigitalHumanCatalog";
import { PlusIcon, SearchIcon, XIcon } from "./icons";

/** 房间成员栏：对话顶部展示已加入的数字人 */
export const MemberBar = memo(function MemberBar({
  room,
  humans,
  onInvite,
  onRemove,
}: {
  room: RoomProjection | null;
  humans: DigitalHuman[];
  onInvite: () => void;
  onRemove: (digitalHumanId: string) => void;
}) {
  const humanById = new Map(humans.map((human) => [human.id, human]));
  const participants = (room?.participants || [])
    .map((p) => ({ p, human: humanById.get(p.digitalHumanId) }))
    .filter((entry): entry is { p: RoomProjection["participants"][number]; human: DigitalHuman } => Boolean(entry.human));

  if (participants.length === 0 && humans.length === 0) return null;

  return (
    <div className="member-bar" aria-label="协作成员">
      {participants.map(({ p, human }) => (
        <span key={p.digitalHumanId} className="member-chip" title={`${human.purpose}\n${PRESENCE_TEXT[p.presence]}`}>
          <HumanAvatar human={human} size={24} presence={p.presence} />
          <span className="member-chip-name">{human.displayName}</span>
          <span className={`member-chip-state presence-text-${p.presence}`}>{PRESENCE_TEXT[p.presence]}</span>
          <button
            type="button"
            className="member-chip-remove"
            aria-label={`把 ${human.displayName} 移出协作`}
            title={`把 ${human.displayName} 移出协作`}
            onClick={() => onRemove(p.digitalHumanId)}
          >
            <XIcon className="icon-10" />
          </button>
        </span>
      ))}
      <button type="button" className="member-add" onClick={onInvite} title="加入数字人" aria-label="加入数字人">
        <PlusIcon className="icon-14" />
      </button>
    </div>
  );
});

/** 数字人选择弹层：搜索 + 加入 */
export const ParticipantPicker = memo(function ParticipantPicker({
  open,
  humans,
  room,
  onClose,
  onJoin,
  onOpenCatalog,
}: {
  open: boolean;
  humans: DigitalHuman[];
  room: RoomProjection | null;
  onClose: () => void;
  onJoin: (human: DigitalHuman) => void;
  onOpenCatalog: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const joinedIds = useMemo(
    () => new Set((room?.participants || []).map((p) => p.digitalHumanId)),
    [room],
  );

  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return humans;
    return humans.filter((human) => (
      human.displayName.toLowerCase().includes(keyword)
      || human.purpose.toLowerCase().includes(keyword)
      || human.roleTags.some((tag) => tag.toLowerCase().includes(keyword))
    ));
  }, [humans, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="picker" role="dialog" aria-label="加入数字人">
        <div className="picker-head">
          <SearchIcon className="icon-14" />
          <input
            ref={inputRef}
            className="picker-input"
            placeholder="搜索名称 / 用途 / 能力…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(results.length - 1, index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const target = results[activeIndex];
                if (target && !joinedIds.has(target.id)) onJoin(target);
              } else if (event.key === "Escape") {
                onClose();
              }
            }}
          />
        </div>
        <div className="picker-list" role="listbox">
          {results.length === 0 ? (
            <div className="picker-empty">
              {humans.length === 0 ? "还没有数字人" : "没有匹配的数字人"}
            </div>
          ) : (
            results.map((human, index) => {
              const joined = joinedIds.has(human.id);
              const offline = human.endpoint.healthState === "offline";
              return (
                <button
                  key={human.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`picker-item${index === activeIndex ? " active" : ""}`}
                  disabled={joined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => onJoin(human)}
                >
                  <HumanAvatar human={human} size={32} health={human.endpoint.healthState} />
                  <span className="picker-item-main">
                    <span className="picker-item-name">
                      {human.displayName}
                      <span className="dh-src">{human.endpoint.type === "local-dsh" ? "本地" : "远端"}</span>
                      {offline ? <span className="dh-src warn">离线</span> : null}
                    </span>
                    <span className="picker-item-purpose">{human.purpose}</span>
                  </span>
                  <span className="picker-item-action">
                    {joined ? "已加入" : (
                      <>
                        <span className={`dot ${healthDotClass(human.endpoint.healthState)}`} />
                        {HEALTH_TEXT[human.endpoint.healthState || "unknown"]}
                      </>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="picker-foot">
          <button type="button" className="collab-link" onClick={onOpenCatalog}>
            ＋ 添加新数字人
          </button>
          <span className="picker-foot-hint">↑↓ 选择 · Enter 加入 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
});
