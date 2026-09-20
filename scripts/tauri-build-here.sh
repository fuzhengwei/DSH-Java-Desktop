#!/bin/zsh
# 打包 DSH-Java-Desktop 桌面应用（供任意工作目录调用）：先构建前端，再 tauri build
cd "/Users/fuzhengwei/DevOps/DSH-Java-Desktop" || exit 1
npm run build || exit 1
npx tauri build "$@"
