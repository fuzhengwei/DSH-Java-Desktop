import type { ServerRoomView } from "./digital-human-client";
import type { FeedItem } from "./room-feed";
import { truncateText } from "./room-feed";

/**
 * 群聊视图提炼：把完整事件流折叠成「微信群」式的一屏对话。
 *
 * 原则（右侧 = 人，中间 = 现场）：
 * - 这里只保留「像人说话」的内容：想法、打算、分工交代、干完招呼一声、交付递过去。
 * - 工具调用、任务状态、接力链等「实际干活」的过程信息一律不进聊天流，
 *   最多压缩成一句口语化的「我去看看…/ 刚才动手忙了会儿」，明细在中间区域看。
 * - 任何一行都不长：点击条目 → 中间区域展开全文。
 */

export type ChatHuman = { id: string; name: string; avatar: string; color: string };

export type ChatItem =
  | { kind: "sys"; id: string; text: string; seq: number }
  | { kind: "user"; id: string; content: string; seq: number }
  /** 分工：渲染成调度者的一句「我想这样分工…」 */
  | { kind: "plan"; id: string; steps: Array<{ seq: number; title: string; assigneeName: string }>; seq: number }
  | { kind: "say"; id: string; human: ChatHuman; text: string; seq: number }
  /**
   * 动手过程：同一数字人的连续工具操作折叠成一句口语（「我去看看…」「忙完了」），
   * 点开展开明细，明细点击跳中间区域。聊天流里不出现任务状态机语言。
   */
  | { kind: "tools"; id: string; human: ChatHuman; tools: Array<{ id: string; toolName: string; callSummary: string; done: boolean; seq: number }>; running: boolean; seq: number }
  /** 交付：一句「整理好了」+ 可点的产物名 */
  | { kind: "artifact"; id: string; human: ChatHuman; title: string; kindLabel: string; seq: number }
  /** 交接：一句「我做完了，交给下一位」 */
  | { kind: "handoff"; id: string; text: string; fromName: string; seq: number }
  | { kind: "approval"; id: string; human: ChatHuman; summary: string; resolved?: string; seq: number }
  | { kind: "error"; id: string; human: ChatHuman; message: string; seq: number };

export type RelayTask = {
  taskId: string;
  title: string;
  state: string;
  assigneeName?: string;
  assigneeAvatar?: string;
  assigneeColor?: string;
  /** 下一个接棒者（由 DAG dependsOn 反推） */
  nextNames: string[];
};

const TASK_STATE_TEXT: Record<string, string> = {
  READY: "待开始",
  ASSIGNED: "已派单",
  RUNNING: "进行中",
  DONE: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};

export function taskStateText(state: string): string {
  return TASK_STATE_TEXT[state] || state;
}

/**
 * 从 feed 提炼群聊条目。
 *
 * 只保留「人味」内容：发言、分工打算、动手过程（口语化折叠）、交付、交接招呼。
 * 工具明细 / 任务状态机语言不进聊天流——那是中间区域（工作现场）的事。
 */
export function buildChatFeed(feed: FeedItem[]): ChatItem[] {
  const items: ChatItem[] = [];
  /** 当前折叠中的工具段（同一数字人连续 tool 归并到这里） */
  let pendingTools: Extract<ChatItem, { kind: "tools" }> | null = null;
  const flushTools = () => {
    if (!pendingTools) return;
    pendingTools.running = pendingTools.tools.some((t) => !t.done);
    items.push(pendingTools);
    pendingTools = null;
  };

  for (const item of feed) {
    switch (item.kind) {
      case "tool": {
        if (pendingTools && pendingTools.human.id === item.human.id) {
          pendingTools.tools.push({ id: item.id, toolName: item.toolName, callSummary: item.callSummary || "", done: Boolean(item.resultSummary), seq: item.seq });
          pendingTools.seq = item.seq;
        } else {
          flushTools();
          pendingTools = {
            kind: "tools",
            id: `tools_${item.id}`,
            human: item.human,
            tools: [{ id: item.id, toolName: item.toolName, callSummary: item.callSummary || "", done: Boolean(item.resultSummary), seq: item.seq }],
            running: !item.resultSummary,
            seq: item.seq,
          };
        }
        break;
      }
      case "user":
        flushTools();
        items.push({ kind: "user", id: item.id, content: item.content, seq: item.seq });
        break;
      case "sys":
        flushTools();
        items.push({ kind: "sys", id: item.id, text: item.text, seq: item.seq });
        break;
      case "plan":
        flushTools();
        items.push({
          kind: "plan",
          id: item.id,
          steps: item.steps.map((s) => ({ seq: s.seq, title: s.title, assigneeName: s.assigneeName })),
          seq: item.seq,
        });
        break;
      case "human-message": {
        flushTools();
        const firstLine = (item.content || "").split(/\r?\n/).find((line) => line.trim()) || "…";
        items.push({
          kind: "say",
          id: item.id,
          human: item.human,
          text: truncateText(firstLine.trim(), 60),
          seq: item.seq,
        });
        break;
      }
      case "artifact":
        flushTools();
        items.push({
          kind: "artifact",
          id: item.id,
          human: item.human,
          title: item.title,
          kindLabel: item.kindLabel,
          seq: item.seq,
        });
        break;
      case "handoff":
        flushTools();
        items.push({
          kind: "handoff",
          id: item.id,
          text: `我做完了，接下来交给 @${item.fromName} 接手`,
          fromName: item.fromName,
          seq: item.seq,
        });
        break;
      case "approval":
        flushTools();
        items.push({
          kind: "approval",
          id: item.id,
          human: item.human,
          summary: truncateText(item.summary || "想动一下，等你点头", 48),
          resolved: item.resolved,
          seq: item.seq,
        });
        break;
      case "error":
        flushTools();
        items.push({
          kind: "error",
          id: item.id,
          human: item.human,
          message: truncateText(item.message, 48),
          seq: item.seq,
        });
        break;
      default:
        break;
    }
  }
  flushTools();
  return items.sort((a, b) => a.seq - b.seq);
}

