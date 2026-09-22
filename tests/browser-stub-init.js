// 纯浏览器验证用：伪造 Tauri invoke（agent_status 等）+ 拦截 window.fetch 伪造本地 API
// 用法：agent-browser open http://localhost:1420 --init-script tests/browser-stub-init.js
(function () {
  if (window.__stubbedTauri) return;
  window.__stubbedTauri = true;

  const now = Date.now();
  const iso = (offsetMs) => new Date(now - offsetMs).toISOString();
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  const sessions = [
    { agentId: "agent-1", sessionId: "sess-1", title: "实现侧边栏收起与搜索", lastMessage: "收起按钮已加到 brand 行", updatedAt: iso(0.5 * HOUR), createdAt: iso(2 * HOUR), workspaceId: "default" },
    { agentId: "agent-2", sessionId: "sess-2", title: "优化字体颜色与工具栏布局", lastMessage: "对比了几种配色方案", updatedAt: iso(5 * HOUR), createdAt: iso(26 * HOUR), workspaceId: "default" },
    { agentId: "agent-3", sessionId: "sess-3", title: "编写测试用例并对比结果", lastMessage: "已补充 E2E 用例", updatedAt: iso(2 * DAY), createdAt: iso(3 * DAY), workspaceId: "default" },
    { agentId: "agent-4", sessionId: "sess-4", title: "排查 SSE 心跳断连问题", lastMessage: "定位到 NAT 超时", updatedAt: iso(10 * DAY), createdAt: iso(11 * DAY), workspaceId: "default" },
    { agentId: "agent-5", sessionId: "sess-5", title: "接入 ask_user_question 链路", lastMessage: "前端轮询已打通", updatedAt: iso(40 * DAY), createdAt: iso(41 * DAY), workspaceId: "default" },
  ];

  const workspaces = [
    { name: "DSH-Java-Desktop", path: "/Users/fuzhengwei/DevOps/DSH-Java-Desktop" },
    { name: "mall-admin", path: "/Users/fuzhengwei/DevOps/mall-admin" },
  ];

  const modelSetting = [{
    channelCode: "default", displayName: "Fake LLM", providerCode: "openai",
    modelCode: "fake-model", baseUrl: "http://127.0.0.1:9/v1", protocol: "openai",
    enabled: true, active: true, updatedAt: iso(HOUR),
  }];

  function apiData(path) {
    if (path.startsWith("/api/harness/console/sessions")) return sessions;
    if (path.startsWith("/api/harness/console/sessions/") && path.endsWith("/messages")) return { messages: [] };
    if (path === "/api/agent/workspaces") return workspaces;
    if (path === "/api/harness/settings/models") return modelSetting;
    if (path === "/api/harness/runtime/models") return [{ channelCode: "default", displayName: "Fake LLM", providerCode: "openai", modelCode: "fake-model" }];
    if (path === "/api/harness/channels/presets") return [];
    if (path.includes("/approvals/runtime/pending")) return [];
    if (path.includes("/questions/runtime/pending")) return [];
    if (path.includes("/extensions/")) return [];
    if (path.includes("/plugins")) return [];
    if (path.includes("digital-human") || path.includes("/humans")) return [];
    if (path.includes("/room")) return {};
    if (path.includes("config/effective") || path.includes("actuator") || path.includes("health")) return { status: "UP" };
    return [];
  }

  // ── 拦截 window.fetch：本地后端端口一律返回假数据（dev server 1420 放行） ──
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const parsed = new URL(url, location.href);
      const isLocal = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
      const isDevServer = parsed.port === location.port;
      if (isLocal && !isDevServer && /^https?:/.test(parsed.protocol)) {
        const path = parsed.pathname + parsed.search;
        const body = JSON.stringify({ code: "00000", info: "ok", data: apiData(path) });
        return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
      }
    } catch {
      // 解析失败走原生
    }
    return realFetch(input, init);
  };

  // ── 伪造 Tauri invoke ──
  const agentState = () => ({
    status: "running", port: 51733, jarPath: "/fake/agent.jar", message: "",
    runtimeStatus: "ready", runtimeSource: "bundled", javaPath: "/fake/java", javaVersion: "17", apiKey: null,
  });

  function handleInvoke(cmd) {
    if (cmd === "agent_status" || cmd === "start_agent" || cmd === "stop_agent") return agentState();
    if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten") return 1;
    if (cmd === "project_git_branches" || cmd === "switch_project_git_branch") return { current: "main", branches: ["main"] };
    if (cmd === "pick_local_directory" || cmd === "pick_local_file") return null;
    return null;
  }

  const internals = {
    invoke: (cmd) => {
      try {
        return Promise.resolve(handleInvoke(cmd));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    transformCallback: (callback) => {
      if (typeof callback === "function") {
        const id = Math.floor(Math.random() * 1e9);
        window[`_${id}`] = callback;
        return id;
      }
      return callback;
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };

  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: internals, configurable: false });
  Object.defineProperty(window, "__TAURI_OS_PLUGIN_INTERNALS__", { value: internals, configurable: true });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: {
      listeners: new Map(),
      registerListener(event, handler) { return { event, id: 1, handler }; },
      unregisterListener() { /* no-op */ },
    },
    configurable: true,
  });
})();
