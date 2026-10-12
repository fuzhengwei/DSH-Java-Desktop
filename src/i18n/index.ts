import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

/**
 * 系统语言检测：
 * - 浏览器开发调试可用 ?lang=en / ?lang=zh 强制指定
 * - Tauri 桌面端读取系统 locale（navigator.language 在 WebView 中已映射系统语言）
 * - zh-CN / zh-TW / zh-HK 等中文 locale 显示中文
 * - 其他 locale 一律回退英文（AppImage catalog 要求）
 */
export function detectLocale(): "zh-CN" | "en" {
  const forced = new URLSearchParams(window.location.search).get("lang");
  if (forced === "en" || forced === "zh") return forced === "en" ? "en" : "zh-CN";
  const lang = (navigator.language || "en").toLowerCase();
  return lang.startsWith("zh") ? "zh-CN" : "en";
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: detectLocale(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
