import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DigitalHuman } from "../types";
import { HumanAvatar } from "./DigitalHumanCatalog";
import {
  BroomIcon,
  EditIcon,
  FolderPlusIcon,
  MoreVerticalIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  UsersIcon,
} from "./icons";

/** 堆叠头像最多展示几个，其余收进 +N */
const STACK_LIMIT = 2;

/** 项目行内的数字人缩略头像堆叠 + 数量 */
export function ProjectHumanStack({
  humans,
}: {
  humans: DigitalHuman[];
}) {
  if (humans.length === 0) return null;
  const shown = humans.slice(0, STACK_LIMIT);
  const rest = humans.length - shown.length;
  const names = humans.map((human) => human.displayName).join("、");
  return (
    <span className="project-humans" aria-label={`${humans.length} 个数字人`} title={`${humans.length} 个数字人：${names}`}>
      {shown.map((human) => (
        <span key={human.id} className="project-humans-item">
          <HumanAvatar human={human} size={18} />
        </span>
      ))}
      {rest > 0 ? <span className="project-humans-more">+{rest}</span> : null}
    </span>
  );
}

type MenuProps = {
  onNewConversation: () => void;
  onAddLocalProject: () => void;
  onAddDigitalHuman?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** 清空非今日对话（无可清空内容时不传，菜单项隐藏） */
  onClearOldSessions?: () => void;
  /** 清空全部对话（无对话时不传，菜单项隐藏） */
  onClearAllSessions?: () => void;
  /** 外部需要把 ⋮ 按钮当作其它浮层锚点时使用（如数字人配置浮层） */
  triggerRef?: (node: HTMLButtonElement | null) => void;
};

/** 项目行尾「竖三点」浮层菜单：集中收纳编辑/删除等操作，行内不再堆图标 */
export const ProjectRowMenu = memo(function ProjectRowMenu({
  onNewConversation,
  onAddLocalProject,
  onAddDigitalHuman,
  onEdit,
  onDelete,
  onClearOldSessions,
  onClearAllSessions,
  triggerRef,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
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

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <span className="project-menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`icon-button project-menu-trigger${open ? " open" : ""}`}
        title="项目操作"
        aria-label="项目操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreVerticalIcon className="icon-14" />
      </button>
      {open ? (
        <div className="project-menu-pop" role="menu">
          <button type="button" role="menuitem" className="project-menu-item" onClick={() => run(onNewConversation)}>
            <PlusIcon className="icon-14" />
            新建对话
          </button>
          <button type="button" role="menuitem" className="project-menu-item" onClick={() => run(onAddLocalProject)}>
            <FolderPlusIcon className="icon-14" />
            添加工程
          </button>
          {onAddDigitalHuman ? (
            <button type="button" role="menuitem" className="project-menu-item" onClick={() => run(onAddDigitalHuman)}>
              <UsersIcon className="icon-14" />
              添加数字人
            </button>
          ) : null}
          <button type="button" role="menuitem" className="project-menu-item" onClick={() => run(onEdit)}>
            <EditIcon className="icon-14" />
            编辑项目
          </button>
          {(onClearOldSessions || onClearAllSessions) ? (
            <>
              <div className="project-menu-divider" aria-hidden="true" />
              {onClearOldSessions ? (
                <button type="button" role="menuitem" className="project-menu-item" onClick={() => run(onClearOldSessions)}>
                  <BroomIcon className="icon-14" />
                  清空非今日对话
                </button>
              ) : null}
              {onClearAllSessions ? (
                <button type="button" role="menuitem" className="project-menu-item danger" onClick={() => run(onClearAllSessions)}>
                  <TrashIcon className="icon-14" />
                  清空全部对话
                </button>
              ) : null}
            </>
          ) : null}
          <div className="project-menu-divider" aria-hidden="true" />
          <button type="button" role="menuitem" className="project-menu-item danger" onClick={() => run(onDelete)}>
            <TrashIcon className="icon-14" />
            删除项目
          </button>
        </div>
      ) : null}
    </span>
  );
});

type AssignPopoverProps = {
  anchorRef: { current: HTMLElement | null };
  open: boolean;
  /** 锚点底部相对侧边栏的纵向偏移（固定定位用） */
  anchorTop: number;
  humans: DigitalHuman[];
  /** 已归属当前项目的数字人 id 集合 */
  checkedIds: Set<string>;
  onAssign: (humanId: string, checked: boolean) => void;
  onCreateNew?: () => void;
  onClose: () => void;
};

/**
 * 项目数字人配置浮层：列出全部现有数字人，
 * 勾选 = 归属到该项目，取消勾选 = 移出项目（变为全局）。
 */
export const ProjectHumanAssignPopover = memo(function ProjectHumanAssignPopover({
  anchorRef,
  open,
  anchorTop,
  humans,
  checkedIds,
  onAssign,
  onCreateNew,
  onClose,
}: AssignPopoverProps) {
  const [query, setQuery] = useState("");
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        popRef.current && !popRef.current.contains(target)
        && anchorRef.current && !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef, onClose]);

  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return humans;
    return humans.filter((human) => (
      human.displayName.toLowerCase().includes(keyword)
      || human.purpose.toLowerCase().includes(keyword)
      || human.roleTags.some((tag) => tag.toLowerCase().includes(keyword))
    ));
  }, [humans, query]);

  if (!open) return null;

  return (
    <div
      className="project-human-pop"
      ref={popRef}
      role="dialog"
      aria-label="配置项目数字人"
      style={{ top: anchorTop }}
    >
      <div className="project-human-pop-head">
        <SearchIcon className="icon-14" />
        <input
          className="project-human-pop-input"
          placeholder="搜索数字人…"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="project-human-pop-list">
        {results.length === 0 ? (
          <div className="project-human-pop-empty">
            {humans.length === 0 ? "还没有数字人，可在下方新建" : "没有匹配的数字人"}
          </div>
        ) : (
          results.map((human) => (
            <label key={human.id} className="project-human-pop-item">
              <input
                type="checkbox"
                checked={checkedIds.has(human.id)}
                onChange={(event) => onAssign(human.id, event.target.checked)}
              />
              <HumanAvatar human={human} size={26} health={human.endpoint.healthState} />
              <span className="project-human-pop-main">
                <span className="project-human-pop-name">
                  {human.displayName}
                  <span className="dh-src">{human.endpoint.type === "local-dsh" ? "本地" : "远端"}</span>
                </span>
                <span className="project-human-pop-purpose">{human.purpose}</span>
              </span>
            </label>
          ))
        )}
      </div>
      {onCreateNew ? (
        <button type="button" className="project-human-pop-create" onClick={onCreateNew}>
          <PlusIcon className="icon-14" />
          新建数字人并归属到该项目
        </button>
      ) : null}
    </div>
  );
});
