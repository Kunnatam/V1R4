import { createScene, setRimLightColor } from './scene';
import { loadAvatar, updateAvatar } from './avatar';
import { createState } from './state';
import { connectStatus, connectAudio, StatusMessage } from './ws-client';
import { setMood, updateExpressions, getAvailableMoods } from './expressions';
import { updateIdle, setMousePosition, triggerBlink, notifyKeystroke, resetIdle } from './idle';
import { updateLipSyncAmplitude, resetLipSync } from './lipsync';
import { updateBody, triggerKeystrokeReaction } from './body';
// import { updateHands } from './hands'; // disabled — needs tuning
import { initWind, updateWind } from './wind';
import { initOverlayEffects, updateOverlayEffects, setSubtitle, clearSubtitle, toggleSubtitles, toggleWaveform, getWaveformEnabled, getSubtitlesEnabled } from './overlay-effects';
import { createSpring, springDamped, SpringState } from './spring';
import { applyBackground, loadBackgroundConfig, saveBackgroundConfig, BACKGROUND_PRESETS, BackgroundConfig } from './background';
import { initAudioPlayer, queueAudioChunk, getPlaybackAmplitude, resetAudioPlayback, notifySpeakStart } from './audio-player';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import * as THREE from 'three';

const MOOD_COLORS: Record<string, THREE.Color> = {
  default:    new THREE.Color(0xaaaadd),
  error:      new THREE.Color(0xcc1a1a),
  success:    new THREE.Color(0xd94dff),
  warn:       new THREE.Color(0xe68019),
  melancholy: new THREE.Color(0x2633b3),
  search:     new THREE.Color(0x3380e6),
  execute:    new THREE.Color(0xcc9933),
  agent:      new THREE.Color(0xd94dff),
};

const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const ctx = createScene(canvas);
const state = createState();

// Draggable window — left-click anywhere to drag
const appWindow = getCurrentWindow();
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) appWindow.startDragging();
});

// Suppress browser context menu — we handle right-click manually (see mouseup below)
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

// Global cursor tracking — poll screen-wide cursor position from Rust
// Runs at ~20Hz to avoid overhead while staying responsive
setInterval(async () => {
  try {
    const pos = await invoke<[number, number] | null>('get_cursor_position');
    if (pos) setMousePosition(pos[0], pos[1]);
  } catch { /* ignore if command not available yet */ }
}, 50);

// Global keystroke detection — poll CoreGraphics keystroke counter
// Detects typing anywhere on screen, triggers subtle body reaction
let lastKeystrokeCount = 0;
setInterval(async () => {
  try {
    const count = await invoke<number>('get_keystroke_count');
    if (lastKeystrokeCount > 0 && count !== lastKeystrokeCount) {
      triggerKeystrokeReaction();
      notifyKeystroke();
    }
    lastKeystrokeCount = count;
  } catch { /* ignore if command not available yet */ }
}, 50);

let toolMoodTimer: ReturnType<typeof setTimeout> | null = null;
let speakingStopTimer: ReturnType<typeof setTimeout> | null = null;