/**
 * 工具名 → 口语化动词短语（台词里不出现工具名/JSON/状态机语言）。
 */
const TOOL_VERB: Record<string, string> = {
  shell_execute: "跑了条命令",
  execute_command: "跑了条命令",
  run_command: "跑了条命令",
  fs_read: "看了眼文件",
  read_file: "看了眼文件",
  fs_write: "改了改文件",
  write_file: "改了改文件",
  fs_edit: "改了改文件",
  edit_file: "改了改文件",
  create_file: "写了个文件",
  mkdir: "建了目录",
  list_dir: "翻了翻目录",
  search: "查了些资料",
  web_search: "查了些资料",
  grep: "搜了搜内容",
};

/**
 * callSummary → 一句干净的人话。
 * callSummary 可能是原始 JSON（{"toolName":"shell_execute",...}）或纯文本，
 * 这里统一提炼：JSON 先解析/正则抽 toolName+summary，再映射成动词短语。
 */
function gistOfSummary(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.startsWith("{")) {
    let toolName = "";
    let summary = "";
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      toolName = String(obj.toolName || obj.name || "");
      summary = String(obj.summary || obj.description || "");
    } catch {
      // 可能是被截断的 JSON：退化为正则抽取
      toolName = (text.match(/"toolName"\s*:\s*"([^"]+)"/) || [])[1] || "";
      summary = (text.match(/"summary"\s*:\s*"([^"]*)"/) || [])[1] || "";
    }
    const verb = TOOL_VERB[toolName];
    if (verb) {
      const gist = summary.replace(/\s+/g, " ").trim();
      return gist ? `${verb}（${truncateText(gist, 16)}）` : verb;
    }
    if (summary) return truncateText(summary.replace(/\s+/g, " ").trim(), 18);
    return "";
  }
  return truncateText(text, 18);
}

/**
 * 工具段 → 一句口语化的「动手」台词。
 * 进行中：「我去跑条命令，稍等」；完成：「刚跑了条命令」。
 * 提炼自首个工具的 callSummary / toolName，不暴露 JSON、工具名与任务状态机语言。
 */
export function toolSegmentLine(item: Extract<ChatItem, { kind: "tools" }>): string {
  const gist = gistOfSummary(
    (item.tools.find((t) => t.callSummary)?.callSummary) || item.tools[0]?.toolName || "",
  );
  if (item.running) return gist ? `我去${gist}，稍等` : "我去弄一下，稍等";
  if (item.tools.length > 1) {
    return gist ? `刚忙完 ${item.tools.length} 件事，${gist}…` : `刚忙完 ${item.tools.length} 件事`;
  }
  return gist || "刚忙完了手头的活";
}

/** 展开明细里单条工具 → 干净短句（不露原始 JSON） */
export function toolDetailLine(tool: { callSummary: string; toolName: string }): string {
  const gist = gistOfSummary(tool.callSummary || tool.toolName);
  return gist || "手头的一步操作";
}

/** 任务接力链：按 DAG 依赖反推「谁干完 → 下一个谁」，按拓扑顺序排列 */
export function buildRelayChain(room: ServerRoomView | null): RelayTask[] {
  const tasks = room?.tasks || [];
  if (tasks.length === 0) return [];
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  // taskId → 依赖它的下游任务
  const downstream = new Map<string, typeof tasks>();
  for (const task of tasks) {
    for (const dep of task.dependsOn || []) {
      const list = downstream.get(dep) || [];
      list.push(task);
      downstream.set(dep, list);
    }
  }
  const order: RelayTask[] = [];
  const visited = new Set<string>();
  const walk = (taskId: string) => {
    if (visited.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) return;
    visited.add(taskId);
    order.push({
      taskId: task.taskId,
      title: task.title,
      state: task.state,
      assigneeName: task.assigneeName,
      assigneeAvatar: task.assigneeAvatar,
      assigneeColor: task.assigneeColor,
      nextNames: (downstream.get(taskId) || []).map((t) => t.assigneeName || "待分配"),
    });
    for (const next of downstream.get(taskId) || []) walk(next.taskId);
  };
  // 从源头（无依赖）开始走；剩余孤立任务直接补在尾部
  for (const task of tasks) {
    if (!(task.dependsOn || []).some((dep) => byId.has(dep))) walk(task.taskId);
  }
  for (const task of tasks) walk(task.taskId);
  return order;
}
