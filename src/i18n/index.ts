import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

export type LanguageSetting = "en" | "zh" | "system";

const STORAGE_KEY = "dsh-language";

/**
 * 界面语言：
 * - 设置页可切换 English / 中文 / 跟随系统（localStorage 持久化）
 * - 未手动设置时默认英文（AppImage catalog 要求：非中文环境默认英文界面；
 *   中文用户可在设置中切换为中文）
 * - 「跟随系统」= 按 navigator.language，zh* 显示中文，其余英文
 * - 浏览器开发调试仍可用 ?lang=en / ?lang=zh 强制指定（优先级最高）
 */
export function readStoredLanguage(): LanguageSetting {
  const forced = new URLSearchParams(window.location.search).get("lang");
  if (forced === "en" || forced === "zh") return forced;
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "zh" || value === "system" ? value : "en";
}

export function detectLocale(): "zh-CN" | "en" {
  const lang = (navigator.language || "en").toLowerCase();
  return lang.startsWith("zh") ? "zh-CN" : "en";
}

function resolveLanguage(setting: LanguageSetting): "zh-CN" | "en" {
  return setting === "system" ? detectLocale() : setting === "zh" ? "zh-CN" : "en";
}

export function setLanguage(setting: LanguageSetting): void {
  localStorage.setItem(STORAGE_KEY, setting);
  void i18n.changeLanguage(resolveLanguage(setting));
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: resolveLanguage(readStoredLanguage()),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
