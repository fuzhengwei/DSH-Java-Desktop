import i18n from "../i18n";
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
const t = i18n.t.bind(i18n);
export type ChatHuman = {
  id: string;
  name: string;
  avatar: string;
  color: string;
};
export type ChatItem = {
  kind: "sys";
  id: string;
  text: string;
  seq: number;
} | {
  kind: "user";
  id: string;
  content: string;
  seq: number;
}
/** 分工：渲染成调度者的一句「我想这样分工…」 */ | {
  kind: "plan";
  id: string;
  steps: Array<{
    seq: number;
    title: string;
    assigneeName: string;
  }>;
  seq: number;
} | {
  kind: "say";
  id: string;
  human: ChatHuman;
  text: string;
  seq: number;
}
/**
 * 动手过程：同一数字人的连续工具操作折叠成一句口语（「我去看看…」「忙完了」），
 * 点开展开明细，明细点击跳中间区域。聊天流里不出现任务状态机语言。
 */ | {
  kind: "tools";
  id: string;
  human: ChatHuman;
  tools: Array<{
    id: string;
    toolName: string;
    callSummary: string;
    done: boolean;
    seq: number;
  }>;
  running: boolean;
  seq: number;
}
/** 交付：一句「整理好了」+ 可点的产物名 */ | {
  kind: "artifact";
  id: string;
  artifactId: string;
  human: ChatHuman;
  title: string;
  kindLabel: string;
  seq: number;
}
/** 交接：一句「我做完了，交给下一位」 */ | {
  kind: "handoff";
  id: string;
  text: string;
  fromName: string;
  seq: number;
} | {
  kind: "approval";
  id: string;
  human: ChatHuman;
  summary: string;
  resolved?: string;
  seq: number;
} | {
  kind: "error";
  id: string;
  human: ChatHuman;
  message: string;
  seq: number;
};
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
  READY: t("room-chat.0"),
  ASSIGNED: t("room-chat.1"),
  RUNNING: t("room-chat.2"),
  DONE: t("room-chat.3"),
  FAILED: t("room-chat.4"),
  CANCELLED: t("room-chat.5")
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
  let pendingTools: Extract<ChatItem, {
    kind: "tools";
  }> | null = null;
  const flushTools = (closedByLaterEvent = false) => {
    if (!pendingTools) return;
    if (closedByLaterEvent) {
      pendingTools.tools = pendingTools.tools.map(tool => ({
        ...tool,
        done: true
      }));
    }
    pendingTools.running = pendingTools.tools.some(t => !t.done);
    items.push(pendingTools);
    pendingTools = null;
  };
  for (const item of feed) {
    switch (item.kind) {
      case "tool":
        {
          if (pendingTools && pendingTools.human.id === item.human.id) {
            pendingTools.tools.push({
              id: item.id,
              toolName: item.toolName,
              callSummary: item.callSummary || "",
              done: Boolean(item.resultSummary),
              seq: item.seq
            });
            pendingTools.seq = item.seq;
          } else {
            flushTools();
            pendingTools = {
              kind: "tools",
              id: `tools_${item.id}`,
              human: item.human,
              tools: [{
                id: item.id,
                toolName: item.toolName,
                callSummary: item.callSummary || "",
                done: Boolean(item.resultSummary),
                seq: item.seq
              }],
              running: !item.resultSummary,
              seq: item.seq
            };
          }
          break;
        }
      case "user":
        flushTools(true);
        items.push({
          kind: "user",
          id: item.id,
          content: item.content,
          seq: item.seq
        });
        break;
      case "sys":
        flushTools(true);
        items.push({
          kind: "sys",
          id: item.id,
          text: item.text,
          seq: item.seq
        });
        break;
      case "plan":
        flushTools(true);
        items.push({
          kind: "plan",
          id: item.id,
          steps: item.steps.map(s => ({
            seq: s.seq,
            title: s.title,
            assigneeName: s.assigneeName
          })),
          seq: item.seq
        });
        break;
      case "human-message":
        {
          flushTools(true);
          const firstLine = (item.content || "").split(/\r?\n/).find(line => line.trim()) || "…";
          items.push({
            kind: "say",
            id: item.id,
            human: item.human,
            text: truncateText(firstLine.trim(), 60),
            seq: item.seq
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
          seq: item.seq
        });
        break;
      case "handoff":
        flushTools(true);
        items.push({
          kind: "handoff",
          id: item.id,
          text: t("room-chat.69", {
            v0: item.fromName
          }),
          fromName: item.fromName,
          seq: item.seq
        });
        break;
      case "approval":
        flushTools(true);
        items.push({
          kind: "approval",
          id: item.id,
          human: item.human,
          summary: truncateText(item.summary || t("room-chat.6"), 48),
          resolved: item.resolved,
          seq: item.seq
        });
        break;
      case "error":
        flushTools(true);
        items.push({
          kind: "error",
          id: item.id,
          human: item.human,
          message: truncateText(item.message, 48),
          seq: item.seq
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
  shell_execute: {
    intent: t("room-chat.7"),
    done: t("room-chat.8"),
    action: t("room-chat.9")
  },
  execute_command: {
    intent: t("room-chat.10"),
    done: t("room-chat.11"),
    action: t("room-chat.12")
  },
  run_command: {
    intent: t("room-chat.13"),
    done: t("room-chat.14"),
    action: t("room-chat.15")
  },
  fs_read: {
    intent: t("room-chat.16"),
    done: t("room-chat.17"),
    action: t("room-chat.18")
  },
  read_file: {
    intent: t("room-chat.19"),
    done: t("room-chat.20"),
    action: t("room-chat.21")
  },
  fs_write: {
    intent: t("room-chat.22"),
    done: t("room-chat.23"),
    action: t("room-chat.24")
  },
  write_file: {
    intent: t("room-chat.25"),
    done: t("room-chat.26"),
    action: t("room-chat.27")
  },
  fs_edit: {
    intent: t("room-chat.28"),
    done: t("room-chat.29"),
    action: t("room-chat.30")
  },
  edit_file: {
    intent: t("room-chat.31"),
    done: t("room-chat.32"),
    action: t("room-chat.33")
  },
  create_file: {
    intent: t("room-chat.34"),
    done: t("room-chat.35"),
    action: t("room-chat.36")
  },
  mkdir: {
    intent: t("room-chat.37"),
    done: t("room-chat.38"),
    action: t("room-chat.39")
  },
  fs_list: {
    intent: t("room-chat.40"),
    done: t("room-chat.41"),
    action: t("room-chat.42")
  },
  fs_tree: {
    intent: t("room-chat.43"),
    done: t("room-chat.44"),
    action: t("room-chat.45")
  },
  list_dir: {
    intent: t("room-chat.46"),
    done: t("room-chat.47"),
    action: t("room-chat.48")
  },
  search: {
    intent: t("room-chat.49"),
    done: t("room-chat.50"),
    action: t("room-chat.51")
  },
  grep: {
    intent: t("room-chat.52"),
    done: t("room-chat.53"),
    action: t("room-chat.54")
  },
  web_search: {
    intent: t("room-chat.55"),
    done: t("room-chat.56"),
    action: t("room-chat.57")
  },
  web_fetch: {
    intent: t("room-chat.58"),
    done: t("room-chat.59"),
    action: t("room-chat.60")
  }
};
const FALLBACK_NARRATIVE: ToolNarrative = {
  intent: t("room-chat.61"),
  done: t("room-chat.62"),
  action: t("room-chat.63")
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
      try {
        args = JSON.parse(args);
      } catch {/* 保持字符串 */}
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
export function toolSegmentVoice(item: Extract<ChatItem, {
  kind: "tools";
}>): ToolSegmentVoice {
  const first = item.tools.find(tool => tool.callSummary) || item.tools[0];
  const toolName = toolNameOf(first?.callSummary || first?.toolName || "") || first?.toolName || "";
  const narrative = narrativeFor(toolName);
  const detail = summaryOf(first?.callSummary || "");
  const multiple = item.tools.length > 1;
  if (item.running) {
    return {
      stage: "acting",
      label: t("room-chat.64"),
      line: detail ? `${narrative.intent}：${detail}` : narrative.intent,
      action: multiple ? t("room-chat.70", {
        v0: narrative.action,
        v1: item.tools.length
      }) : narrative.action,
      detail
    };
  }
  return {
    stage: "done",
    label: t("room-chat.65"),
    line: multiple ? t("room-chat.66") : narrative.done,
    action: multiple ? t("room-chat.71", {
      v0: narrative.action,
      v1: item.tools.length
    }) : narrative.action,
    detail
  };
}

/**
 * 工具段 → 一句口语化的「动手」台词。
 * 进行中：「我去跑条命令，稍等」；完成：「刚跑了条命令」。
 * 提炼自首个工具的 callSummary / toolName，不暴露 JSON、工具名与任务状态机语言。
 */
export function toolSegmentLine(item: Extract<ChatItem, {
  kind: "tools";
}>): string {
  return toolSegmentVoice(item).line;
}

/** 展开明细里单条工具 → 干净短句（不露原始 JSON） */
export function toolDetailLine(tool: {
  callSummary: string;
  toolName: string;
}): string {
  const gist = gistOfSummary(tool.callSummary || tool.toolName);
  return gist || t("room-chat.67");
}

/** 任务接力链：按 DAG 依赖反推「谁干完 → 下一个谁」，按拓扑顺序排列 */
export function buildRelayChain(room: ServerRoomView | null): RelayTask[] {
  const tasks = room?.tasks || [];
  if (tasks.length === 0) return [];
  const byId = new Map(tasks.map(t => [t.taskId, t]));
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
      nextNames: (downstream.get(taskId) || []).map(taskNext => taskNext.assigneeName || t("room-chat.68"))
    });
    for (const next of downstream.get(taskId) || []) walk(next.taskId);
  };
  // 从源头（无依赖）开始走；剩余孤立任务直接补在尾部
  for (const task of tasks) {
    if (!(task.dependsOn || []).some(dep => byId.has(dep))) walk(task.taskId);
  }
  for (const task of tasks) walk(task.taskId);
  return order;
}