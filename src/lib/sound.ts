// 对话完成提示音：纯 Web Audio API 合成，不依赖音频资源文件与系统命令，
// macOS(WKWebView) / Windows(WebView2) / Linux(WebKitGTK) 的 webview 均原生支持。
//
// 注意 webview 的自动播放策略：AudioContext 必须在用户手势（点击/按键）里创建或
// resume，否则完成时可能处于 suspended 状态而无声。因此用 unlockAudio 在首次
// 用户手势时提前解锁，playCompletionSound 只负责发声。

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!audioContext) audioContext = new Ctor();
    return audioContext;
  } catch {
    return null;
  }
}

/** 在用户手势事件（点击/键盘）里调用一次，提前解锁音频上下文。幂等。 */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") {
    void ctx.resume().catch(() => undefined);
  }
}

function tone(
  ctx: AudioContext,
  frequency: number,
  startOffset: number,
  duration: number,
  peakGain: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  const t0 = ctx.currentTime + startOffset;
  // 指数包络：快速起音 + 柔和衰减，避免爆音
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peakGain, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

/**
 * 播放对话完成提示音。
 * 成功：上行双音（E5 -> A5），轻快；失败：下行双音（A4 -> E4），低沉。
 * 任何异常都静默吞掉——提示音不允许影响主流程。
 */
export function playCompletionSound(failed = false): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
    if (failed) {
      tone(ctx, 440, 0, 0.18, 0.16);
      tone(ctx, 330, 0.16, 0.28, 0.14);
    } else {
      tone(ctx, 659.25, 0, 0.16, 0.16);
      tone(ctx, 880, 0.14, 0.3, 0.14);
    }
  } catch {
    // 静默失败
  }
}
