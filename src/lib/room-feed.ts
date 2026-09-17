import type { DigitalHuman } from "../types";
import type { RoomEvent } from "./digital-human-client";

/**
 * 房间事件流 → 对话条目（中间区域与右侧群聊视图共用同一份提炼逻辑）。
 *
 * chunk 归并、工具卡合并、计划/产物/交接提取都收敛在这里，
 * 任何叙事规则的调整（比如工具行折叠、交接文案）只需改这一处。
 */

export type PlanStep = { seq: number; title: string; assigneeName: string; state?: string };
export type HumanRef = { id: string; name: string; avatar: string; color: string };

export type FeedItem =
  | { kind: "user"; id: string; content: string; seq: number; occurredAt?: string }
  | { kind: "plan"; id: string; steps: PlanStep[]; seq: number }
  | { kind: "human-message"; id: string; human: HumanRef; content: string; streaming: boolean; taskId?: string; seq: number; occurredAt?: string }
  | { kind: "tool"; id: string; human: HumanRef; toolName: string; callSummary?: string; callArguments?: Record<string, unknown>; callId?: string; resultSummary?: string; status?: string; taskId?: string; seq: number }
  | { kind: "artifact"; id: string; artifactId: string; human: HumanRef; title: string; kindLabel: string; seq: number }
  | { kind: "handoff"; id: string; fromName: string; seq: number }
  | { kind: "approval"; id: string; human: HumanRef; taskId: string; summary: string; resolved?: string; seq: number }
  | { kind: "sys"; id: string; text: string; seq: number }
  | { kind: "error"; id: string; human: HumanRef; message: string; seq: number };

export type ToolRun = Extract<FeedItem, { kind: "tool" }>;

/** 展示层行：非 tool 条目原样，连续 tool 由 foldToolRuns 归并成 tool-group */
export type FeedRow = Exclude<FeedItem, ToolRun> | {
  kind: "tool-group";
  id: string;
  human: HumanRef;
  runs: ToolRun[];
  /** 组内最新事件 seq（用于排序与群聊聚焦定位） */
  seq: number;
};

/**
 * 把同一数字人的连续 tool 调用折叠成一组（中间区域展示用）。
 * 组内每条调用保留完整 callSummary/resultSummary，折叠只影响展示层级，不丢信息。
 */
