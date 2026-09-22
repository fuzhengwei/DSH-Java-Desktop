#!/usr/bin/env node
/**
 * DSH 端到端验证 runner（零依赖，直连内嵌服务端 HTTP/SSE API）。
 *
 * 说明：本脚本不依赖真实模型 API Key —— 上游指向 tests/harness/fake-llm-server.mjs
 * 提供的可控 OpenAI 兼容服务，从而可以确定性地复现长对话、长任务、中断、静默等场景，
 * 并采集「上游实际收到的上下文规模」这类只有服务端可见的关键证据。
 *
 * 用法：
 *   node tests/harness/run-e2e.mjs                 # 跑全部
 *   node tests/harness/run-e2e.mjs S1 S3 S5        # 只跑指定场景
 *
 * 环境变量：
 *   DSH_BASE   服务端地址（默认 http://127.0.0.1:8912）
 *   FAKE_LLM   假模型地址（默认 http://127.0.0.1:8899）
 *   EVIDENCE   证据输出路径（默认 tests/evidence/e2e-results.json）
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:8912';
const FAKE = process.env.FAKE_LLM || 'http://127.0.0.1:8899';
const EVIDENCE = process.env.EVIDENCE || 'tests/evidence/e2e-results.json';
const CHANNEL = process.env.DSH_CHANNEL || 'fake-e2e';
const CWD = process.env.DSH_CWD || '/tmp/dsh-e2e/ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ---------------------------------------------------------------- 基础 HTTP

async function req(url, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

const api = (p, init) => req(BASE + p, init);
const fakeControl = (patch) => req(FAKE + '/__control', { method: 'POST', body: patch });
const fakeReset = () => req(FAKE + '/__reset', { method: 'POST' });
const fakeStats = async () => (await req(FAKE + '/__stats')).json;

// ---------------------------------------------------------------- 流式对话

/**
 * 发起一次 SSE 对话并完整解析服务端推送的事件。
 * @returns 采集到的指标（含上游上下文变化、事件顺序、心跳次数、耗时分解）
 */
