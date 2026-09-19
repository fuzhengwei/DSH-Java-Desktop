#!/bin/bash
# DSH Java Desktop 开发模式启动脚本
# 用途：双击运行（macOS Finder）或在终端执行。
# 自动处理：停止旧实例 -> 清理构建缓存（Permission denied os error 13）-> 启动 dev

cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo " DSH Java Desktop 开发模式启动"
echo "=========================================="

# ---- 1. 停止旧实例（内嵌 Java agent + 桌面 app）----
APP_SUPPORT="$HOME/Library/Application Support/cn.xiaofuge.desktop/agent-runtime.json"
if [ -f "$APP_SUPPORT" ]; then
  AGENT_PID=$(/usr/bin/python3 -c "import json;print(json.load(open('$APP_SUPPORT')).get('pid',''))" 2>/dev/null)
  if [ -n "$AGENT_PID" ] && kill -0 "$AGENT_PID" 2>/dev/null; then
    echo "[1/3] 停止旧 agent 进程 (pid=$AGENT_PID) ..."
    kill "$AGENT_PID" 2>/dev/null
    sleep 1
    kill -9 "$AGENT_PID" 2>/dev/null
  else
    echo "[1/3] 无运行中的旧 agent 进程"
  fi
fi

if pgrep -f "target/debug/dsh-java-desktop" >/dev/null 2>&1; then
  echo "      停止旧桌面实例 ..."
  pkill -f "target/debug/dsh-java-desktop" 2>/dev/null
  sleep 1
fi

# ---- 2. 清理 bundle resource 构建缓存 ----
# 旧实例运行时占用 target/debug/agent/ 内文件，导致 cargo build script
# 覆盖资源时报 "Permission denied (os error 13)"。先停实例再删缓存即可。
if [ -d "src-tauri/target/debug/agent" ]; then
  echo "[2/3] 清理构建缓存 src-tauri/target/debug/agent ..."
  rm -rf src-tauri/target/debug/agent
else
  echo "[2/3] 构建缓存不存在，无需清理"
fi

# ---- 3. 启动 ----
echo "[3/3] 启动 npm run tauri dev ..."
echo "=========================================="
exec npm run tauri dev
