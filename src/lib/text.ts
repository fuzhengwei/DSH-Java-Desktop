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
