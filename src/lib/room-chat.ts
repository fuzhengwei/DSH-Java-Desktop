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
  | { kind: "artifact"; id: string; artifactId: string; human: ChatHuman; title: string; kindLabel: string; seq: number }
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
  const flushTools = (closedByLaterEvent = false) => {
    if (!pendingTools) return;
    if (closedByLaterEvent) {
      pendingTools.tools = pendingTools.tools.map((tool) => ({ ...tool, done: true }));
    }
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
        flushTools(true);
        items.push({ kind: "user", id: item.id, content: item.content, seq: item.seq });
        break;
      case "sys":
        flushTools(true);
        items.push({ kind: "sys", id: item.id, text: item.text, seq: item.seq });
        break;
      case "plan":
        flushTools(true);
        items.push({
          kind: "plan",
          id: item.id,
          steps: item.steps.map((s) => ({ seq: s.seq, title: s.title, assigneeName: s.assigneeName })),
          seq: item.seq,
        });
        break;
      case "human-message": {
        flushTools(true);
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
        flushTools(true);
        items.push({
          kind: "artifact",
          id: item.id,
          artifactId: item.artifactId,
          human: item.human,
          title: item.title,
          kindLabel: item.kindLabel,
          seq: item.seq,
        });
        break;
      case "handoff":
        flushTools(true);
        items.push({
          kind: "handoff",
          id: item.id,
          text: `我做完了，接下来交给 @${item.fromName} 接手`,
          fromName: item.fromName,
          seq: item.seq,
        });
        break;
      case "approval":
        flushTools(true);
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
        flushTools(true);
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

type ToolNarrative = {
  intent: string;
  done: string;
  action: string;
};

/** 工具名 → 群聊里的动作意图。只展示“准备做什么”，不展示模型私有推理链。 */
const TOOL_NARRATIVE: Record<string, ToolNarrative> = {
  shell_execute: { intent: "我先跑一下命令，确认现场情况", done: "命令跑完了，我看下结果", action: "跑命令" },
  execute_command: { intent: "我先跑一下命令，确认现场情况", done: "命令跑完了，我看下结果", action: "跑命令" },
  run_command: { intent: "我先跑一下命令，确认现场情况", done: "命令跑完了，我看下结果", action: "跑命令" },
  fs_read: { intent: "我先翻一下相关文件，确认上下文", done: "文件看完了，关键点我记下了", action: "看文件" },
  read_file: { intent: "我先翻一下相关文件，确认上下文", done: "文件看完了，关键点我记下了", action: "看文件" },
  fs_write: { intent: "我准备直接改一下相关文件", done: "文件已经改过了", action: "改文件" },
  write_file: { intent: "我准备直接改一下相关文件", done: "文件已经改过了", action: "改文件" },
  fs_edit: { intent: "我准备直接改一下相关文件", done: "文件已经改过了", action: "改文件" },
  edit_file: { intent: "我准备直接改一下相关文件", done: "文件已经改过了", action: "改文件" },
  create_file: { intent: "我准备补一个新文件", done: "新文件已经放好了", action: "写文件" },
  mkdir: { intent: "我先把目录位置整理出来", done: "目录已经准备好了", action: "建目录" },
  fs_list: { intent: "我先看看目录结构", done: "目录结构确认了", action: "看目录" },
  fs_tree: { intent: "我先看看目录结构", done: "目录结构确认了", action: "看目录" },
  list_dir: { intent: "我先看看目录结构", done: "目录结构确认了", action: "看目录" },
  search: { intent: "我先搜一下线索", done: "线索搜完了，我来整理", action: "搜线索" },
  grep: { intent: "我先在代码里搜一下线索", done: "代码线索找到了", action: "搜代码" },
  web_search: { intent: "我先查一下资料", done: "资料查到了，我来筛一下", action: "查资料" },
  web_fetch: { intent: "我先打开资料看一眼", done: "资料读完了，我来提炼", action: "读资料" },
};

const FALLBACK_NARRATIVE: ToolNarrative = {
  intent: "我先动手查一下，马上回来",
  done: "这一步处理完了",
  action: "处理一步",
};

function narrativeFor(toolName: string): ToolNarrative {
  return TOOL_NARRATIVE[toolName.toLowerCase()] || FALLBACK_NARRATIVE;
}

function toolNameOf(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (TOOL_NARRATIVE[text.toLowerCase()]) return text.toLowerCase();
  if (!text.startsWith("{")) return "";
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    return String(obj.toolName || obj.name || "").toLowerCase();
  } catch {
    return ((text.match(/"toolName"\s*:\s*"([^"]+)"/) || [])[1] || "").toLowerCase();
  }
}

function summaryOf(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || TOOL_NARRATIVE[text.toLowerCase()]) return "";
  if (!text.startsWith("{")) return truncateText(text, 24);
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    // 上游整包事件 JSON 没有 summary 字段时，退而提炼 args.command（如 shell 命令原文）
    let args: unknown = obj.args ?? obj.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { /* 保持字符串 */ }
    }
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const cmd = (args as Record<string, unknown>).command ?? (args as Record<string, unknown>).cmd;
      if (typeof cmd === "string" && cmd.trim()) return truncateText(cmd.replace(/\s+/g, " ").trim(), 24);
    }
    return truncateText(String(obj.summary || obj.description || "").replace(/\s+/g, " ").trim(), 24);
  } catch {
    return truncateText(((text.match(/"summary"\s*:\s*"([^"]*)"/) || [])[1] || "").replace(/\s+/g, " ").trim(), 24);
  }
}

/**
 * callSummary → 一句干净的人话。
 * callSummary 可能是原始 JSON（{"toolName":"shell_execute",...}）或纯文本，
 * 这里统一提炼：JSON 先解析/正则抽 toolName+summary，再映射成动词短语。
 */
function gistOfSummary(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const narrative = narrativeFor(toolNameOf(text));
  const summary = summaryOf(text);
  return summary ? `${narrative.action}：${summary}` : narrative.action;
}

export type ToolSegmentVoice = {
  stage: "thinking" | "acting" | "done";
  label: string;
  line: string;
  action: string;
  detail: string;
};

export function toolSegmentVoice(item: Extract<ChatItem, { kind: "tools" }>): ToolSegmentVoice {
  const first = item.tools.find((tool) => tool.callSummary) || item.tools[0];
  const toolName = toolNameOf(first?.callSummary || first?.toolName || "") || first?.toolName || "";
  const narrative = narrativeFor(toolName);
  const detail = summaryOf(first?.callSummary || "");
  const multiple = item.tools.length > 1;
  if (item.running) {
    return {
      stage: "acting",
      label: "正在动手",
      line: detail ? `${narrative.intent}：${detail}` : narrative.intent,
      action: multiple ? `${narrative.action}等 ${item.tools.length} 步` : narrative.action,
      detail,
    };
  }
  return {
    stage: "done",
    label: "已处理",
    line: multiple ? `这几步我处理完了，先把结果接上。` : narrative.done,
    action: multiple ? `${narrative.action}等 ${item.tools.length} 步` : narrative.action,
    detail,
  };
}

/**
 * 工具段 → 一句口语化的「动手」台词。
 * 进行中：「我去跑条命令，稍等」；完成：「刚跑了条命令」。
 * 提炼自首个工具的 callSummary / toolName，不暴露 JSON、工具名与任务状态机语言。
 */
export function toolSegmentLine(item: Extract<ChatItem, { kind: "tools" }>): string {
  return toolSegmentVoice(item).line;
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