function onStatusMessage(msg: StatusMessage): void {
  switch (msg.type) {
    case 'state':
      if (msg.value === 'idle') {
        state.mode = 'idle';
        state.mood = null;
        setMood(null);
        setRimLightColor(ctx.scene, MOOD_COLORS.default);
      } else if (msg.value === 'thinking') {
        state.mode = 'thinking';
      }
      break;

    case 'text':
      if (import.meta.env.DEV) console.log(`[V1R4] WS text received: "${msg.value.slice(0, 60)}..." dur=${msg.duration}`);
      setSubtitle(msg.value, msg.duration);
      break;

    case 'speaking':
      if (msg.value) {
        if (speakingStopTimer) { clearTimeout(speakingStopTimer); speakingStopTimer = null; }
        state.mode = 'speaking';
        state.speaking = true;
        notifySpeakStart();
        if (import.meta.env.DEV) console.log('[V1R4] Speaking START — state.speaking =', state.speaking);
      } else {
        speakingStopTimer = setTimeout(() => {
          state.speaking = false;
          state.mode = 'idle';
          state.amplitude = 0;
          resetLipSync();
          resetAudioPlayback();
          clearSubtitle();
          speakingStopTimer = null;
        }, 300);
      }
      break;

    case 'mood':
      triggerBlink(); // blink covers expression transition
      setMood(msg.value);
      const moodColor = MOOD_COLORS[msg.value] ?? MOOD_COLORS.default;
      setRimLightColor(ctx.scene, moodColor);
      break;

    case 'toolMood':
      if (toolMoodTimer) clearTimeout(toolMoodTimer);
      state.toolMood = msg.value as any;
      // Brief rim light flash for tool mood
      const toolColor = MOOD_COLORS[msg.value] ?? MOOD_COLORS.default;
      setRimLightColor(ctx.scene, toolColor);
      // Brief expression flash — focused squint for tools
      setMood('focused');
      toolMoodTimer = setTimeout(() => {
        state.toolMood = null;
        setRimLightColor(ctx.scene, MOOD_COLORS.default);
        setMood(null);
        toolMoodTimer = null;
      }, 2000);
      break;
  }
}

// Apply background
applyBackground(ctx.scene, loadBackgroundConfig());

// Expose background change function for context menu
/** Open a file picker and return the selected image as a data URL */
function pickImageFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    let resolved = false;
    const cleanup = () => {
      window.removeEventListener('focus', onFocus);
      input.remove();
    };
    const resolveOnce = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { resolveOnce(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolveOnce(reader.result as string);
      reader.onerror = () => resolveOnce(null);
      reader.readAsDataURL(file);
    });
    // Handle cancel — file input doesn't fire 'change' on cancel,
    // so we use a focus listener as a fallback
    function onFocus() {
      setTimeout(() => {
        if (!input.files?.length) resolveOnce(null);
      }, 500);
    }
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

(window as any).__V1R4_CHANGE_BG = async (presetOrCustom: string, blur?: number) => {
  let config: BackgroundConfig;
  if (presetOrCustom === 'custom') {
    const dataUrl = await pickImageFile();
    if (!dataUrl) return;
    config = { type: 'image', imagePath: dataUrl, blur: blur ?? 0, vignette: true };
  } else {
    config = BACKGROUND_PRESETS[presetOrCustom] ?? BACKGROUND_PRESETS.darkPurple;
  }
  await applyBackground(ctx.scene, config);
  saveBackgroundConfig(config);
  if (import.meta.env.DEV) console.log(`[V1R4] Background changed to: ${presetOrCustom}, blur: ${config.blur}`);
};

// Apply blur to current background instantly (uses image cache — no reload)
(window as any).__V1R4_SET_BLUR = async (blur: number) => {
  const config = loadBackgroundConfig();
  if (config.type === 'image') {
    config.blur = blur;
    await applyBackground(ctx.scene, config);
    saveBackgroundConfig(config);
    if (import.meta.env.DEV) console.log(`[V1R4] Blur set to: ${blur}`);
  }
};

// ── Avatar persistence (IndexedDB — VRM files too large for localStorage) ──

function openAvatarDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('v1r4', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('avatar');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAvatarBlob(blob: Blob): Promise<void> {
  const db = await openAvatarDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('avatar', 'readwrite');
    tx.objectStore('avatar').put(blob, 'model');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadAvatarBlob(): Promise<Blob | null> {
  const db = await openAvatarDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('avatar', 'readonly');
    const req = tx.objectStore('avatar').get('model');
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function clearAvatarBlob(): Promise<void> {
  const db = await openAvatarDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('avatar', 'readwrite');
    tx.objectStore('avatar').delete('model');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

function pickVRMFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vrm';
    input.style.display = 'none';
    let resolved = false;
    const cleanup = () => {
      window.removeEventListener('focus', onFocus);
      input.remove();
    };
    const resolveOnce = (value: File | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };
    input.addEventListener('change', () => {
      resolveOnce(input.files?.[0] ?? null);
    });
    function onFocus() {
      setTimeout(() => {
        if (!input.files?.length) resolveOnce(null);
      }, 500);
    }
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

(window as any).__V1R4_LOAD_AVATAR = async () => {
  const file = await pickVRMFile();
  if (!file) return;
  try {
    await saveAvatarBlob(file);
    const url = URL.createObjectURL(file);
    await loadAvatar(ctx.scene, url);
    URL.revokeObjectURL(url);
    resetIdle();
    initWind();
    if (import.meta.env.DEV) console.log(`[V1R4] Avatar loaded: ${file.name}`);
  } catch (err) {
    if (import.meta.env.DEV) console.error('[V1R4] Failed to load avatar:', err);
  }
};

(window as any).__V1R4_RESET_AVATAR = async () => {
  await clearAvatarBlob().catch(() => {});
  try {
    await loadAvatar(ctx.scene, '/models/avatar.vrm');
    resetIdle();
    initWind();
    if (import.meta.env.DEV) console.log('[V1R4] Avatar reset to default');
  } catch (err) {
    if (import.meta.env.DEV) console.error('[V1R4] Failed to load default avatar:', err);
  }
};

// ── Camera controls ──────────────────────────────────────────────────
const CAMERA_BASE_Z = 1.0;
const CAMERA_MIN_ZOOM = 0.6;
const CAMERA_MAX_ZOOM = 2.0;
const CAMERA_ZOOM_HL = 0.08;  // smooth but responsive zoom

// Load saved camera state
function loadCameraState(): { zoom: number; panY: number } {
  try {
    const saved = localStorage.getItem('v1r4-camera');
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return { zoom: 1.0, panY: ctx.camera.position.y };
}

function saveCameraState(): void {
  localStorage.setItem('v1r4-camera', JSON.stringify({ zoom: cameraZoomTarget, panY: cameraBaseY }));
}

const savedCamera = loadCameraState();
let cameraZoomTarget = savedCamera.zoom;
let cameraZoomSpring: SpringState = createSpring();
cameraZoomSpring.pos = cameraZoomTarget; // start at saved position, no spring animation

(window as any).__V1R4_ZOOM_IN = () => {
  cameraZoomTarget = Math.min(CAMERA_MAX_ZOOM, cameraZoomTarget + 0.15);
  saveCameraState();
  if (import.meta.env.DEV) console.log(`[V1R4] Zoom: ${cameraZoomTarget.toFixed(2)}`);
};
(window as any).__V1R4_ZOOM_OUT = () => {
  cameraZoomTarget = Math.max(CAMERA_MIN_ZOOM, cameraZoomTarget - 0.15);
  saveCameraState();
  if (import.meta.env.DEV) console.log(`[V1R4] Zoom: ${cameraZoomTarget.toFixed(2)}`);
};

// ── Expression preview ───────────────────────────────────────────────
let previewMoodTimer: ReturnType<typeof setTimeout> | null = null;

(window as any).__V1R4_PREVIEW_MOOD = (mood: string) => {
  if (previewMoodTimer) clearTimeout(previewMoodTimer);
  setMood(mood);
  const moodColor = MOOD_COLORS[mood] ?? MOOD_COLORS.default;
  setRimLightColor(ctx.scene, moodColor);
  // Auto-clear after 3s
  previewMoodTimer = setTimeout(() => {
    setMood(null);
    setRimLightColor(ctx.scene, MOOD_COLORS.default);
    previewMoodTimer = null;
  }, 3000);
};

(window as any).__V1R4_GET_MOODS = () => getAvailableMoods();

function syncToggleState(): void {
  invoke('set_toggle_state', { waveform: getWaveformEnabled(), subtitles: getSubtitlesEnabled() }).catch(() => {});
}

(window as any).__V1R4_TOGGLE_SUBTITLES = () => { toggleSubtitles(); syncToggleState(); };
(window as any).__V1R4_TOGGLE_WAVEFORM = () => { toggleWaveform(); syncToggleState(); };

// ── Camera pan ───────────────────────────────────────────────────────
(window as any).__V1R4_CAMERA_UP = () => {
  cameraBaseY += 0.03;
  saveCameraState();
  if (import.meta.env.DEV) console.log(`[V1R4] Camera Y: ${cameraBaseY.toFixed(3)}`);
};
(window as any).__V1R4_CAMERA_DOWN = () => {
  cameraBaseY -= 0.03;
  saveCameraState();
  if (import.meta.env.DEV) console.log(`[V1R4] Camera Y: ${cameraBaseY.toFixed(3)}`);
};

// Scroll-to-zoom — sets target, spring handles smoothing in animate()
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.01 : 0.01;
  cameraZoomTarget = Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, cameraZoomTarget + delta));
  saveCameraState();
}, { passive: false });

// ── Right-click drag to pan camera vertically ────────────────────────
// Short right-click (< 3px movement) → context menu
// Right-click drag → pan camera Y
let rightDragStartY = 0;
let rightDragBaseY = 0;
let rightDragging = false;
const RIGHT_DRAG_THRESHOLD = 3; // px before it counts as a drag
const CAMERA_PAN_SENSITIVITY = 0.003; // px → world units

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    rightDragStartY = e.clientY;
    rightDragBaseY = cameraBaseY;
    rightDragging = false;
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (e.buttons & 2) {
    const dy = e.clientY - rightDragStartY;
    if (!rightDragging && Math.abs(dy) > RIGHT_DRAG_THRESHOLD) {
      rightDragging = true;
    }
    if (rightDragging) {
      cameraBaseY = rightDragBaseY + dy * CAMERA_PAN_SENSITIVITY;
    }
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 2) {
    if (!rightDragging) {
      invoke('show_context_menu').catch(() => {});
    } else {
      saveCameraState();
    }
    rightDragging = false;
  }
});

