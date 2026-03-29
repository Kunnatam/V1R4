/**
 * Border glow + sine waveform overlay — ported from the PyObjC overlay.
 *
 * Draws on a 2D canvas layered over the Three.js scene.
 * Border: purple glow that responds to mode (dim idle, pulsing thinking, bright speaking).
 * Waveform: chaotic layered sine waves driven by audio amplitude.
 */

import type { Mode, Mood } from './state';

// ── Border colors (matched from old overlay.py) ─────────────────────
const IDLE_BORDER = [0.25, 0.08, 0.35, 0.6];       // dim purple, subtle
const ACTIVE_BORDER = [0.7, 0.2, 1.0, 0.85];       // vibrant purple, not full blast
const BORDER_WIDTH = 4;
const THINKING_PULSE_SPEED = 7.0;                   // sine speed (~0.9s cycle)

const MOOD_COLORS: Record<string, [number, number, number, number]> = {
  error:      [0.8, 0.1, 0.1, 0.85],
  success:    [0.85, 0.3, 1.0, 0.85],
  warn:       [0.9, 0.5, 0.1, 0.85],
  melancholy: [0.15, 0.2, 0.7, 0.85],
  search:     [0.2, 0.5, 0.9, 0.85],
  execute:    [0.8, 0.6, 0.2, 0.85],
  agent:      [0.85, 0.3, 1.0, 0.85],
};

// ── Waveform config (matched from old overlay.py) ───────────────────
const WAVE_BARS = 32;
const WAVE_COLOR = [0.7, 0.2, 1.0];                 // purple
const WAVE_COLOR_DIM = [0.4, 0.1, 0.6];             // dim purple for idle baseline
const WAVE_HEIGHT_FRACTION = 0.20;                   // bottom 20% of window
const WAVE_LERP = 0.35;                             // chase speed per frame

// ── State ────────────────────────────────────────────────────────────
let canvas: HTMLCanvasElement | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;
let phase = 0;
let thinkPhase = 0;
const amplitudes: number[] = new Array(WAVE_BARS).fill(0);
const targets: number[] = new Array(WAVE_BARS).fill(0);

// Waveform opacity — lerps like old overlay (fast in 0.12, slow out 0.06)
let waveOpacity = 0;
let waveOpacityTarget = 0;

// ── Toggle state ───────────────────────────────────────────────────
let waveformEnabled = true;
let subtitlesEnabled = true;

// ── Subtitle state ──────────────────────────────────────────────────
let subtitleText = '';
let subtitleCharsRevealed = 0;
let subtitleStartTime = 0;
let subtitleDuration = 0;         // total audio duration in seconds
let subtitleOpacity = 0;
let subtitleOpacityTarget = 0;
const SUBTITLE_FADE_IN = 0.18;
const SUBTITLE_FADE_OUT = 0.07;
const SUBTITLE_MAX_CHARS_PER_LINE = 35;  // wrap long text
const SUBTITLE_MAX_LINES = 3;            // cap visible lines
const SUBTITLE_MARGIN = 24;              // px margin from screen edges

/** Set subtitle text with typewriter reveal timed to audio duration */
export function setSubtitle(text: string, duration: number): void {
  if (!subtitlesEnabled || !text) return;
  subtitleText = text;
  subtitleCharsRevealed = 0;
  subtitleStartTime = performance.now() / 1000;
  // Chunked mode sends duration=0 because total length isn't known upfront.
  // Use ~15 chars/sec so reveal paces with natural speech.
  // Batch mode (duration>0) uses exact audio duration.
  subtitleDuration = duration > 0 ? duration : text.length / 15;
  subtitleOpacity = 0.02; // kick-start opacity so first frame renders
  subtitleOpacityTarget = 1.0;
  if (import.meta.env.DEV) console.log(`[V1R4] Subtitle set: "${text.slice(0, 60)}..." dur=${subtitleDuration.toFixed(1)}s`);
}

/** Clear subtitle (called when speaking stops) */
export function clearSubtitle(): void {
  subtitleOpacityTarget = 0;
  if (import.meta.env.DEV) console.log('[V1R4] Subtitle cleared');
}

/** Toggle waveform on/off */
export function toggleWaveform(): boolean {
  waveformEnabled = !waveformEnabled;
  if (import.meta.env.DEV) console.log(`[V1R4] Waveform: ${waveformEnabled ? 'ON' : 'OFF'}`);
  return waveformEnabled;
}

/** Toggle subtitles on/off */
export function toggleSubtitles(): boolean {
  subtitlesEnabled = !subtitlesEnabled;
  if (!subtitlesEnabled) {
    subtitleOpacityTarget = 0;
    subtitleText = '';
  }
  if (import.meta.env.DEV) console.log(`[V1R4] Subtitles: ${subtitlesEnabled ? 'ON' : 'OFF'}`);
  return subtitlesEnabled;
}

export function getWaveformEnabled(): boolean { return waveformEnabled; }
export function getSubtitlesEnabled(): boolean { return subtitlesEnabled; }

/** Word-wrap text into lines */
function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > maxChars && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

let overlayResizeHandler: (() => void) | null = null;

