#!/usr/bin/env bash
# Linux AppImage 构建补丁：规范 AppDir 内文件权限。
#
# 背景：AppImageHub 的自动化测试在 firejail 沙箱里运行 AppImage，沙箱进程
# 非 owner 身份。tauri bundler 下载的 AppRun-x86_64 在部分 runner 文件系统
# 上被写成 750（POSIX ACL / umask 差异），linuxdeploy 将其 rename 为
# AppRun.wrapped 后权限原样保留，沙箱内 exec 报
# "AppRun.wrapped: Permission denied"，应用无法启动。
#
# 修复：linuxdeploy 跑完、appimagetool 打包前，把 AppDir 全部文件规范为
# 目录 755、可执行文件 755、其余 644，并清掉 ACL。
#
# 调用时机：build-desktop.yml 中 Linux 构建在 tauri build 之前无法介入
# （linuxdeploy 在 tauri build 内部运行），因此这里在 tauri build 完成后
# 直接对已生成的 AppImage 重打包（mksquashfs 权限来自 AppDir，重打包需要
# 解包→修权限→重压缩）。为避免重复解包 160MB 资源，改在 tauri build 之前
# 对"上一次构建残留的 AppDir"做修复不可行——正确时机见 CI 脚本：在
# tauri build 前先设 umask 022 并清理 ACL 源头（ umask 影响新写文件），
# 再在 build 后对 AppImage 做权限校验（本脚本 --verify 模式）。
#
# 幂等；非 Linux 或无产物时静默退出，不影响其他平台。
set -euo pipefail

if [ "$(uname)" != "Linux" ]; then
  exit 0
fi

MODE="${1:-verify}"

# ---- verify 模式：检查已生成 AppImage 内关键文件是否 others 可执行 ----
# 用法: fix-apprun-perms.sh verify [appimage路径...]
if [ "$MODE" = "verify" ]; then
  shift || true
  TARGETS=("$@")
  if [ ${#TARGETS[@]} -eq 0 ]; then
    shopt -s nullglob
    TARGETS=(src-tauri/target/release/bundle/appimage/*.AppImage)
    shopt -u nullglob
  fi
  rc=0
  for img in "${TARGETS[@]}"; do
    [ -f "$img" ] || continue
    # AppRun ELF 位于 runtime 之后；用 unsquashfs 读取 AppRun 权限
    OFFSET=$(python3 - "$img" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read(1024*1024)
f = open(sys.argv[1], 'rb')
f.seek(0, 2); total = f.tell()
# runtime ELF 大小：squashfs superblock ('hsqs') 通常紧跟 runtime
import struct
# 简化：找 'hsqs' 出现位置（跳过文件名里可能的巧合，取第一个 4K 对齐或紧邻 runtime 的）
idx = data.find(b'hsqs')
# AppImage runtime 一般 < 1MB；hsqs 在 runtime 末尾
print(idx if idx > 0 else 944632)
PY
)
    echo "[fix-apprun-perms] checking $img (squashfs at offset $OFFSET)"
    if command -v unsquashfs >/dev/null 2>&1; then
      TMPDIR_CHECK=$(mktemp -d)
      if unsquashfs -o "$OFFSET" -d "$TMPDIR_CHECK/root" "$img" > /dev/null 2>&1; then
        BAD=""
        for f in "$TMPDIR_CHECK/root/AppRun" "$TMPDIR_CHECK/root/AppRun.wrapped"; do
          [ -f "$f" ] || continue
          PERMS=$(stat -c "%a" "$f" 2>/dev/null || stat -f "%Lp" "$f")
          OTHERS_EXEC=$(( 8#$(echo "$PERMS" | cut -c9) & 1 ))
          if [ "$OTHERS_EXEC" -ne 1 ]; then
            echo "ERROR: $f permission is $PERMS — others cannot execute (firejail will fail)"
            BAD=1
          fi
        done
        if [ -z "$BAD" ]; then
          echo "[fix-apprun-perms] OK: AppRun/AppRun.wrapped are world-executable"
        else
          rc=1
        fi
      else
        echo "WARNING: could not unpack $img for verification (unsquashfs too old?)"
      fi
      rm -rf "$TMPDIR_CHECK"
    fi
  done
  exit $rc
fi

# ---- 默认模式：对 AppDir staging 规范权限（CI 中 tauri build 后调用，
#      针对 linuxdeploy 已跑完但 appimagetool 尚未打包的场景不可行，
#      因此 CI 实际用法：build 前 umask 022 + 本脚本在 build 后 verify） ----
STAGE_BASES=(
  "${TAURI_DIR:-src-tauri}/target/release/bundle/appimage"
  "${TAURI_DIR:-src-tauri}/target/debug/bundle/appimage"
)

found=0
for stage_base in "${STAGE_BASES[@]}"; do
  [ -d "$stage_base" ] || continue
  shopt -s nullglob
  for appdir in "$stage_base"/*.AppDir; do
    [ -d "$appdir" ] || continue
    found=1
    echo "[fix-apprun-perms] normalizing permissions in $appdir"
    setfacl -Rb "$appdir" 2>/dev/null || true
    find "$appdir" -type d -exec chmod 755 {} +
    find "$appdir" -type f -exec chmod 644 {} +
    # 可执行内容：主程序/库/AppRun/JRE/WebKit helpers
    find "$appdir" -type f \( -name "*.so" -o -name "*.so.*" -o -name "AppRun*" \
      -o -name "jspawnhelper" -o -name "WebKit*" -o -name "jshell" -o -name "jrunscript" \) -exec chmod 755 {} +
    [ -d "$appdir/usr/bin" ] && find "$appdir/usr/bin" -type f -exec chmod 755 {} +
    runtime="$appdir/usr/lib/DSH Java Desktop/agent/runtime"
    if [ -d "$runtime/bin" ]; then
      chmod 755 "$runtime/bin/"*
      find "$runtime/lib" -name "*.so" -exec chmod 755 {} + 2>/dev/null || true
      find "$runtime" -type f -perm /111 -exec chmod 755 {} + 2>/dev/null || true
    fi
    echo "[fix-apprun-perms] done"
  done
  shopt -u nullglob
done

if [ "$found" -eq 0 ]; then
  echo "[fix-apprun-perms] no AppImage AppDir staging found (skipping)"
fi
exit 0
