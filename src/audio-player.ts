// Web Audio API playback + amplitude analysis
// Receives PCM chunks from TTS server via WebSocket,
// plays through speakers and analyzes amplitude for lipsync.

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let nextPlayTime = 0;
let firstChunkReceived = false;
let speakStartTime = 0;

const TIME_DOMAIN_SIZE = 256;
const timeDomainData = new Float32Array(TIME_DOMAIN_SIZE);

function createAudioContext(): void {
  if (audioCtx) {
    try { audioCtx.close(); } catch { /* ignore */ }
  }
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = TIME_DOMAIN_SIZE;
  analyser.connect(audioCtx.destination);
  nextPlayTime = 0;
}

export function initAudioPlayer(): void {
  createAudioContext();

  // Recreate AudioContext after lid close/open — resume() alone is unreliable on macOS WKWebView
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      createAudioContext();
    }
  });
}

export function notifySpeakStart(): void {
  speakStartTime = performance.now();
  firstChunkReceived = false;
}

export function queueAudioChunk(pcm: Int16Array, sampleRate: number): void {
  if (!audioCtx || !analyser) return;
  if (audioCtx.state === 'suspended' || audioCtx.state === 'closed') {
    createAudioContext();
  }

  if (!firstChunkReceived) {
    firstChunkReceived = true;
    const elapsed = speakStartTime > 0 ? (performance.now() - speakStartTime).toFixed(0) : '?';
    if (import.meta.env.DEV) console.log(`[PERF] First audio chunk received: ${elapsed}ms from speaking start`);
  }

  // Int16 PCM → Float32
  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    float32[i] = pcm[i] / 32768;
  }

  const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(analyser);

  // Gapless scheduling — queue after previous chunk
  const now = audioCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
}

/** RMS amplitude of what's currently playing — zero when silent. */
export function getPlaybackAmplitude(): number {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(timeDomainData);

  let sum = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    sum += timeDomainData[i] * timeDomainData[i];
  }
  return Math.sqrt(sum / timeDomainData.length);
}

export function resetAudioPlayback(): void {
  // Only reset if all queued audio has finished playing
  if (audioCtx && nextPlayTime > 0 && audioCtx.currentTime < nextPlayTime) {
    return; // audio still playing — let it drain
  }
  nextPlayTime = 0;
  firstChunkReceived = false;
  speakStartTime = 0;
}

export function forceResetAudioPlayback(): void {
  // Force stop — used by /stop endpoint
  nextPlayTime = 0;
  firstChunkReceived = false;
  speakStartTime = 0;
}
