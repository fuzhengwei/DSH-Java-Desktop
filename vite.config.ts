import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 构建时间戳：注入前端产物，用于核对「运行中的 App 是否包含本次修复」——
  // 打包 App 内嵌的是构建时的 dist，改代码不重新打包就永远跑旧代码（2026-09-20 教训）
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2017",
    chunkSizeWarningLimit: 1500,
    minify: "esbuild",
    sourcemap: false,
  },
});
