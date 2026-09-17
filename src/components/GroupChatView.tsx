import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DigitalHuman } from "../types";
import type { RoomEvent } from "../lib/digital-human-client";
import { fetchRoomEvents, subscribeRoomEvents } from "../lib/digital-human-client";
import { buildRoomFeed, truncateText } from "../lib/room-feed";
import { buildChatFeed, toolDetailLine, toolSegmentLine } from "../lib/room-chat";
import type { ChatItem } from "../lib/room-chat";
import { HumanAvatar } from "./DigitalHumanCatalog";
import { ArrowRightIcon, ChevronIcon, UserIcon } from "./icons";

type Props = {
  port: number;
  roomId: string;
  humans: DigitalHuman[];
  /** 点击摘要条目：中间区域滚动定位到对应详情 */
  onFocusItem?: (seq: number) => void;
  /** 点击产物卡：右侧滑出预览 */
  onOpenArtifact?: (artifact: { artifactId?: string; title: string; producerName?: string }) => void;
};

/**
 * 右侧「群聊」视图：像人一样的对话流。
 *
 * 与中间区域（RoomCollaborationView，工作现场）的分工：
 * - 这里只说「人话」：想法、打算、分工交代、动手吆喝一声、干完招呼、交付递过去。
 * - 不出现任务状态机语言（N 项操作/执行中 x/y、接力链等）——实际干活的过程与明细全在中间区域。
 * - 点击任意条目 → onFocusItem(seq)，中间区域滚动定位到对应详情。
 * - 与中间区域共用同一事件源（fetchRoomEvents + SSE），两份数据天然一致。
 */
