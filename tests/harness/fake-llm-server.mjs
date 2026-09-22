#!/usr/bin/env node
/**
 * 可控的 OpenAI 兼容假模型服务（零依赖）。
 *
 * 用途：脱开真实模型 API Key，确定性地复现「长对话 / 长任务 / 流式异常」场景。
 * 服务端 (deepseek-harness-java) 的 OpenAiCompatibleAdapter 会 POST {baseUrl}/chat/completions，
 * 本服务按控制面配置生成 SSE 流，并完整记录每一次上游请求的上下文规模。
 *
 * 控制面：
 *   POST /__control  { mode, chunks, delayMs, chunkChars, reasoning, toolRounds, toolName, toolArgs, stallAfterFirst, errorStatus }
 *   GET  /__stats    上游请求记录（messages 条数 / 字符数 / 估算 token / tools 数量 / 耗时）
 *   POST /__reset    清空统计
 *
 * 模型面：
 *   GET  /v1/models              → { data: [{ id }] }
 *   POST /v1/chat/completions    → SSE / JSON
 */
import http from 'node:http';

const PORT = Number(process.env.FAKE_LLM_PORT || 8899);

/** @type {any} */
let cfg = {
  mode: 'text',            // text | tool | stall | error | slow-first
  modelId: 'fake-dsh-model',
  chunks: 12,              // 文本模式下分片数
  delayMs: 15,             // 每分片延迟
  chunkChars: 40,          // 每分片字符数
  firstByteDelayMs: 0,     // 首字节前延迟（模拟长思考）
  reasoning: false,        // 是否先吐 reasoning_content
  reasoningChunks: 4,
  toolRounds: 0,           // 前 N 次请求返回 tool_calls
  toolName: 'shell_execute',
  toolArgs: { command: 'echo dsh-harness-long-task-probe' },
  stallAfterFirst: false,  // 只发 1 片后永久静默（测空闲看门狗/心跳）
  errorStatus: 0,          // >0 时直接返回该 HTTP 状态码
};

const stats = {
  startedAt: Date.now(),
  requests: [],
  totalRequests: 0,
  maxMessages: 0,
  maxChars: 0,
  maxTools: 0,
};

const textOf = (i, total) => {
  const base = `[chunk-${i + 1}/${total}] 收到，这是第 ${i + 1} 段确定性回复内容。`;
  if (base.length >= cfg.chunkChars) return base.slice(0, cfg.chunkChars);
  return base + '。'.repeat(cfg.chunkChars - base.length);
};

const readJson = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ __raw: raw });
      }
    });
  });

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/__control' && req.method === 'POST') {
    const patch = await readJson(req);
    cfg = { ...cfg, ...patch };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cfg }));
    return;
  }

  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...stats, cfg }));
    return;
  }

  if (url.pathname === '/__reset') {
    stats.requests = [];
    stats.totalRequests = 0;
    stats.maxMessages = 0;
    stats.maxChars = 0;
    stats.maxTools = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: cfg.modelId, object: 'model' }] }));
    return;
  }

  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    const body = await readJson(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const chars = JSON.stringify(messages).length;
    const record = {
      seq: stats.totalRequests + 1,
      at: Date.now(),
      model: body.model,
      stream: !!body.stream,
      messages: messages.length,
      chars,
      approxTokens: Math.round(chars / 4),
      tools: tools.length,
      systemChars: messages.filter((m) => m.role === 'system').map((m) => String(m.content || '').length).reduce((a, b) => a + b, 0),
      roles: messages.map((m) => m.role).join(','),
    };
    stats.requests.push(record);
    stats.totalRequests += 1;
    stats.maxMessages = Math.max(stats.maxMessages, record.messages);
    stats.maxChars = Math.max(stats.maxChars, record.chars);
    stats.maxTools = Math.max(stats.maxTools, tools.length);

    if (cfg.errorStatus > 0) {
      res.writeHead(cfg.errorStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `fake upstream error ${cfg.errorStatus}`, type: 'fake_error' } }));
      return;
    }

    if (cfg.firstByteDelayMs > 0) await sleep(cfg.firstByteDelayMs);

    const useTool = cfg.mode === 'tool' && record.seq <= cfg.toolRounds;
    const id = `chatcmpl-fake-${record.seq}`;
    const created = Math.floor(Date.now() / 1000);

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model: body.model || cfg.modelId,
          choices: [
            useTool
              ? {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: `call_fake_${record.seq}`,
                        type: 'function',
                        function: { name: cfg.toolName, arguments: JSON.stringify(cfg.toolArgs) },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                }
              : { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: record.approxTokens, completion_tokens: 8, total_tokens: record.approxTokens + 8 },
        })
      );
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (cfg.mode === 'stall') {
      sse(res, {
        id, object: 'chat.completion.chunk', created, model: body.model || cfg.modelId,
        choices: [{ index: 0, delta: { role: 'assistant', content: '[stall]' }, finish_reason: null }],
      });
      return; // 之后永久静默，连接不关
    }

    if (cfg.reasoning) {
      for (let i = 0; i < cfg.reasoningChunks; i += 1) {
        sse(res, {
          id, object: 'chat.completion.chunk', created, model: body.model || cfg.modelId,
          choices: [{ index: 0, delta: { reasoning_content: `思考片段${i + 1} ` }, finish_reason: null }],
        });
        await sleep(cfg.delayMs);
      }
    }

    if (useTool) {
      sse(res, {
        id, object: 'chat.completion.chunk', created, model: body.model || cfg.modelId,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_fake_${record.seq}`,
                  type: 'function',
                  function: { name: cfg.toolName, arguments: JSON.stringify(cfg.toolArgs) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      await sleep(cfg.delayMs);
      sse(res, {
        id, object: 'chat.completion.chunk', created, model: body.model || cfg.modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const total = cfg.chunks;
    for (let i = 0; i < total; i += 1) {
      if (cfg.stallAfterFirst && i >= 1) return; // 静默挂住
      sse(res, {
        id, object: 'chat.completion.chunk', created, model: body.model || cfg.modelId,
        choices: [{ index: 0, delta: { content: textOf(i, total) }, finish_reason: null }],
      });
      await sleep(cfg.delayMs);
    }
    sse(res, {
      id, object: 'chat.completion.chunk', created, model: body.model || cfg.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-llm] listening on http://127.0.0.1:${PORT}`);
});