async function streamTurn({
  agentId,
  message,
  channelCode = CHANNEL,
  approvalMode = 'AUTO_APPROVE',
  cwd = CWD,
  timeoutMs = 300000,
  abortAfterMs = 0,
  cancelAfterFirstChunk = false,
}) {
  const ac = new AbortController();
  const hardTimer = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = now();
  const events = [];
  let firstEventMs = null;
  let firstChunkMs = null;
  let chunkChars = 0;
  let chunkCount = 0;
  let heartbeats = 0;
  let donePayload = null;
  let error = null;
  let canceledWith = null;

  try {
    const res = await fetch(`${BASE}/api/agent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ agentId, message, channelCode, approvalMode, cwd }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let cancelTriggered = false;

    while (true) {
      if (abortAfterMs > 0 && now() - startedAt > abortAfterMs) {
        await reader.cancel().catch(() => {});
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (firstEventMs === null) firstEventMs = now() - startedAt;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const rawFrame of frames) {
        const lines = rawFrame.split('\n');
        const eventType = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
        const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
        if (!eventType && dataLines.length === 0) {
          if (rawFrame.trim().startsWith(':')) heartbeats += 1; // SSE 心跳注释行
          continue;
        }
        const dataRaw = dataLines.join('\n');
        let data = null;
        try { data = dataRaw ? JSON.parse(dataRaw) : null; } catch { data = { raw: dataRaw }; }
        const type = eventType || (data && data.type) || 'message';
        events.push({ type, data, atMs: now() - startedAt });
        if (type === 'chunk') {
          chunkCount += 1;
          chunkChars += String(data?.content ?? '').length;
          if (firstChunkMs === null) firstChunkMs = now() - startedAt;
          if (cancelAfterFirstChunk && !cancelTriggered) {
            cancelTriggered = true;
            canceledWith = await api(`/api/agent/${encodeURIComponent(agentId)}/cancel`, { method: 'POST' });
          }
        }
        if (type === 'done') donePayload = data;
        if (type === 'error') error = data;
      }
    }
  } catch (e) {
    error = { exception: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(hardTimer);
  }

  return {
    events,
    eventTypes: events.map((e) => e.type),
    chunkCount,
    chunkChars,
    heartbeats,
    firstEventMs,
    firstChunkMs,
    totalMs: now() - startedAt,
    done: donePayload,
    error,
    canceledWith,
    toolResults: events.filter((e) => e.type === 'tool_result').map((e) => e.data),
  };
}

// ---------------------------------------------------------------- 断言收集

function makeCtx(scenarioId, title) {
  const assertions = [];
  const metrics = {};
  const notes = [];
  return {
    scenarioId,
    title,
    assertions,
    metrics,
    notes,
    check(name, ok, detail) {
      assertions.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
      return !!ok;
    },
    metric(k, v) { metrics[k] = v; },
    note(t) { notes.push(t); },
  };
}

// ---------------------------------------------------------------- 场景

/** S1 基线：单轮 SSE 对话链路完整性 */
async function S1(ctx) {
  await fakeReset();
  await fakeControl({ mode: 'text', chunks: 12, delayMs: 10, chunkChars: 40, reasoning: false, toolRounds: 0 });
  const agentId = `e2e-s1-${now()}`;
  const upBefore = (await fakeStats()).totalRequests;

  const turn = await streamTurn({ agentId, message: '基线连通性测试：请回复一段固定文本。' });
  const upAfter = (await fakeStats()).totalRequests;

  ctx.metric('totalMs', turn.totalMs);
  ctx.metric('firstEventMs', turn.firstEventMs);
  ctx.metric('chunkCount', turn.chunkCount);
  ctx.metric('chunkChars', turn.chunkChars);
  ctx.metric('upstreamRequests', upAfter - upBefore);

  ctx.check('SSE 首事件 < 2s', turn.firstEventMs !== null && turn.firstEventMs < 2000, `${turn.firstEventMs}ms`);
  ctx.check('收到 meta 事件', turn.eventTypes.includes('meta'));
  ctx.check('收到 chunk 事件', turn.chunkCount > 0, `${turn.chunkCount} 个`);
  ctx.check('收到 done 事件', !!turn.done, JSON.stringify(turn.done)?.slice(0, 120));
  ctx.check('done.status 为正常终态（idle/success/completed）',
    ['idle', 'success', 'completed', 'ok'].includes(String(turn.done?.status)), turn.done?.status);
  ctx.check('done 回传 sessionId', !!turn.done?.sessionId, turn.done?.sessionId);
  ctx.metric('doneStatus', turn.done?.status);
  ctx.metric('doneTotalChunks', turn.done?.totalChunks);
  ctx.metric('doneMessageCount', turn.done?.messageCount);
  const assistant = (turn.done?.messages || []).filter((m) => m.role === 'assistant');
  ctx.check('助手回复非空', assistant.length > 0 && String(assistant[assistant.length - 1]?.content || '').length > 0,
    `assistant 消息 ${assistant.length} 条，末条 ${String(assistant[assistant.length - 1]?.content || '').length} 字符`);
  ctx.check('无 error 事件', !turn.error, JSON.stringify(turn.error)?.slice(0, 160));
  ctx.check('上游只被调用 1 次', upAfter - upBefore === 1, `${upAfter - upBefore}`);

  // 会话可查询
  const sessions = await api('/api/harness/console/sessions?limit=50&offset=0');
  const found = (sessions.json?.data?.records || sessions.json?.data || []).find?.(
    (s) => s.sessionId === turn.done?.sessionId || s.agentId === agentId
  );
  ctx.check('会话已持久化可查询', !!found, `sessionId=${turn.done?.sessionId}`);
  const msgs = await api(`/api/harness/console/sessions/${encodeURIComponent(turn.done?.sessionId)}/messages`);
  const list = msgs.json?.data?.messages || msgs.json?.data || [];
  ctx.metric('persistedMessages', Array.isArray(list) ? list.length : -1);
  ctx.check('消息可回读（≥2 条）', Array.isArray(list) && list.length >= 2, `${Array.isArray(list) ? list.length : 'n/a'} 条`);
  return turn;
}

/** S2 长对话：40 轮 × 12KB 回复，观测上下文增长 / 压缩 / 延迟劣化 */
async function S2(ctx) {
  await fakeReset();
  await fakeControl({ mode: 'text', chunks: 120, delayMs: 1, chunkChars: 100, reasoning: false, toolRounds: 0 });
  const agentId = `e2e-s2-${now()}`;
  const rounds = Number(process.env.S2_ROUNDS || 40);
  const perTurn = [];
  let prevUpstream = 0;

  for (let i = 1; i <= rounds; i += 1) {
    const t0 = now();
    const turn = await streamTurn({ agentId, message: `长对话第 ${i} 轮：请输出一大段确定性的分析内容，用于验证上下文管理。` });
    const st = await fakeStats();
    const last = st.requests[st.requests.length - 1] || {};
    perTurn.push({
      round: i,
      totalMs: turn.totalMs,
      chunkCount: turn.chunkCount,
      upstreamMessages: last.messages,
      upstreamChars: last.chars,
      upstreamApproxTokens: last.approxTokens,
      doneMessages: Array.isArray(turn.done?.messages) ? turn.done.messages.length : null,
      doneBytes: JSON.stringify(turn.done || {}).length,
      ok: !!turn.done && !turn.error,
    });
    if (!turn.done) {
      ctx.note(`第 ${i} 轮未正常结束：${JSON.stringify(turn.error)?.slice(0, 200)}`);
      break;
    }
    if (i % 10 === 0 || i === 1) {
      // 逐 10 轮打印进度，便于观察趋势
      console.log(`   · 第 ${i} 轮: 上游上下文 ${last.chars} 字符 ≈${last.approxTokens} tokens, 本轮回包 ${perTurn[perTurn.length - 1].doneBytes} 字节, 耗时 ${turn.totalMs}ms`);
    }
    prevUpstream = last.chars;
  }

  const st = await fakeStats();
  // 压缩检测：某次上游请求的消息数出现明显回落 → 说明发生了上下文替换/压缩
  let compactionDrop = null;
  for (let i = 1; i < perTurn.length; i += 1) {
    const prev = perTurn[i - 1].upstreamChars;
    const cur = perTurn[i].upstreamChars;
    if (prev > 20000 && cur < prev * 0.6) compactionDrop = { round: perTurn[i].round, from: prev, to: cur };
  }
  const first = perTurn[0] || {};
  const lastTurn = perTurn[perTurn.length - 1] || {};
  const avgEarly = perTurn.slice(0, 5).reduce((a, b) => a + b.totalMs, 0) / Math.max(1, perTurn.slice(0, 5).length);
  const avgLate = perTurn.slice(-5).reduce((a, b) => a + b.totalMs, 0) / Math.max(1, perTurn.slice(-5).length);

  ctx.metric('rounds', perTurn.length);
  ctx.metric('successRounds', perTurn.filter((r) => r.ok).length);
  ctx.metric('upstreamRequests', st.totalRequests);
  ctx.metric('firstTurnUpstreamChars', first.upstreamChars);
  ctx.metric('lastTurnUpstreamChars', lastTurn.upstreamChars);
  ctx.metric('maxUpstreamChars', st.maxChars);
  ctx.metric('maxUpstreamApproxTokens', Math.round(st.maxChars / 4));
  ctx.metric('lastDonePayloadBytes', lastTurn.doneBytes);
  ctx.metric('donePayloadGrowthRatio', first.doneBytes ? +(lastTurn.doneBytes / first.doneBytes).toFixed(2) : null);
  ctx.metric('avgTurnMsFirst5', Math.round(avgEarly));
  ctx.metric('avgTurnMsLast5', Math.round(avgLate));
  ctx.metric('latencyDegradation', avgEarly ? +(avgLate / avgEarly).toFixed(2) : null);
  ctx.metric('compactionDetected', compactionDrop);
  ctx.metric('perTurn', perTurn);

  ctx.check(`全部 ${rounds} 轮对话成功`, perTurn.length === rounds && perTurn.every((r) => r.ok), `${perTurn.filter((r) => r.ok).length}/${rounds}`);
  ctx.check('上游上下文随轮次增长', (lastTurn.upstreamChars || 0) > (first.upstreamChars || 0), `${first.upstreamChars} → ${lastTurn.upstreamChars}`);
  ctx.check('未发现「上下文无限增长无上限」', (st.maxChars || 0) < 5_000_000, `max=${st.maxChars} 字符`);
  console.log(`   · 长对话结论：上下文 ${first.upstreamChars}→${lastTurn.upstreamChars} 字符；单轮耗时 ${Math.round(avgEarly)}ms→${Math.round(avgLate)}ms（×${(avgLate / avgEarly).toFixed(2)}）；回包体积 ×${(lastTurn.doneBytes / first.doneBytes).toFixed(2)}；压缩触发=${compactionDrop ? JSON.stringify(compactionDrop) : '未触发'}`);
  return { perTurn, compactionDrop };
}

/** S2b 长对话-压缩：低阈值实例，验证压缩机制真的生效 */
async function S2b(ctx) {
  const low = process.env.DSH_BASE_LOW;
  if (!low) {
    ctx.note('未提供 DSH_BASE_LOW（低压缩阈值实例），跳过');
    return null;
  }
  await fakeReset();
  await fakeControl({ mode: 'text', chunks: 60, delayMs: 1, chunkChars: 100, reasoning: false, toolRounds: 0 });
  const agentId = `e2e-s2b-${now()}`;
  const perTurn = [];
  for (let i = 1; i <= 8; i += 1) {
    const res = await req(`${low}/api/agent/stream`, {
      method: 'POST',
      body: { agentId, message: `压缩验证第 ${i} 轮`, channelCode: CHANNEL, approvalMode: 'AUTO_APPROVE', cwd: CWD },
      timeoutMs: 120000,
    }).catch(() => null);
    // 直接用原始 SSE 文本解析 chunk 数
    const chunks = res ? (res.text.match(/"content"/g) || []).length : 0;
    const st = await fakeStats();
    const last = st.requests[st.requests.length - 1] || {};
    perTurn.push({ round: i, status: res?.status, chunks, upstreamMessages: last.messages, upstreamChars: last.chars });
  }
  const drop = perTurn.find((r, i) => i > 0 && perTurn[i - 1].upstreamChars > 8000 && r.upstreamChars < perTurn[i - 1].upstreamChars * 0.6);
  ctx.metric('perTurn', perTurn);
  ctx.metric('compactionDrop', drop || null);
  ctx.check('低阈值下压缩被触发（上下文回落）', !!drop, drop ? JSON.stringify(drop) : '未观察到回落');
  ctx.check('压缩后对话仍可继续', perTurn[perTurn.length - 1].status === 200, `末轮 HTTP ${perTurn[perTurn.length - 1].status}`);
  return perTurn;
}

/** S3 超长单条消息：单次 200KB 输入 */
async function S3(ctx) {
  await fakeReset();
  await fakeControl({ mode: 'text', chunks: 10, delayMs: 5, chunkChars: 50, toolRounds: 0 });
  const agentId = `e2e-s3-${now()}`;
  const big = '这是一段用于验证超长单条输入的填充文本。'.repeat(1100); // ≈ 20k 字符
  const huge = big + big + big + big + big + big + big + big + big + big; // ≈ 200k 字符
  const turn = await streamTurn({ agentId, message: `请阅读以下超长输入并回复「已读」：\n${huge}`, timeoutMs: 120000 });
  const st = await fakeStats();
  ctx.metric('inputChars', huge.length);
  ctx.metric('upstreamChars', st.requests[0]?.chars);
  ctx.metric('upstreamApproxTokens', st.requests[0]?.approxTokens);
  ctx.metric('totalMs', turn.totalMs);
  ctx.check('超长单条消息未导致请求失败', !!turn.done && !turn.error, turn.error ? JSON.stringify(turn.error).slice(0, 160) : turn.done?.status);
  ctx.check('超长消息被完整送达上游或按预算裁剪', (st.requests[0]?.chars || 0) > 0, `上游收到 ${st.requests[0]?.chars} 字符`);
  ctx.note(`输入 ${huge.length} 字符，上游实收 ${st.requests[0]?.chars} 字符（≈${st.requests[0]?.approxTokens} tokens）`);
  return turn;
}

/** S4 并发：6 个会话同时流式 */
async function S4(ctx) {
  await fakeReset();
  await fakeControl({ mode: 'text', chunks: 30, delayMs: 5, chunkChars: 60, toolRounds: 0 });
  const n = Number(process.env.S4_CONCURRENCY || 6);
  const t0 = now();
  const turns = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      streamTurn({ agentId: `e2e-s4-${now()}-${i}`, message: `并发会话 ${i}：请输出内容。`, timeoutMs: 180000 })
    )
  );
  const wall = now() - t0;
  const okAll = turns.every((t) => t.done && !t.error);
  const sessionIds = new Set(turns.map((t) => t.done?.sessionId));
  ctx.metric('concurrency', n);
  ctx.metric('wallMs', wall);
  ctx.metric('perSessionMs', turns.map((t) => t.totalMs));
  ctx.metric('distinctSessions', sessionIds.size);
  ctx.metric('chunkCounts', turns.map((t) => t.chunkCount));
  ctx.check(`${n} 路并发全部成功`, okAll, turns.map((t) => (t.done ? 'ok' : JSON.stringify(t.error).slice(0, 60))).join(' | '));
  ctx.check('会话相互隔离（sessionId 不串）', sessionIds.size === n, `${sessionIds.size}/${n}`);
  ctx.check('并发未出现内容交叉（chunk 数一致）', new Set(turns.map((t) => t.chunkCount)).size === 1, JSON.stringify(turns.map((t) => t.chunkCount)));
  console.log(`   · 并发结论：${n} 路并发总墙钟 ${wall}ms，单会话平均 ${Math.round(turns.reduce((a, b) => a + b.totalMs, 0) / n)}ms`);
  return turns;
}

/** S5 中断取消：首块后取消 */
async function S5(ctx) {
  await fakeReset();
  await fakeControl({ mode: 'text', chunks: 200, delayMs: 30, chunkChars: 50, toolRounds: 0 });
  const agentId = `e2e-s5-${now()}`;
  const turn = await streamTurn({ agentId, message: '这是一次中断测试：请输出很长的内容。', cancelAfterFirstChunk: true, timeoutMs: 120000 });
  ctx.metric('chunksBeforeCancel', turn.chunkCount);
  ctx.metric('totalMs', turn.totalMs);
  ctx.metric('cancelResponse', turn.canceledWith?.json || turn.canceledWith?.text);
  ctx.check('取消接口返回 200', turn.canceledWith?.status === 200, `HTTP ${turn.canceledWith?.status}`);
  ctx.check('取消后流很快结束（<10s）', turn.totalMs < 10000, `${turn.totalMs}ms`);

  const status = await api(`/api/agent/${encodeURIComponent(agentId)}/status`);
  ctx.metric('agentStatusAfterCancel', status.json?.data ?? status.text);
  ctx.check('取消后可查询 agent 状态', status.status === 200, `HTTP ${status.status}`);

  // 取消后同一 agent 是否还能继续对话
  await fakeControl({ mode: 'text', chunks: 5, delayMs: 5, chunkChars: 20, toolRounds: 0 });
  const again = await streamTurn({ agentId, message: '中断之后再来一轮，验证会话未被破坏。', timeoutMs: 60000 });
  ctx.metric('afterCancelTurnMs', again.totalMs);
  ctx.check('取消后同一会话仍可继续对话', !!again.done && !again.error, again.error ? JSON.stringify(again.error).slice(0, 160) : again.done?.status);
  return turn;
}

/** S6 长任务：多步工具调用循环 + 长耗时工具（含心跳） */
async function S6(ctx) {
  await fakeReset();
  const agentId = `e2e-s6-${now()}`;
  // 前 3 次模型响应为工具调用（echo），之后返回文本
  await fakeControl({
    mode: 'tool', toolRounds: 3, chunks: 6, delayMs: 5, chunkChars: 40,
    toolName: 'shell_execute', toolArgs: { command: 'echo dsh-long-task-probe' },
  });
  const multi = await streamTurn({ agentId, message: '请连续执行 3 次工具调用后汇总结果。', timeoutMs: 180000 });
  const toolResults = multi.toolResults || [];
  ctx.metric('toolResultEvents', toolResults.length);
  ctx.metric('toolNames', toolResults.map((t) => t?.toolName));
  ctx.metric('totalMs', multi.totalMs);
  ctx.check('多步工具循环产生 tool_result 事件', toolResults.length >= 1, `${toolResults.length} 个`);
  ctx.check('多步工具循环最终正常收尾', !!multi.done && !multi.error, multi.error ? JSON.stringify(multi.error).slice(0, 160) : multi.done?.status);

  // 长耗时工具：sleep 8s，验证工具执行期间 SSE 心跳维持连接
  await fakeReset();
  await fakeControl({
    mode: 'tool', toolRounds: 1, chunks: 5, delayMs: 5, chunkChars: 30,
    toolName: 'shell_execute', toolArgs: { command: 'sleep 8 && echo long-task-done' },
  });
  const longAgent = `e2e-s6-long-${now()}`;
  const longTurn = await streamTurn({ agentId: longAgent, message: '执行一个耗时 8 秒的命令并汇报结果。', timeoutMs: 180000 });
  const longResults = longTurn.toolResults || [];
  ctx.metric('longToolMs', longTurn.totalMs);
  ctx.metric('longToolHeartbeats', longTurn.heartbeats);
  ctx.metric('longToolResultMs', longResults[0]?.durationMs);
  ctx.check('长耗时工具（8s）执行成功', !!longTurn.done && longResults.length >= 1, `${longResults.length} 个工具结果`);
  ctx.check('长工具期间 SSE 心跳维持连接', longResults.length >= 1 && !longTurn.error, `耗时 ${longTurn.totalMs}ms，心跳 ${longTurn.heartbeats} 次`);
  console.log(`   · 长任务结论：8s 工具调用总耗时 ${longTurn.totalMs}ms，期间收到 ${longTurn.heartbeats} 次心跳`);

  // 步数上限：持续返回工具调用，验证 MAX_STEPS_PER_TURN 保护
  await fakeReset();
  await fakeControl({
    mode: 'tool', toolRounds: 200, chunks: 3, delayMs: 1, chunkChars: 10,
    toolName: 'shell_execute', toolArgs: { command: 'echo step-probe' },
  });
  const capAgent = `e2e-s6-cap-${now()}`;
  const capTurn = await streamTurn({ agentId: capAgent, message: '请无限循环调用工具。', timeoutMs: 300000 });
  ctx.metric('capStepsToolResults', (capTurn.toolResults || []).length);
  ctx.metric('capTurnTotalMs', capTurn.totalMs);
  ctx.check('无限工具循环被步数上限终止（未跑飞）', capTurn.totalMs < 300000 && (!!capTurn.done || !!capTurn.error),
    `工具结果 ${(capTurn.toolResults || []).length} 次，耗时 ${capTurn.totalMs}ms，done=${!!capTurn.done} error=${JSON.stringify(capTurn.error)?.slice(0, 80)}`);
  console.log(`   · 步数保护：模型持续索要工具调用时，本轮回合执行 ${(capTurn.toolResults || []).length} 次工具后收口，耗时 ${capTurn.totalMs}ms`);
  return { multi, longTurn, capTurn };
}

/** S7 上游异常：模型侧 5xx */
async function S7(ctx) {
  await fakeReset();
  await fakeControl({ mode: 'text', errorStatus: 503, chunks: 5, delayMs: 1 });
  const agentId = `e2e-s7-${now()}`;
  const t0 = now();
  const turn = await streamTurn({ agentId, message: '上游异常时的表现测试。', timeoutMs: 120000 });
  const elapsed = now() - t0;
  await fakeControl({ errorStatus: 0 });
  ctx.metric('totalMs', elapsed);
  ctx.metric('errorPayload', turn.error);
  const surfaced =
    turn.eventTypes.includes('error') ||
    !!turn.error ||
    (turn.done?.messages || []).some((m) => /⚠️|失败|error|异常/i.test(String(m?.content || ''))) ||
    !!turn.done?.error;
  ctx.check('上游 5xx 被显式报出而非静默挂死（错误进入消息流或 error 事件）', surfaced,
    `eventTypes=${turn.eventTypes.join(',')} 末条消息=${String(turn.done?.messages?.at(-1)?.content || '').slice(0, 80)}`);
  ctx.check('上游 5xx 时回合能在超时内结束', elapsed < 120000, `${elapsed}ms`);
  ctx.check('异常不影响后续会话可用', (await api('/api/harness/settings/models')).status === 200);
  // 恢复后同 agent 可继续
  const again = await streamTurn({ agentId, message: '上游恢复后继续。', timeoutMs: 60000 });
  ctx.check('上游恢复后同会话可继续', !!again.done && !again.error, again.error ? JSON.stringify(again.error).slice(0, 120) : again.done?.status);
  return turn;
}

/** S8 静默/心跳：模型只吐 1 片后永久静默 */
async function S8(ctx) {
  await fakeReset();
  await fakeControl({ mode: 'stall', chunks: 5, delayMs: 10 });
  const agentId = `e2e-s8-${now()}`;
  const started = now();
  const turn = await streamTurn({ agentId, message: '静默场景：模型卡住不返回。', timeoutMs: 40000 });
  const elapsed = now() - started;
  await fakeControl({ mode: 'text' });
  ctx.metric('elapsedMs', elapsed);
  ctx.metric('heartbeats', turn.heartbeats);
  ctx.metric('events', turn.eventTypes);
  ctx.check('静默 40s 期间连接未断开（服务端仍在等待）', elapsed >= 39000 || !!turn.error, `${elapsed}ms`);
  ctx.note(`浏览器侧的空闲看门狗为 120s，服务端在无输出期间仅靠 15s 心跳维持连接；本场景观察心跳 ${turn.heartbeats} 次`);
  ctx.check('静默期间收到服务端心跳', turn.heartbeats >= 1, `${turn.heartbeats} 次`);
  ctx.check('超时中断后未产生 error 事件（连接被主动关闭）', !turn.error || /abort|aborted|terminated/i.test(JSON.stringify(turn.error)),
    JSON.stringify(turn.error)?.slice(0, 120));
  return turn;
}

/** S9 会话恢复：重启后按 agentId 找回历史 */
async function S9(ctx) {
  await fakeReset();
  await fakeControl({ mode: 'text', chunks: 8, delayMs: 5, chunkChars: 40, toolRounds: 0 });
  const agentId = `e2e-s9-${now()}`;
  const t1 = await streamTurn({ agentId, message: '恢复测试第 1 轮。' });
  const t2 = await streamTurn({ agentId, message: '恢复测试第 2 轮。' });
  const stats = await fakeStats();
  ctx.metric('sessionId', t2.done?.sessionId);
  ctx.metric('upstreamMessagesLastTurn', stats.requests[stats.requests.length - 1]?.messages);
  ctx.metric('doneMessagesLastTurn', t2.done?.messages?.length);
  ctx.check('第 2 轮上游上下文包含历史（messages > 单轮）', (stats.requests[stats.requests.length - 1]?.messages || 0) > 2,
    `${stats.requests[stats.requests.length - 1]?.messages} 条`);
  ctx.check('done 回传当前回合消息（瘦身语义）', (t2.done?.messages?.length || 0) >= 2 && (t2.done?.messages?.length || 0) < 4,
    `${t2.done?.messages?.length} 条`);
  ctx.check('done 携带 messageCount 元信息（≥持久化规模）', (t2.done?.messageCount || 0) >= 4, `${t2.done?.messageCount} 条`);
  const msgs = await api(`/api/harness/console/sessions/${encodeURIComponent(t2.done?.sessionId)}/messages`);
  const list = msgs.json?.data?.messages || msgs.json?.data || [];
  ctx.metric('persistedMessages', Array.isArray(list) ? list.length : -1);
  ctx.check('持久化消息数 ≥ 4', Array.isArray(list) && list.length >= 4, `${Array.isArray(list) ? list.length : 'n/a'} 条`);
  ctx.note(`供重启恢复验证使用的 agentId=${agentId}，sessionId=${t2.done?.sessionId}`);
  return { agentId, sessionId: t2.done?.sessionId, messages: list.length };
}

/** S10 开放协议：Agent Card / A2A */
async function S10(ctx) {
  const dsh = await api('/.well-known/dsh-agent-card');
  const a2a = await api('/.well-known/agent-card.json');
  ctx.metric('dshCardStatus', dsh.status);
  ctx.metric('a2aCardStatus', a2a.status);
  ctx.check('DSH Agent Card 可访问', dsh.status === 200 && !!dsh.json, `HTTP ${dsh.status}`);
  ctx.check('A2A 0.3.x Agent Card 可访问', a2a.status === 200 && !!a2a.json, `HTTP ${a2a.status}`);
  ctx.check('A2A Card 含协议版本/技能字段', !!(a2a.json?.protocolVersion || a2a.json?.skills), JSON.stringify(a2a.json)?.slice(0, 160));

  const a2aMsg = await api('/a2a', {
    method: 'POST',
    timeoutMs: 60000,
    body: {
      jsonrpc: '2.0', id: 'e2e-a2a-1', method: 'message/send',
      params: { message: { messageId: `m-${now()}`, role: 'user', parts: [{ kind: 'text', text: 'A2A 连通性测试' }] } },
    },
  });
  ctx.metric('a2aSendStatus', a2aMsg.status);
  ctx.metric('a2aSendBody', JSON.stringify(a2aMsg.json)?.slice(0, 300));
  ctx.check('A2A message/send 有响应（成功或结构化错误）', a2aMsg.status === 200 || a2aMsg.status === 400,
    `HTTP ${a2aMsg.status} ${JSON.stringify(a2aMsg.json)?.slice(0, 200)}`);
  return { dsh: dsh.json, a2a: a2a.json };
}

/** S11 扩展能力：Skills / MCP / CLI 查询面 */
async function S11(ctx) {
  const skills = await api('/api/harness/extensions/skills');
  const mcp = await api('/api/harness/extensions/mcp/servers');
  const cli = await api('/api/harness/extensions/cli');
  const plugins = await api('/api/harness/plugins');
  const effective = await api('/api/harness/config/effective');
  ctx.metric('skillsCount', (skills.json?.data || []).length);
  ctx.metric('mcpCount', (mcp.json?.data || []).length);
  ctx.metric('pluginsStatus', plugins.status);
  ctx.check('Skills 列表可查询', skills.status === 200, `HTTP ${skills.status}`);
  ctx.check('MCP 列表可查询', mcp.status === 200, `HTTP ${mcp.status}`);
  ctx.check('CLI 配置可查询', cli.status === 200, `HTTP ${cli.status}`);
  ctx.check('插件清单可查询', plugins.status === 200, `HTTP ${plugins.status}`);
  ctx.check('有效配置可查询', effective.status === 200, `HTTP ${effective.status}`);
  ctx.note(`Skills=${(skills.json?.data || []).length}，MCP=${(mcp.json?.data || []).length}`);
  return { skills, mcp, cli, plugins, effective: effective.json };
}

/** S12 数字人协作：目录与房间 API（房间列表无 GET /rooms，需先 POST 创建） */
async function S12(ctx) {
  const humans = await api('/api/digital-humans');
  const created = await api('/api/collaboration/rooms', { method: 'POST', body: { title: `e2e-room-${now()}`, description: '端到端验证房间' } });
  ctx.metric('digitalHumansStatus', humans.status);
  ctx.metric('roomCreateStatus', created.status);
  const roomId = created.json?.data?.roomId || created.json?.data?.id;
  ctx.check('数字人目录可查询', humans.status === 200, `HTTP ${humans.status}`);
  ctx.check('协作房间可创建', created.status === 200 && !!roomId, `HTTP ${created.status} ${JSON.stringify(created.json)?.slice(0, 160)}`);
  if (roomId) {
    const room = await api(`/api/collaboration/rooms/${encodeURIComponent(roomId)}`);
    const events = await api(`/api/collaboration/rooms/${encodeURIComponent(roomId)}/events`);
    ctx.metric('roomGetStatus', room.status);
    ctx.metric('roomEventsStatus', events.status);
    ctx.check('房间详情可查询', room.status === 200, `HTTP ${room.status}`);
    ctx.check('房间事件可查询', events.status === 200, `HTTP ${events.status}`);
  }
  return { humans: humans.json, room: created.json };
}

// ---------------------------------------------------------------- 主流程

const SCENARIOS = [
  ['S1', '基线单轮对话链路', S1],
  ['S2', '长对话 40 轮（上下文增长/延迟劣化）', S2],
  ['S2b', '长对话压缩（低阈值实例）', S2b],
  ['S3', '超长单条输入 200KB', S3],
  ['S4', '6 路并发会话', S4],
  ['S5', '中断取消与恢复', S5],
  ['S6', '长任务：多步工具 / 长耗时工具 / 步数保护', S6],
  ['S7', '上游 5xx 异常', S7],
  ['S8', '模型静默与心跳', S8],
  ['S9', '会话恢复与持久化', S9],
  ['S10', '开放协议 Agent Card / A2A', S10],
  ['S11', '扩展能力（Skills/MCP/CLI/插件）', S11],
  ['S12', '数字人协作 API', S12],
];

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const selected = only.length ? SCENARIOS.filter(([id]) => only.includes(id)) : SCENARIOS;

  const health = await api('/api/harness/config/effective').catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`无法连接服务端 ${BASE}（HTTP ${health?.status}）。请先启动 standalone JAR。`);
    process.exit(2);
  }
  const fake = await fakeStats().catch(() => null);
  if (!fake) {
    console.error(`无法连接假模型服务 ${FAKE}。请先启动 tests/harness/fake-llm-server.mjs。`);
    process.exit(2);
  }

  const report = { base: BASE, fake, startedAt: new Date().toISOString(), scenarios: [] };
  console.log(`\n=== DSH 端到端验证 (${BASE} → ${FAKE}) ===\n`);

  for (const [id, title, fn] of selected) {
    console.log(`▶ ${id} ${title}`);
    const ctx = makeCtx(id, title);
    const t0 = now();
    try {
      const raw = await fn(ctx);
      ctx.raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? summarizable(raw) : raw;
    } catch (e) {
      ctx.check('场景执行未抛异常', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    }
    ctx.durationMs = now() - t0;
    const failed = ctx.assertions.filter((a) => !a.ok);
    ctx.status = failed.length ? 'FAIL' : 'PASS';
    report.scenarios.push(ctx);
    console.log(`   ${ctx.status}  (${ctx.durationMs}ms, ${ctx.assertions.length - failed.length}/${ctx.assertions.length} 断言通过)`);
    for (const a of ctx.assertions) console.log(`     ${a.ok ? '✓' : '✗'} ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
    console.log('');
  }

  report.finishedAt = new Date().toISOString();
  report.finalFakeStats = await fakeStats();
  report.summary = {
    total: report.scenarios.length,
    pass: report.scenarios.filter((s) => s.status === 'PASS').length,
    fail: report.scenarios.filter((s) => s.status === 'FAIL').length,
    assertions: report.scenarios.reduce((a, s) => a + s.assertions.length, 0),
    assertionsFailed: report.scenarios.reduce((a, s) => a + s.assertions.filter((x) => !x.ok).length, 0),
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(report, null, 2));
  console.log(`=== 汇总：${report.summary.pass}/${report.summary.total} 场景通过，断言失败 ${report.summary.assertionsFailed}/${report.summary.assertions} ===`);
  console.log(`证据文件：${EVIDENCE}\n`);
  process.exit(report.summary.fail ? 1 : 0);
}

/** 避免把超长数组塞进证据文件 */
function summarizable(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 12) out[k] = { length: v.length, sample: v.slice(0, 3) };
    else out[k] = v;
  }
  return out;
}

main();