const GroupChatView = memo(function GroupChatView({ port, roomId, humans, onFocusItem, onOpenArtifact }: Props) {
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [loadError, setLoadError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    lastSeqRef.current = 0;
    void (async () => {
      try {
        const history = await fetchRoomEvents(port, roomId, 0);
        if (cancelled) return;
        setEvents(history);
        lastSeqRef.current = history.reduce((max, e) => Math.max(max, e.seq), 0);
      } catch (caught) {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => { cancelled = true; };
  }, [port, roomId]);

  useEffect(() => {
    // 订阅挂载时 afterSeq 仍是 0，服务端会先重推全量历史；
    // 与 fetchRoomEvents 拉到的历史按 seq 去重，避免整屏重复刷一遍
    const unsubscribe = subscribeRoomEvents(port, roomId, lastSeqRef.current, (event) => {
      lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
      setEvents((current) => (
        current.some((existing) => existing.seq === event.seq) ? current : [...current, event]
      ));
    });
    return unsubscribe;
  }, [port, roomId]);

  const feed = useMemo(() => buildRoomFeed(events, humans), [events, humans]);
  const chatItems = useMemo(() => buildChatFeed(feed), [feed]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chatItems.length]);

  const focus = (seq: number) => onFocusItem?.(seq);

  if (loadError) {
    return <div className="room-error">群聊加载失败：{loadError}</div>;
  }

  return (
    <div className="group-chat" aria-label="协作群聊">
      <div className="group-chat-scroll" ref={listRef}>
        {chatItems.length === 0 ? (
          <div className="group-chat-empty">还没有动静，发一条消息试试</div>
        ) : (
          chatItems.map((item) => {
            if (item.kind === "sys" || item.kind === "handoff") {
              const text = item.kind === "sys" ? item.text : item.text;
              return <div key={item.id} className="gc-sys">{text}</div>;
            }
            if (item.kind === "user") {
              return (
                <div key={item.id} className="gc-row gc-row-user">
                  <div className="gc-bubble gc-bubble-user" title={item.content}>
                    {truncateText(item.content, 80)}
                  </div>
                  <span className="gc-avatar gc-avatar-user" aria-label="我"><UserIcon className="icon-14" /></span>
                </div>
              );
            }
            if (item.kind === "plan") {
              // 分工 → 调度者的一句「我打算这样分工」，点开看中间区域的完整计划
              const assignees = [...new Set(item.steps.map((s) => s.assigneeName || "待分配"))];
              return (
                <div key={item.id} className="gc-row">
                  <span className="gc-avatar gc-avatar-planner">✦</span>
                  <div className="gc-main">
                    <div className="gc-name">协作调度</div>
                    <button type="button" className="gc-bubble gc-clickable" onClick={() => focus(item.seq)} title="在中间区域查看计划详情">
                      我想了想，这件事分 {item.steps.length} 步走：{item.steps.map((s) => s.title).map((t) => truncateText(t, 10)).join("、")}。
                      {assignees.length ? <>让 {assignees.map((n) => `@${n}`).join("、")} 分别来。</> : null}
                      点开可以看完整安排。
                    </button>
                  </div>
                </div>
              );
            }
            if (item.kind === "say") {
              return (
                <div key={item.id} className="gc-row">
                  <ChatAvatar human={item.human} />
                  <div className="gc-main">
                    <div className="gc-name">{item.human.name}</div>
                    <button type="button" className="gc-bubble gc-clickable" onClick={() => focus(item.seq)} title="在中间区域查看全文">
                      {item.text}
                    </button>
                  </div>
                </div>
              );
            }
            if (item.kind === "tools") {
              return <ToolSegment key={item.id} item={item} onFocus={focus} />;
            }
            if (item.kind === "artifact") {
              // 交付 → 一句「整理好了」+ 可点的产物卡，点击右侧滑出预览
              return (
                <div key={item.id} className="gc-row">
                  <ChatAvatar human={item.human} />
                  <div className="gc-main">
                    <div className="gc-name">{item.human.name}</div>
                    <button
                      type="button"
                      className="gc-bubble gc-artifact gc-clickable"
                      onClick={() => onOpenArtifact?.({ artifactId: item.artifactId, title: item.title, producerName: item.human.name })}
                      title="查看交付物"
                    >
                      <span className="gc-artifact-line">整理好了，你看看 👇</span>
                      <span className="gc-artifact-card">
                        <span className="gc-artifact-icon">📄</span>
                        <span className="gc-artifact-text">
                          <span className="gc-artifact-title">{truncateText(item.title, 20)}</span>
                          <span className="gc-artifact-meta">{item.kindLabel}</span>
                        </span>
                        <ArrowRightIcon className="icon-12" />
                      </span>
                    </button>
                  </div>
                </div>
              );
            }
            if (item.kind === "approval") {
              // 审批 → 「我想动一下，等你点头」，像人征求同意
              return (
                <div key={item.id} className="gc-row">
                  <ChatAvatar human={item.human} />
                  <div className="gc-main">
                    <div className="gc-name">{item.human.name}</div>
                    <button type="button" className="gc-bubble gc-approval gc-clickable" onClick={() => focus(item.seq)} title="在中间区域处理审批">
                      我想动一下：{item.summary}
                      {item.resolved ? (
                        <span className={`gc-tool-state ${item.resolved === "ALLOW" ? "done" : "denied"}`}>
                          {item.resolved === "ALLOW" ? "你同意了" : "你拦下了"}
                        </span>
                      ) : (
                        <span className="gc-tool-state waiting">等你点头</span>
                      )}
                    </button>
                  </div>
                </div>
              );
            }
            if (item.kind === "error") {
              return (
                <div key={item.id} className="gc-row">
                  <ChatAvatar human={item.human} />
                  <div className="gc-main">
                    <div className="gc-name">{item.human.name}</div>
                    <button type="button" className="gc-bubble gc-error gc-clickable" onClick={() => focus(item.seq)} title="在中间区域查看错误">
                      卡住了：{item.message}
                    </button>
                  </div>
                </div>
              );
            }
            return null;
          })
        )}
      </div>
    </div>
  );
});

function ChatAvatar({ human }: { human: { name: string; avatar: string; color: string } }) {
  return (
    <HumanAvatar
      human={{ avatarRef: human.avatar, themeColor: human.color, displayName: human.name }}
      size={34}
      square
    />
  );
}

type ToolSegmentItem = Extract<ChatItem, { kind: "tools" }>;

/**
 * 动手段：一句口语化的台词（「我去弄一下…」「刚动手忙了会儿…」），
 * 点击展开明细（做了什么），明细点击再跳中间区域看命令与输出。
 * 聊天流里不出现「N 项操作 / 执行中 x/y」这类任务状态机语言。
 */
function ToolSegment({ item, onFocus }: { item: ToolSegmentItem; onFocus: (seq: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="gc-row">
      <ChatAvatar human={item.human} />
      <div className="gc-main">
        <div className="gc-name">{item.human.name}</div>
        <div className={`gc-tools${expanded ? " expanded" : ""}`}>
          <button
            type="button"
            className="gc-tools-head"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            title={expanded ? "收起明细" : "展开我刚才做了什么"}
          >
            <span className="gc-tools-line">
              {toolSegmentLine(item)}
              {item.running ? <span className="gc-dot" aria-hidden /> : null}
            </span>
            <ChevronIcon className="icon-12 gc-tools-chevron" />
          </button>
          {expanded ? (
            <div className="gc-tools-list">
              {item.tools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  className="gc-tools-row"
                  onClick={() => onFocus(tool.seq)}
                  title="在中间区域查看详情"
                >
                  <span className="gc-tools-row-name">{toolDetailLine(tool)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default GroupChatView;
