/**
 * 与后端 WorkspaceRegistryService 的名称清洗规则保持一致：
 * 后端使用 `[^\p{L}\p{N}._-]` → `_`，把所有 emoji、符号变体、组合字符等替换为下划线。
 * 前端在创建/编辑项目前应用同样的清洗，避免用户输入的名称与后端存储的名称不一致。
 */
export function sanitizeProjectName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 用于展示时剥离 emoji 与符号变体，避免在部分字体下渲染为占位框。
 * 如果清洗后为空，则回退到原始名称。
 */
export function sanitizeDisplayName(name: string): string {
  const cleaned = name
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{2500}-\u{257F}\u{2580}-\u{259F}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || name;
}

/** 隐藏上下文块的开闭标记：资源/工程注入只给模型看，不进聊天流 */
const HIDDEN_CONTEXT_OPEN = "<hidden-context>";
const HIDDEN_CONTEXT_CLOSE = "</hidden-context>";

/**
 * 展示用户消息前剥掉隐藏上下文注入块。
 * 房间协作路径下，服务端 MESSAGE_CREATED 事件回显的是完整外发消息
 * （正文 + <hidden-context> 注入），聊天气泡必须只呈现正文部分。
 */
export function stripHiddenContext(value: string): string {
  let text = value;
  const openIndex = text.indexOf(HIDDEN_CONTEXT_OPEN);
  if (openIndex >= 0) {
    const closeIndex = text.indexOf(HIDDEN_CONTEXT_CLOSE, openIndex);
    text = closeIndex >= 0
      ? text.slice(0, openIndex) + text.slice(closeIndex + HIDDEN_CONTEXT_CLOSE.length)
      : text.slice(0, openIndex);
  }
  // 兜底：早期版本未包 hidden-context 标记的「当前选择的工程」尾巴
  return text.replace(/\n?\[当前选择的工程\][\s\S]*$/, "").trim();
}

/**
 * 还原被 harness 包装过的用户消息。
 * 后端给模型下发指令时会包装首条消息：
 *   「请先使用可用工具完成下面的任务，……\n\n用户原始请求：<原始消息>」
 * 会话标题、聊天气泡等展示处都应取「用户原始请求」之后的原始消息，
 * 否则所有会话标题都变成同一段包装文案。
 */
export function visibleUserMessage(value: string): string {
  const marker = "用户原始请求：";
  const instructionPrefix = "请先使用可用工具完成下面的任务，";
  if (value.startsWith(instructionPrefix) && value.includes(marker)) {
    return value.slice(value.indexOf(marker) + marker.length).trim();
  }
  return value;
}

/** 会话标题缩略展示的最大长度，超出部分以省略号截断 */
export const SESSION_TITLE_MAX_LENGTH = 24;

/**
 * 把会话标题压缩为缩略信息：折叠连续空白、取单行、超长截断。
 * 用于会话列表与顶栏标题，保证「新对话」发出首条消息后的名称简洁一致。
 */
export function truncateSessionTitle(title: string, maxLength = SESSION_TITLE_MAX_LENGTH): string {
  const cleaned = title.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}…`;
}
