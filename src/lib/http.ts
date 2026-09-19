import { fetch as pluginFetch } from "@tauri-apps/plugin-http";

/**
 * 双通道 fetch：优先原生 window.fetch，失败回退 Tauri plugin-http。
 *
 * 背景（2026-09-19 "生成中"永久卡死定位）：plugin-http 经 IPC Channel 转发响应体
 * （plugins-workspace#2129/#2415），偶发 chunk / 关闭信号不送达 webview，
 * SSE 流与 REST 都可能静默挂死；且 webview 的 TCP 连接可能整体坏死
 * （服务端同期出现 Broken pipe），此时所有走 plugin-http 的兜底通道同时失效。
 * 原生 fetch 不经 IPC 转发，流式可靠，但要求服务端开 CORS（内嵌 jar 已开）。
 *
 * 回退策略：按源记住原生失败时间，60 秒内对同源请求直接走插件通道（避免
 * 每次都先吃一次 CORS 拒绝）；超时后重试原生，服务端升级支持 CORS 后自动切回。
 * 对未开 CORS 的远端端点（外部数字人 Runtime 等），该策略等于长期走插件通道，
 * 与历史行为一致。
 */
const NATIVE_RETRY_MS = 60_000;
const nativeBlockedOrigins = new Map<string, number>();

export async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "";
  }
  const blockedAt = origin ? nativeBlockedOrigins.get(origin) : undefined;
  const nativeAllowed = !origin
    || blockedAt === undefined
    || Date.now() - blockedAt > NATIVE_RETRY_MS;
  if (nativeAllowed) {
    try {
      return await window.fetch(url, init);
    } catch (error) {
      if (!origin) throw error;
      nativeBlockedOrigins.set(origin, Date.now());
    }
  }
  return pluginFetch(url, init);
}
