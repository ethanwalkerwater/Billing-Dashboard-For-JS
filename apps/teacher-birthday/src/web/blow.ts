/** 麦克风音量持续高于阈值约 0.3 秒视为吹气；没有权限（飞书内置浏览器常见）时长按 1 秒兜底。两者都可用。 */
export function listenForBlow(target: HTMLElement, onBlow: () => void): () => void {
  let done = false;
  let stopMic = () => {};
  let pressTimer: number | undefined;
  const fire = () => {
    if (done) return;
    done = true;
    cleanup();
    onBlow();
  };
  const down = () => { pressTimer = window.setTimeout(fire, 1000); };
  const up = () => window.clearTimeout(pressTimer);
  target.addEventListener("pointerdown", down);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointerleave", up);

  navigator.mediaDevices?.getUserMedia({ audio: true }).then((stream) => {
    if (done) return stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    void ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let loud = 0;
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      loud = Math.sqrt(sum / buf.length) > 0.18 ? loud + 1 : 0;
      if (loud > 18) fire(); // ≈ 0.3 秒 @60fps
      else raf = requestAnimationFrame(tick);
    };
    tick();
    stopMic = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); void ctx.close(); };
  }).catch(() => { /* 没权限就只用长按 */ });

  function cleanup() {
    window.clearTimeout(pressTimer);
    target.removeEventListener("pointerdown", down);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointerleave", up);
    stopMic();
  }
  return cleanup;
}
