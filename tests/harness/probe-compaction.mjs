#!/usr/bin/env node
/** TC-202 低阈值压缩验证：连发大消息让 token 压力突破压缩阈值，观测上游上下文回落。 */
import fs from 'node:fs';

const B = process.env.DSH_BASE || 'http://127.0.0.1:8912';
const FAKE = process.env.FAKE_LLM || 'http://127.0.0.1:8899';
const CHANNEL = fs.readFileSync('/tmp/dsh-e2e/channel.txt', 'utf8').trim();
const agentId = 'e2e-s2b-' + Date.now();

(async () => {
  const out = [];
  for (let i = 1; i <= 6; i += 1) {
    const res = await fetch(`${B}/api/agent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId,
        message: `压缩验证第 ${i} 轮：${'大段内容。'.repeat(400)}`,
        channelCode: CHANNEL,
        approvalMode: 'AUTO_APPROVE',
        cwd: '/tmp/dsh-e2e/ws',
      }),
    });
    const text = await res.text();
    const ok = text.includes('event:done');
    const st = await (await fetch(`${FAKE}/__stats`)).json();
    const last = st.requests.at(-1) || {};
    out.push({ round: i, upstreamChars: last.chars || 0, upstreamMsgs: last.messages || 0 });
    console.log(`轮 ${i}: done=${ok} 上游字符=${last.chars} 上游消息数=${last.messages}`);
  }
  const dropIdx = out.findIndex((r, i) => i > 0 && out[i - 1].upstreamChars > 5000 && r.upstreamChars < out[i - 1].upstreamChars * 0.8);
  if (dropIdx > 0) {
    console.log(`✓ 压缩在第 ${out[dropIdx].round} 轮触发（${out[dropIdx - 1].upstreamChars} → ${out[dropIdx].upstreamChars} 字符）`);
    process.exit(0);
  }
  console.log('✗ 未观察到压缩回落');
  process.exit(1);
})();
