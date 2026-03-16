import * as THREE from 'three';

export interface BackgroundConfig {
  type: 'gradient' | 'color' | 'image';
  // For gradient
  colorCenter?: string;
  colorEdge?: string;
  // For solid color
  color?: string;
  // For image
  imagePath?: string;
  blur?: number;       // blur radius in pixels (0 = no blur, 20 = portrait blur)
  vignette?: boolean;   // dark vignette overlay for cinematic look
  tint?: string;        // optional color tint overlay (hex)
  tintOpacity?: number; // tint opacity 0-1
}

const DEFAULT_CONFIG: BackgroundConfig = {
  type: 'image',
  imagePath: '/backgrounds/spooky-castle.png',
  blur: 0,
  vignette: true,
  tint: '#0a0020',
  tintOpacity: 0.1,
};

/** Create a radial gradient texture */
function createGradientTexture(centerColor: string, edgeColor: string): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createRadialGradient(
    size / 2, size * 0.4, 0,       // center slightly above middle (where face is)
    size / 2, size / 2, size * 0.7
  );
  gradient.addColorStop(0, centerColor);
  gradient.addColorStop(0.5, mixColors(centerColor, edgeColor, 0.5));
  gradient.addColorStop(1, edgeColor);

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Simple hex color mixer */
function mixColors(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const ca = parse(a);
  const cb = parse(b);
  const mix = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `#${mix.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Load an image and return as HTMLImageElement */
function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = path;
  });
}

/** Create a background texture from an image with optional blur, vignette, tint */
function createImageTexture(
  img: HTMLImageElement,
  blur: number = 0,
  vignette: boolean = false,
  tint?: string,
  tintOpacity: number = 0.3,
): THREE.CanvasTexture {
  // Three.js scene.background stretches texture to fill viewport (ignores aspect ratio).
  // Counter this by pre-distorting: render cover-fit into a square texture,
  // accounting for viewport aspect so the final stretch produces correct proportions.
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // The viewport will stretch this square texture to windowW x windowH.
  // Pre-compensate: treat the "virtual canvas" as having the viewport aspect ratio,
  // then cover-fit the image into that virtual space, mapped into the square texture.
  const viewportAspect = window.innerWidth / window.innerHeight; // e.g. 0.75 for portrait
  const imgAspect = img.width / img.height;

  // Virtual canvas = what the viewer will actually see after Three.js stretches
  // Map image cover-fit to this virtual space, then scale into the square texture
  let drawW: number, drawH: number, drawX: number, drawY: number;

  if (imgAspect > viewportAspect) {
    // Image is wider than viewport — fit by height, crop sides
    // In texture space: full height = size, width scaled by ratio
    drawH = size;
    drawW = size * (imgAspect / viewportAspect);
    drawX = -(drawW - size) / 2;
    drawY = 0;
  } else {
    // Image is taller than viewport — fit by width, crop top/bottom
    drawW = size;
    drawH = size * (viewportAspect / imgAspect);
    drawX = 0;
    drawY = -(drawH - size) / 2;
  }

  // Draw image — then apply blur via downscale/upscale (works in all WebViews)
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  if (blur > 0) {
    // Multi-pass downscale blur — scale down small, scale back up = gaussian-like blur
    // More passes = smoother. Scale factor controls blur amount.
    const passes = 3;
    const scale = Math.max(0.02, 1 / (1 + blur * 0.15)); // blur 50 → scale ~0.12
    const tmpCanvas = document.createElement('canvas');
    const tmpCtx = tmpCanvas.getContext('2d')!;

    // Downscale
    tmpCanvas.width = Math.max(1, Math.round(size * scale));
    tmpCanvas.height = Math.max(1, Math.round(size * scale));
    tmpCtx.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);

    // Multi-pass: downscale → upscale repeatedly for smoother result
    for (let i = 1; i < passes; i++) {
      const w2 = Math.max(1, Math.round(tmpCanvas.width * 0.5));
      const h2 = Math.max(1, Math.round(tmpCanvas.height * 0.5));
      tmpCtx.drawImage(tmpCanvas, 0, 0, w2, h2);
      tmpCtx.drawImage(tmpCanvas, 0, 0, w2, h2, 0, 0, tmpCanvas.width, tmpCanvas.height);
    }

    // Upscale back to original size — bilinear filtering creates the blur
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmpCanvas, 0, 0, size, size);
    console.log(`[V1R4] Background blur applied: ${blur}px → scale ${scale.toFixed(3)}`);
  }

  // Darken slightly for better avatar contrast
  ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
  ctx.fillRect(0, 0, size, size);

  // Apply color tint
  if (tint) {
    ctx.fillStyle = tint;
    ctx.globalAlpha = tintOpacity;
    ctx.fillRect(0, 0, size, size);
    ctx.globalAlpha = 1;
  }

  // Add vignette
  if (vignette) {
    const vigGrad = ctx.createRadialGradient(
      size / 2, size * 0.4, Math.min(size, size) * 0.2,
      size / 2, size / 2, Math.max(size, size) * 0.75,
    );
    vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
    vigGrad.addColorStop(0.7, 'rgba(0,0,0,0.3)');
    vigGrad.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = vigGrad;
    ctx.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Preset backgrounds */
export const BACKGROUND_PRESETS: Record<string, BackgroundConfig> = {
  darkPurple: {
    type: 'gradient',
    colorCenter: '#2d1854',
    colorEdge: '#0c0618',
  },
  midnight: {
    type: 'gradient',
    colorCenter: '#162d4a',
    colorEdge: '#040c18',
  },
  warmDark: {
    type: 'gradient',
    colorCenter: '#3a2420',
    colorEdge: '#120808',
  },
  purple: {
    type: 'gradient',
    colorCenter: '#2e1250',
    colorEdge: '#140028',
  },
  neonRoom: {
    type: 'image',
    imagePath: '/backgrounds/neon-room.png',
    blur: 0,
    vignette: true,
    tint: '#1a0030',
    tintOpacity: 0.15,
  },
  cozyRoom: {
    type: 'image',
    imagePath: '/backgrounds/cozy-room.png',
    blur: 0,
    vignette: true,
    tint: '#1a0a00',
    tintOpacity: 0.1,
  },
  spookyCastle: {
    type: 'image',
    imagePath: '/backgrounds/spooky-castle.png',
    blur: 0,
    vignette: true,
    tint: '#0a0020',
    tintOpacity: 0.1,
  },
  ocean: {
    type: 'gradient',
    colorCenter: '#142840',
    colorEdge: '#061018',
  },
  solid: {
    type: 'color',
    color: '#0a0a0f',
  },
};

// Image cache — avoids reloading when only blur/vignette/tint changes
const imageCache = new Map<string, HTMLImageElement>();

/** Dispose previous background texture to free GPU memory */
function disposePreviousBackground(scene: THREE.Scene): void {
  if (scene.background && scene.background instanceof THREE.Texture) {
    scene.background.dispose();
  }
}

/** Apply a background config to a scene */
export async function applyBackground(
  scene: THREE.Scene,
  config: BackgroundConfig = DEFAULT_CONFIG,
): Promise<void> {
  disposePreviousBackground(scene);

  switch (config.type) {
    case 'gradient': {
      const center = config.colorCenter ?? '#1a0e2e';
      const edge = config.colorEdge ?? '#060210';
      scene.background = createGradientTexture(center, edge);
      break;
    }
    case 'color': {
      scene.background = new THREE.Color(config.color ?? '#0a0a0f');
      break;
    }
    case 'image': {
      if (config.imagePath) {
        try {
          let img = imageCache.get(config.imagePath);
          if (!img) {
            img = await loadImage(config.imagePath);
            imageCache.set(config.imagePath, img);
          }
          scene.background = createImageTexture(
            img,
            config.blur ?? 15,
            config.vignette ?? true,
            config.tint,
            config.tintOpacity,
          );
        } catch (e) {
          console.warn('[V1R4] Failed to load background image, falling back to gradient', e);
          scene.background = createGradientTexture('#2d1854', '#0c0618');
        }
      }
      break;
    }
  }
}

/** Load background config from localStorage or return default */
export function loadBackgroundConfig(): BackgroundConfig {
  try {
    const saved = localStorage.getItem('v1r4-background');
    if (saved) {
      const config = JSON.parse(saved) as BackgroundConfig;
      console.log('[V1R4] Background config (saved):', config);
      return config;
    }
  } catch { /* ignore parse errors, use default */ }
  console.log('[V1R4] Background config (default):', DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

/** Save background config to localStorage */
export function saveBackgroundConfig(config: BackgroundConfig): void {
  localStorage.setItem('v1r4-background', JSON.stringify(config));
}
