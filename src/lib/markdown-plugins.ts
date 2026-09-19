import rehypeHighlight from "rehype-highlight";

/**
 * 共享 Markdown 语法高亮配置。
 * rehype-highlight 会给 ```lang 代码块内的 <code> 注入 hljs-* 着色 class
 * （主题样式见 main.tsx 引入的 highlight.js github 主题 + styles.css 覆写）。
 * 未标注语言（无 language-* class）的代码块不做高亮，保持原样。
 */
export const rehypePlugins = [rehypeHighlight] as const;

/** 常见文件扩展名 → highlight.js 语言名的映射（hljs 里有同名语言的直接命中） */
const EXT_LANGUAGE_MAP: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  cs: "csharp", swift: "swift", php: "php",
  html: "xml", xml: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", less: "less",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", properties: "ini",
  sql: "sql", json: "json", gradle: "gradle", md: "markdown", markdown: "markdown",
};

/**
 * 按文件扩展名解析 highlight.js 语言；
 * 未知扩展名返回 null（由调用方决定是否自动探测）。
 */
export function languageFromExtension(name: string): string | null {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const mapped = EXT_LANGUAGE_MAP[ext];
  if (mapped) return mapped;
  return ext; // hljs 内置了不少与扩展名同名的语言（sql/java/rust…），交给调用方 getLanguage 校验
}

export { rehypeHighlight };
