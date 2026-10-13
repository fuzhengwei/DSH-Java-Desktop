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
    # squashfs superblock ('hsqs') 紧跟 runtime ELF。AppImage 规范：runtime 的
    # squashfs 起始偏移记录在自身（--appimage-offset），优先用它。
    OFFSET=$("$img" --appimage-offset 2>/dev/null || true)
    if [ -z "${OFFSET}" ]; then
      # 无 FUSE/无法执行时退化为扫描（取最后一个 hsqs——前面的是 ELF 内容巧合）
      OFFSET=$(python3 - "$img" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read(2 * 1024 * 1024)
idxs = []
i = 0
while True:
    i = data.find(b'hsqs', i + 1)
    if i < 0:
        break
    idxs.append(i)
print(idxs[-1] if idxs else 0)
PY
)
    fi
    echo "[fix-apprun-perms] checking $img (squashfs at offset $OFFSET)"
    if command -v unsquashfs >/dev/null 2>&1; then
      TMPDIR_CHECK=$(mktemp -d)
      if unsquashfs -o "$OFFSET" -d "$TMPDIR_CHECK/root" "$img" > /dev/null 2>&1; then
        BAD=""
        for f in "$TMPDIR_CHECK/root/AppRun" "$TMPDIR_CHECK/root/AppRun.wrapped"; do
          [ -f "$f" ] || continue
          PERMS=$(stat -c "%a" "$f" 2>/dev/null || stat -f "%Lp" "$f")
          # perms 可能是 3 位（755）或 4 位（0755），others exec 位 = 最后一位的最低位
          OTHERS_EXEC=$(( 8#${PERMS: -1} & 1 ))
          if [ "$OTHERS_EXEC" -ne 1 ]; then
            echo "ERROR: $f permission is $PERMS — others cannot execute (firejail will fail)"
            BAD=1
          fi
        done
        if [ -z "$BAD" ]; then
          echo "[fix-apprun-perms] OK: AppRun/AppRun.wrapped are world-executable"
        else
          # 权限有问题：就地重打包（解包→修权限→mksquashfs→拼回 runtime）
          echo "[fix-apprun-perms] repacking $img with fixed permissions..."
          WORK=$(mktemp -d)
          unsquashfs -o "$OFFSET" -d "$WORK/root" "$img" > /dev/null 2>&1
          setfacl -Rb "$WORK/root" 2>/dev/null || true
          find "$WORK/root" -type d -exec chmod 755 {} +
          find "$WORK/root" -type f -exec chmod 644 {} +
          find "$WORK/root" -type f \( -name "*.so" -o -name "*.so.*" -o -name "AppRun*" \
            -o -name "jspawnhelper" \) -exec chmod 755 {} +
          # 主程序与所有原本带执行位的二进制
          find "$WORK/root/usr/bin" -type f -exec chmod 755 {} + 2>/dev/null || true
          RUNTIME_DIR="$WORK/root/usr/lib/DSH Java Desktop/agent/runtime"
          if [ -d "$RUNTIME_DIR/bin" ]; then
            chmod 755 "$RUNTIME_DIR/bin/"*
            find "$RUNTIME_DIR" -type f -perm /111 -exec chmod 755 {} + 2>/dev/null || true
            find "$RUNTIME_DIR/lib" -name "*.so" -exec chmod 755 {} + 2>/dev/null || true
          fi
          find "$WORK/root" -type f -perm /111 -exec chmod 755 {} + 2>/dev/null || true
          find "$WORK/root/usr/lib" -type f \( -name "WebKitNetworkProcess" -o -name "WebKitWebProcess" \) -exec chmod 755 {} + 2>/dev/null || true
          # 重新打包：mksquashfs + 拼接 runtime
          RUNTIME_SIZE=$OFFSET
          head -c "$RUNTIME_SIZE" "$img" > "$WORK/runtime"
          mksquashfs "$WORK/root" "$WORK/payload.squashfs" -root-owned -noappend -comp zstd -Xcompression-level 19 -quiet > /dev/null 2>&1 \
            || mksquashfs "$WORK/root" "$WORK/payload.squashfs" -root-owned -noappend -quiet > /dev/null 2>&1
          cat "$WORK/runtime" "$WORK/payload.squashfs" > "$WORK/fixed.AppImage"
          chmod 755 "$WORK/fixed.AppImage"
          mv "$WORK/fixed.AppImage" "$img"
          rm -rf "$WORK"
          echo "[fix-apprun-perms] repacked: $img"
          # 复检
          if bash "$0" verify "$img"; then
            echo "[fix-apprun-perms] final verify passed"
          else
            echo "ERROR: repack verification failed for $img"
            rc=1
          fi
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