// Load avatar: check IndexedDB for saved model, fall back to default
(async () => {
  let avatarLoaded = false;
  const savedBlob = await loadAvatarBlob().catch(() => null);
  if (savedBlob) {
    const url = URL.createObjectURL(savedBlob);
    try {
      await loadAvatar(ctx.scene, url);
      avatarLoaded = true;
      if (import.meta.env.DEV) console.log('[V1R4] Loaded saved avatar from IndexedDB');
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[V1R4] Saved avatar failed, clearing and falling back:', err);
      await clearAvatarBlob().catch(() => {});
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!avatarLoaded) {
    try {
      await loadAvatar(ctx.scene, '/models/avatar.vrm');
      if (import.meta.env.DEV) console.log('[V1R4] Loaded default avatar');
    } catch (err) {
      if (import.meta.env.DEV) console.error('[V1R4] Avatar load FAILED:', err);
      // Show user-visible error — no avatar model found
      const msg = document.createElement('div');
      msg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:14px sans-serif;text-align:center;opacity:0.7;pointer-events:none;';
      msg.textContent = 'No avatar model found — place avatar.vrm in public/models/ or right-click → Load Avatar';
      document.body.appendChild(msg);
    }
  }
  initWind();
  initOverlayEffects();
  connectStatus(state, onStatusMessage);
  initAudioPlayer();
  connectAudio((pcm, sr) => {
    queueAudioChunk(pcm, sr);
  });
})();

// Camera base position (for sway calculation) — mutable so pan updates it
let cameraBaseY = savedCamera.panY;
let cameraTime = 0;

// Smoothed amplitude — raw amplitude can be spiky from WebSocket,
// spring smoothing gives body/lips a more natural response
let ampSpring: SpringState = createSpring();
const AMP_HL = 0.03; // very fast but removes jitter

// ── Mood-reactive camera ────────────────────────────────────────────
// Cinematic zoom pushes and dutch tilts on emotional changes
// Subtle enough to feel, not see — like good film grammar

// Zoom offsets (added to cameraZoom — positive = closer)
const MOOD_ZOOM: Record<string, number> = {
  error:      0.08,    // push in — dramatic intensity
  melancholy: 0.06,    // push in — intimacy
  warn:       0.04,    // slight push in — alertness
  success:   -0.05,    // pull back — breathing room, triumph
};

const MODE_ZOOM: Record<string, number> = {
  speaking:   0.03,    // subtle push — engagement
  thinking:  -0.03,    // pull back — contemplation
  idle:       0,
};

// Dutch tilt (camera roll in radians — creates unease/drama)
const MOOD_DUTCH: Record<string, number> = {
  error:      0.015,   // slight tilt (~0.9°)
  melancholy: -0.01,   // opposite tilt
  warn:       0.008,
};

let moodZoomSpring: SpringState = createSpring();
let dutchTiltSpring: SpringState = createSpring();
const MOOD_ZOOM_HL = 0.5;     // slow, cinematic zoom transition
const DUTCH_TILT_HL = 0.6;    // even slower dutch angle ease

function animate(): void {
  requestAnimationFrame(animate);
  const delta = ctx.clock.getDelta();
  const deltaMs = delta * 1000;
  const dt = delta;
  cameraTime += dt;

  // Amplitude: prefer local playback (synced to audio) over WebSocket (delayed)
  const localAmp = getPlaybackAmplitude();
  const ampSource = localAmp > 0.005 ? localAmp : state.amplitude;
  ampSpring = springDamped(ampSpring, ampSource, AMP_HL, dt);
  const smoothAmp = Math.max(0, ampSpring.pos);

  updateExpressions(deltaMs);
  updateIdle(deltaMs, state.speaking, state.mode, state.mood);
  updateBody(deltaMs, state.mode, state.mood, smoothAmp);
  // updateHands(deltaMs, state.mode, smoothAmp); // disabled — needs tuning

  if (state.speaking) {
    updateLipSyncAmplitude(smoothAmp, deltaMs);
  }

  updateWind(deltaMs);

  // Smooth zoom — spring toward target
  cameraZoomSpring = springDamped(cameraZoomSpring, cameraZoomTarget, CAMERA_ZOOM_HL, dt);

  // Mood-reactive camera — spring-smoothed zoom and dutch tilt
  const moodZoomTarget = (MOOD_ZOOM[state.mood ?? ''] ?? 0) + (MODE_ZOOM[state.mode] ?? 0);
  moodZoomSpring = springDamped(moodZoomSpring, moodZoomTarget, MOOD_ZOOM_HL, dt);
  const dutchTarget = MOOD_DUTCH[state.mood ?? ''] ?? 0;
  dutchTiltSpring = springDamped(dutchTiltSpring, dutchTarget, DUTCH_TILT_HL, dt);

  // Apply zoom: smoothed base zoom + mood offset, clamped to valid range
  const effectiveZoom = Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, cameraZoomSpring.pos + moodZoomSpring.pos));
  ctx.camera.position.z = CAMERA_BASE_Z / effectiveZoom;

  // Subtle camera breathing — very gentle sway for cinematic feel
  const camBreathY = Math.sin(cameraTime * 0.4) * 0.002;
  const camBreathX = Math.sin(cameraTime * 0.25) * 0.001;
  ctx.camera.position.y = cameraBaseY + camBreathY;
  ctx.camera.position.x = camBreathX;

  // Dutch tilt — camera roll for mood drama
  ctx.camera.rotation.z = dutchTiltSpring.pos;

  updateAvatar(delta);
  // Skip post-processing when transparent — bloom destroys alpha channel
  if (ctx.transparent) {
    ctx.renderer.render(ctx.scene, ctx.camera);
  } else {
    ctx.composer.render();
  }

  // 2D overlay: border glow + waveform
  updateOverlayEffects(deltaMs, state.mode, state.mood, state.speaking, smoothAmp);
}

animate();
