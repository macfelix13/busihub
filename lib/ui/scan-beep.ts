/**
 * A short "got it" beep for a successful barcode scan — synthesized with
 * the Web Audio API rather than an audio file, so there's no binary
 * asset to ship, license, or keep in sync with this project's plain-text
 * delivery pipeline: just a ~100ms sine tone with a quick fade in/out,
 * the same kind of short high-pitched chirp a physical barcode scanner
 * makes.
 *
 * One AudioContext, created lazily on first use and reused after that —
 * creating a new one per beep is wasteful, and some browsers cap how
 * many can exist at once. Every failure mode (no Web Audio support, the
 * context still suspended because there's been no user gesture yet,
 * anything else) is swallowed: this is a nice-to-have alongside the
 * toast/visual confirmation the till already shows, never something a
 * scan should be blocked or broken by.
 */
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext) {
    try {
      audioContext = new Ctor();
    } catch {
      return null;
    }
  }
  return audioContext;
}

export function playScanSuccessBeep(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    // A fresh AudioContext (or one created before any click/keydown on
    // the page) starts "suspended" in most browsers until a real user
    // gesture unlocks it. A physical scanner's Enter keystroke and the
    // camera modal's own "Scan" button click both count, so this
    // resolves on its own in normal use — resume() is just belt-and-
    // suspenders, and harmless to call on an already-running context.
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 1800;

    const now = ctx.currentTime;
    // Ramped rather than a hard on/off — a sine wave switched abruptly
    // mid-cycle produces an audible click at the start and end.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + 0.1);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.11);
  } catch (e) {
    console.error("playScanSuccessBeep failed", e);
  }
}