export function initOverlayEffects(): void {
  // Remove previous resize listener if re-initialized
  if (overlayResizeHandler) {
    window.removeEventListener('resize', overlayResizeHandler);
    overlayResizeHandler = null;
  }

  canvas = document.createElement('canvas');
  canvas.id = 'overlay-effects';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';
  document.body.appendChild(canvas);
  ctx2d = canvas.getContext('2d');

  const resize = () => {
    if (!canvas) return;
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
  };
  resize();
  overlayResizeHandler = resize;
  window.addEventListener('resize', resize);
}

/** Queue-style amplitude push — shifts old values out, pushes new with jitter (matches old overlay) */
function pushAmplitude(amplitude: number): void {
  targets.shift();
  const boosted = Math.min(amplitude * 4.0, 1.0); // 4x boost
  const jitter = 0.5 + Math.random(); // 0.5-1.5x random jitter
  targets.push(Math.min(boosted * jitter, 1.0));
}

function lerpColor(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i] - v) * t);
}

function rgbaStr(c: number[], alpha?: number): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${alpha ?? c[3] ?? 1})`;
}

export function updateOverlayEffects(
  deltaMs: number,
  mode: Mode,
  mood: Mood,
  speaking: boolean,
  amplitude: number,
): void {
  if (!ctx2d || !canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  const dt = deltaMs / 1000;
  const dpr = window.devicePixelRatio;

  ctx2d.clearRect(0, 0, w, h);

  // Advance phases — old overlay: phase += 0.25 per tick at 60fps ≈ 15/sec
  if (speaking) {
    phase += 0.25; // per frame, not per second — matches old overlay feel
  }
  thinkPhase += dt;

  // Push amplitude into queue (scrolling wave effect)
  pushAmplitude(amplitude);

  // ── Border glow ────────────────────────────────────────────────
  let borderColor: number[];
  if (speaking) {
    if (mood && MOOD_COLORS[mood]) {
      borderColor = [...MOOD_COLORS[mood]];
    } else {
      borderColor = [...ACTIVE_BORDER];
    }
  } else if (mode === 'thinking') {
    const t = (Math.sin(thinkPhase * THINKING_PULSE_SPEED) + 1.0) / 2.0;
    borderColor = lerpColor(IDLE_BORDER, ACTIVE_BORDER, t * 0.6); // cap at 60% blend
  } else {
    borderColor = [...IDLE_BORDER];
  }

  // Single border stroke — no extra glow layer (matches old overlay: just one strokeRect)
  ctx2d.strokeStyle = rgbaStr(borderColor);
  ctx2d.lineWidth = BORDER_WIDTH * 2 * dpr;
  ctx2d.strokeRect(0, 0, w, h);

  // ── Waveform ───────────────────────────────────────────────────
  // Opacity lerp: fast fade in (0.12), slow fade out (0.06) — matched from old overlay
  waveOpacityTarget = (speaking && waveformEnabled) ? 1.0 : 0.0;
  const opDiff = waveOpacityTarget - waveOpacity;
  if (Math.abs(opDiff) > 0.005) {
    const rate = opDiff > 0 ? 0.12 : 0.06;
    waveOpacity += opDiff * rate;
  } else {
    waveOpacity = waveOpacityTarget;
  }

  // Lerp amplitudes toward targets
  for (let i = 0; i < WAVE_BARS; i++) {
    amplitudes[i] += (targets[i] - amplitudes[i]) * WAVE_LERP;
  }

  if (waveOpacity > 0.01) {
    const waveH = h * WAVE_HEIGHT_FRACTION;
    const midY = h - waveH / 2;
    const avgAmp = amplitudes.reduce((a, b) => a + b, 0) / WAVE_BARS;
    const alpha = (0.4 + avgAmp * 0.6) * waveOpacity;

    // Upper wave (filled body)
    ctx2d.beginPath();
    ctx2d.moveTo(0, midY);
    for (let i = 0; i < WAVE_BARS; i++) {
      const x = (i / (WAVE_BARS - 1)) * w;
      const amp = amplitudes[i];
      // Layered sine waves for chaotic feel (exact formula from old overlay)
      let wave = Math.sin(phase + i * 0.5) * 0.5;
      wave += Math.sin(phase * 1.7 + i * 0.3) * 0.3;
      wave += Math.sin(phase * 2.3 + i * 0.7) * 0.2;
      ctx2d.lineTo(x, midY + wave * amp * (waveH * 0.48));
    }
    ctx2d.lineTo(w, midY);

    // Lower wave (mirror — slightly different coefficients for asymmetry)
    for (let i = WAVE_BARS - 1; i >= 0; i--) {
      const x = (i / (WAVE_BARS - 1)) * w;
      const amp = amplitudes[i];
      let wave = Math.sin(phase + i * 0.5) * 0.6;
      wave += Math.sin(phase * 1.7 + i * 0.3) * 0.4;
      ctx2d.lineTo(x, midY - wave * amp * (waveH * 0.45));
    }
    ctx2d.closePath();
    ctx2d.fillStyle = rgbaStr(WAVE_COLOR, alpha * 0.4);
    ctx2d.fill();

    // Bright stroke on top wave edge
    ctx2d.beginPath();
    ctx2d.moveTo(0, midY);
    for (let i = 0; i < WAVE_BARS; i++) {
      const x = (i / (WAVE_BARS - 1)) * w;
      const amp = amplitudes[i];
      let wave = Math.sin(phase + i * 0.5) * 0.6;
      wave += Math.sin(phase * 1.7 + i * 0.3) * 0.4;
      ctx2d.lineTo(x, midY + wave * amp * (waveH * 0.45));
    }
    ctx2d.strokeStyle = rgbaStr(WAVE_COLOR, alpha);
    ctx2d.lineWidth = 2 * dpr;
    ctx2d.stroke();

    // Idle baseline glow — dim center line when no audio
    if (avgAmp < 0.05 && waveOpacity > 0.5) {
      ctx2d.beginPath();
      ctx2d.moveTo(0, midY);
      ctx2d.lineTo(w, midY);
      ctx2d.strokeStyle = rgbaStr(WAVE_COLOR_DIM, 0.5 * waveOpacity);
      ctx2d.lineWidth = 1 * dpr;
      ctx2d.stroke();
    }
  }

  // ── Subtitle (typewriter reveal) ─────────────────────────────────
  // Opacity lerp
  const subOpDiff = subtitleOpacityTarget - subtitleOpacity;
  if (Math.abs(subOpDiff) > 0.005) {
    const rate = subOpDiff > 0 ? SUBTITLE_FADE_IN : SUBTITLE_FADE_OUT;
    subtitleOpacity += subOpDiff * rate;
  } else {
    subtitleOpacity = subtitleOpacityTarget;
  }

  if (subtitleOpacity > 0.01 && subtitleText) {
    // Typewriter: reveal chars proportional to elapsed time vs duration
    const elapsed = performance.now() / 1000 - subtitleStartTime;
    const progress = subtitleDuration > 0 ? Math.min(elapsed / subtitleDuration, 1.0) : 1.0;
    subtitleCharsRevealed = Math.floor(progress * subtitleText.length);

    const revealed = subtitleText.slice(0, subtitleCharsRevealed);

    // Split at sentence boundaries, show only the last 2 sentences
    const sentences = revealed.match(/[^.!?]*[.!?]+\s*/g);
    let displayText: string;
    if (sentences && sentences.length > 2) {
      // Show last 2 complete sentences + any trailing partial
      const lastTwo = sentences.slice(-2).join('');
      const afterLast = revealed.slice(revealed.lastIndexOf(sentences[sentences.length - 1]) + sentences[sentences.length - 1].length);
      displayText = (lastTwo + afterLast).trim();
    } else {
      displayText = revealed;
    }

    const lines = wrapText(displayText, SUBTITLE_MAX_CHARS_PER_LINE);
    // Cap visible lines
    const visibleLines = lines.slice(-SUBTITLE_MAX_LINES);

    // Draw text above the waveform area
    const fontSize = Math.round(12 * dpr);
    const lineHeight = fontSize * 1.4;
    ctx2d.font = `${fontSize}px "Inter", "Atkinson Hyperlegible", -apple-system, "Segoe UI", sans-serif`;
    ctx2d.textAlign = 'center';

    const margin = SUBTITLE_MARGIN * dpr;
    const maxPillWidth = w - margin * 2;
    const waveTop = h - h * WAVE_HEIGHT_FRACTION;
    const textBlockHeight = visibleLines.length * lineHeight;
    const textY = waveTop + 4 * dpr; // overlay on top of waveform

    // Background pill behind text
    if (visibleLines.length > 0) {
      const maxLineWidth = Math.min(
        Math.max(...visibleLines.map(l => ctx2d!.measureText(l).width)),
        maxPillWidth
      );
      const padX = 14 * dpr;
      const padY = 8 * dpr;
      const pillX = w / 2 - maxLineWidth / 2 - padX;
      const pillY = textY - padY;
      const pillW = maxLineWidth + padX * 2;
      const pillH = textBlockHeight + padY * 2;
      const radius = 8 * dpr;

      ctx2d.beginPath();
      ctx2d.roundRect(pillX, pillY, pillW, pillH, radius);
      ctx2d.fillStyle = `rgba(5, 2, 8, ${0.75 * subtitleOpacity})`;
      ctx2d.fill();
    }

    // Text — stroke first for outline, then fill (clamp to screen edges)
    ctx2d.fillStyle = `rgba(255, 255, 255, ${subtitleOpacity})`;
    ctx2d.strokeStyle = `rgba(0, 0, 0, ${0.8 * subtitleOpacity})`;
    ctx2d.lineWidth = 1 * dpr;
    ctx2d.lineJoin = 'round';
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(margin, 0, w - margin * 2, h);
    ctx2d.clip();
    for (let i = 0; i < visibleLines.length; i++) {
      const x = w / 2;
      const y = textY + i * lineHeight + fontSize;
      ctx2d.strokeText(visibleLines[i], x, y);
      ctx2d.fillText(visibleLines[i], x, y);
    }
    ctx2d.restore();
  }
}