export function foldToolRuns(feed: FeedItem[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let group: Extract<FeedRow, { kind: "tool-group" }> | null = null;
  const flush = () => {
    if (!group) return;
    rows.push(group);
    group = null;
  };
  for (const item of feed) {
    if (item.kind === "tool") {
      if (group && group.human.id === item.human.id) {
        group.runs.push(item);
        group.seq = item.seq;
      } else {
        flush();
        group = { kind: "tool-group", id: `tg_${item.id}`, human: item.human, runs: [item], seq: item.seq };
      }
      continue;
    }
    flush();
    rows.push(item);
  }
  flush();
  return rows;
}

export function humanRefOf(event: RoomEvent, humans: DigitalHuman[]): HumanRef {
  const fromDir = humans.find((h) => h.id === event.digitalHumanId);
  return {
    id: event.digitalHumanId || "",
    name: event.displayName || fromDir?.displayName || "数字人",
    avatar: event.avatarRef || fromDir?.avatarRef || "🤖",
    color: event.themeColor || fromDir?.themeColor || "#4a5568",
  };
}

export function buildRoomFeed(events: RoomEvent[], humans: DigitalHuman[]): FeedItem[] {
  const items: FeedItem[] = [];
  // 同一任务的消息归并：taskId → 消息条目（流式累加 + 最终定稿共用一条，杜绝重复）
  const messageByTask = new Map<string, Extract<FeedItem, { kind: "human-message" }>>();

  const upsertMessage = (
    taskId: string,
    human: HumanRef,
    text: string,
    seq: number,
    final: boolean,
    occurredAt?: string,
  ) => {
    if (!taskId) {
      // 无任务归属（如最终总结）：直接作为独立消息
      items.push({ kind: "human-message", id: `m_${seq}`, human, content: text, streaming: !final, seq, occurredAt });
      return;
    }
    let msg = messageByTask.get(taskId);
    if (!msg) {
      msg = { kind: "human-message", id: `msg_${taskId}`, human, content: "", streaming: true, taskId, seq, occurredAt };
      messageByTask.set(taskId, msg);
      items.push(msg);
    }
    if (final) {
      msg.content = text;       // 最终定稿：以完整内容覆盖
      msg.streaming = false;
    } else {
      msg.content += text;      // 流式：追加
      msg.streaming = true;
    }
    msg.seq = seq;
  };

  for (const event of events) {
    const taskId = event.taskId || "";
    switch (event.type) {
      case "MESSAGE_CREATED": {
        const role = String(event.payload.role || "");
        if (role === "user") {
          items.push({ kind: "user", id: event.id, content: String(event.payload.content || ""), seq: event.seq, occurredAt: event.occurredAt });
        } else {
          // 最终答复：与同任务流式消息合并为一条（覆盖内容、标记完成）
          upsertMessage(taskId, humanRefOf(event, humans), String(event.payload.content || ""), event.seq, true, event.occurredAt);
        }
        break;
      }
      case "MESSAGE_CHUNK": {
        upsertMessage(taskId, humanRefOf(event, humans), String(event.payload.text || ""), event.seq, false, event.occurredAt);
        break;
      }
      case "TOOL_CALL": {
        const rawArgs = event.payload.arguments ?? event.payload.args;
        items.push({
          kind: "tool",
          id: event.id,
          human: humanRefOf(event, humans),
          toolName: String(event.payload.toolName || "tool"),
          callSummary: String(event.payload.summary || ""),
          callArguments: rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
            ? rawArgs as Record<string, unknown>
            : undefined,
          callId: String(event.payload.callId || event.payload.toolCallId || event.id),
          status: "running",
          taskId,
          seq: event.seq,
        });
        break;
      }
      case "TOOL_RESULT": {
        const toolName = String(event.payload.toolName || "tool");
        const resultCallId = String(event.payload.callId || event.payload.toolCallId || "");
        const pending = items.filter(
          (item): item is Extract<FeedItem, { kind: "tool" }> =>
            item.kind === "tool" && item.status === "running",
        );
        // 配对优先级：callId 精确匹配 > 同任务同名 FIFO（倒序遍历取最早的未完成调用）
        const target = (resultCallId
          ? pending.find((item) => item.callId === resultCallId)
          : undefined)
          ?? [...pending].reverse().find(
            (item) => item.toolName === toolName && (!taskId || !item.taskId || item.taskId === taskId),
          );
        if (target) {
          // summary 可能为空串：用占位文案保证条目被视为"已完成"，避免永久转圈
          const summary = String(event.payload.summary || "").trim();
          target.resultSummary = summary || "（无输出）";
          target.status = String(event.payload.status || "success") === "error" ? "error" : "success";
        }
        break;
      }
      case "PLAN_CREATED": {
        const steps = Array.isArray(event.payload.steps) ? event.payload.steps as Array<Record<string, unknown>> : [];
        items.push({
          kind: "plan",
          id: event.id,
          steps: steps.map((step) => ({
            seq: Number(step.seq || 0),
            title: String(step.title || ""),
            assigneeName: String(step.assigneeName || step.assignTo || ""),
          })),
          seq: event.seq,
        });
        break;
      }
      case "TASK_STATE_CHANGED":
        break;
      case "ARTIFACT_CREATED": {
        items.push({
          kind: "artifact",
          id: event.id,
          artifactId: String(event.payload.artifactId || event.id),
          human: humanRefOf(event, humans),
          title: String(event.payload.title || "交付物"),
          kindLabel: String(event.payload.kind || "markdown"),
          seq: event.seq,
        });
        break;
      }
      case "HANDOFF_REQUESTED": {
        items.push({
          kind: "handoff",
          id: event.id,
          fromName: String(event.payload.fromName || event.displayName || ""),
          seq: event.seq,
        });
        break;
      }
      case "APPROVAL_REQUIRED": {
        items.push({
          kind: "approval",
          id: event.id,
          human: humanRefOf(event, humans),
          taskId: String(event.payload.taskId || event.taskId || ""),
          summary: String(event.payload.summary || ""),
          seq: event.seq,
        });
        break;
      }
      case "APPROVAL_RESOLVED": {
        const resolvedTaskId = String(event.payload.taskId || event.taskId || "");
        const verdict = String(event.payload.verdict || "");
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const item = items[i];
          if (item.kind === "approval" && item.taskId === resolvedTaskId && !item.resolved) {
            item.resolved = verdict;
            break;
          }
        }
        break;
      }
      case "ERROR": {
        items.push({
          kind: "error",
          id: event.id,
          human: humanRefOf(event, humans),
          message: String(event.payload.message || "执行失败"),
          seq: event.seq,
        });
        break;
      }
      case "PARTICIPANT_JOINED": {
        items.push({ kind: "sys", id: event.id, text: `「${event.payload.displayName || event.displayName || "数字人"}」加入了协作`, seq: event.seq });
        break;
      }
      case "TASK_RETRIED": {
        const human = humanRefOf(event, humans);
        items.push({ kind: "sys", id: event.id, text: `↻ ${human.name} 重新接手这个任务`, seq: event.seq });
        break;
      }
      case "TASK_REASSIGNED": {
        const human = humanRefOf(event, humans);
        items.push({ kind: "sys", id: event.id, text: `🔀 任务已转派给「${human.name}」`, seq: event.seq });
        break;
      }
      default:
        break;
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}

export function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
