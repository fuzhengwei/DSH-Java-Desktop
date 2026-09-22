import React from "react";

/**
 * 顶层 ErrorBoundary（D-09）：渲染树任意未捕获异常的最后一道防线。
 *
 * 背景：此前任何组件抛错（如会话历史里脏数据触发渲染异常）都会让整个
 * webview 白屏且无任何提示——用户既看不到错误也无处重试。
 *
 * 行为：
 * - 捕获渲染期/生命周期异常，展示可读的错误面板（含错误摘要与组件栈），
 *   并把 details 写入 localStorage 供后续排查（循环滚动保留最近 5 次）。
 * - 提供「重试」按钮：清空内部错误状态重新渲染整棵树（修复数据后可原地恢复）。
 * - 不吞 Promise/事件回调里的异步异常（那些本就走 window.onerror 通道）。
 */

const ERROR_LOG_KEY = "dsh-error-boundary-log";
const ERROR_LOG_LIMIT = 5;

function recordErrorLog(entry: { message: string; stack: string | null; at: string }) {
  try {
    const raw = window.localStorage.getItem(ERROR_LOG_KEY);
    const list: unknown[] = raw ? JSON.parse(raw) : [];
    list.push(entry);
    while (list.length > ERROR_LOG_LIMIT) list.shift();
    window.localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(list));
  } catch {
    // 存储失败（配额/隐私模式）时静默——错误面板本身仍然可用
  }
}

type ErrorBoundaryProps = { children: React.ReactNode };

type ErrorBoundaryState = {
  error: Error | null;
  componentStack: string | null;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const componentStack = info.componentStack ?? null;
    this.setState({ componentStack });
    recordErrorLog({
      message: error.message || String(error),
      stack: error.stack ?? null,
      at: new Date().toISOString(),
    });
    // 结构化错误输出：桌面端可从 webview 控制台 / 日志采集看到
    console.error("[ErrorBoundary] 渲染树异常", error, componentStack);
  }

  private readonly handleRetry = () => {
    this.setState({ error: null, componentStack: null });
  };

  private readonly handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const stackTop = (error.stack || "").split("\n").slice(0, 6).join("\n");
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--surface, #f5f5f7)",
          color: "var(--text-primary, #1d1d1f)",
          fontFamily: "inherit",
          zIndex: 9999,
        }}
      >
        <div
          style={{
            maxWidth: 560,
            padding: "28px 32px",
            borderRadius: 14,
            background: "var(--bg-elevated, #fff)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 10 }}>
            界面出现异常
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-secondary, #6e6e73)", whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: 18 }}>
            {error.message || String(error)}
          </div>
          {stackTop ? (
            <details style={{ marginBottom: 18 }}>
              <summary style={{ fontSize: 12, color: "var(--text-tertiary, #98989d)", cursor: "pointer" }}>
                技术详情
              </summary>
              <pre style={{ fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 180, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-secondary, #6e6e73)" }}>
                {stackTop}
                {componentStack ? `\n\n组件栈：${componentStack.split("\n").slice(0, 8).join("\n")}` : ""}
              </pre>
            </details>
          ) : null}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={this.handleRetry}
              style={{
                padding: "7px 18px",
                borderRadius: 8,
                border: "none",
                background: "var(--accent, #0a84ff)",
                color: "#fff",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              重试
            </button>
            <button
              onClick={this.handleReload}
              style={{
                padding: "7px 18px",
                borderRadius: 8,
                border: "1px solid var(--border, #d2d2d7)",
                background: "transparent",
                color: "var(--text-primary, #1d1d1f)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              重新加载应用
            </button>
          </div>
        </div>
      </div>
    );
  }
}
