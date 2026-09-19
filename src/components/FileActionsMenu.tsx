import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * 生成文件的右键操作菜单（对齐聊天产品里文件卡片的菜单能力）：
 *  - 打开：用系统默认程序打开
 *  - 打开文件夹：在 Finder / 资源管理器中定位
 *  - 另存为：弹系统对话框复制到指定位置
 *  - 复制文件路径：把绝对路径写进剪贴板（替代「分享」的通用出口）
 *
 * 用法：const { onContextMenu, menu } = useFileActions(path);
 *       把 onContextMenu 挂到目标元素上，menu 渲染到任意位置即可。
 */

type MenuAnchor = { x: number; y: number };

/** 菜单边缘留白，防止贴屏溢出 */
const MENU_EDGE_GAP = 8;
const MENU_SIZE = { width: 168, height: 172 };

function clampAnchor(anchor: MenuAnchor): MenuAnchor {
  const x = Math.max(MENU_EDGE_GAP, Math.min(anchor.x, window.innerWidth - MENU_SIZE.width - MENU_EDGE_GAP));
  const y = Math.max(MENU_EDGE_GAP, Math.min(anchor.y, window.innerHeight - MENU_SIZE.height - MENU_EDGE_GAP));
  return { x, y };
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板权限受限时兜底：隐藏输入框 + execCommand
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    try { document.execCommand("copy"); } catch { /* 忽略 */ }
    helper.remove();
  }
}

export function FileActionsMenu({ path, anchor, onClose }: {
  path: string;
  anchor: MenuAnchor;
  onClose: () => void;
}) {
  useEffect(() => {
    const onDown = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = (action: () => void | Promise<void>) => {
    onClose();
    void Promise.resolve(action()).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("文件操作失败:", message);
      alert(`文件操作失败：${message}`);
    });
  };

  const position = clampAnchor(anchor);
  return (
    <div
      className="file-actions-menu"
      role="menu"
      aria-label="文件操作"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" className="file-actions-menu-item" onClick={() => run(() => invoke("open_local_file", { path }))}>
        ↗ 打开
      </button>
      <button type="button" role="menuitem" className="file-actions-menu-item" onClick={() => run(() => invoke("reveal_local_file", { path }))}>
        📂 打开文件夹
      </button>
      <button type="button" role="menuitem" className="file-actions-menu-item" onClick={() => run(() => invoke("save_local_file_as", { path }))}>
        ⬇ 另存为
      </button>
      <div className="file-actions-menu-divider" aria-hidden="true" />
      <button type="button" role="menuitem" className="file-actions-menu-item" onClick={() => run(() => copyText(path))}>
        ⧉ 复制文件路径
      </button>
    </div>
  );
}

/** 右键菜单 hook：给任意文件卡片挂 onContextMenu，并渲染返回的 menu */
export function useFileActions(path: string | null | undefined): {
  onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => void;
  menu: ReactNode;
} {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const onContextMenu = (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
    if (!path) return;
    event.preventDefault();
    setAnchor({ x: event.clientX, y: event.clientY });
  };
  const menu = path && anchor ? <FileActionsMenu path={path} anchor={anchor} onClose={() => setAnchor(null)} /> : null;
  return { onContextMenu, menu };
}

/**
 * 包裹式入口：不改变布局（display: contents），只给子树加右键菜单。
 * 适合包 <button>、<article> 等不方便额外挂 hook 的既有卡片。
 */
export function FileActionsArea({ path, children }: { path: string | null | undefined; children: ReactNode }) {
  const { onContextMenu, menu } = useFileActions(path);
  return (
    <span style={{ display: "contents" }} onContextMenu={onContextMenu}>
      {children}
      {menu}
    </span>
  );
}
