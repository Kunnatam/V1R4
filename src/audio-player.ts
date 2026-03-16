// Web Audio API amplitude analysis (muted — backend handles playback)
// Routes PCM through AnalyserNode without outputting to speakers,
// so we get synced amplitude for lipsync without double audio.

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let nextPlayTime = 0;
let firstChunkReceived = false;
let speakStartTime = 0;

const TIME_DOMAIN_SIZE = 256;
const timeDomainData = new Float32Array(TIME_DOMAIN_SIZE);

export function initAudioPlayer(): void {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = TIME_DOMAIN_SIZE;
  // NOT connected to destination — analysis only, no audio output
  nextPlayTime = 0;
}

export function notifySpeakStart(): void {
  speakStartTime = performance.now();
  firstChunkReceived = false;
}

export function queueAudioChunk(pcm: Int16Array, sampleRate: number): void {
  if (!audioCtx || !analyser) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

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
  nextPlayTime = 0;
  firstChunkReceived = false;
  speakStartTime = 0;
}
