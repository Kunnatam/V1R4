import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  clock: THREE.Clock;
  transparent: boolean;
}

// ── Combined color grade + vignette + film grain shader ───────────────
// Single pass for all adjustments — avoids redundant texture reads
const ColorGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    brightness: { value: 0.03 },
    contrast: { value: 0.12 },
    saturation: { value: 0.15 },
    vignetteOffset: { value: 1.1 },
    vignetteDarkness: { value: 1.0 },
    grainIntensity: { value: 0.04 },
    time: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float brightness;
    uniform float contrast;
    uniform float saturation;
    uniform float vignetteOffset;
    uniform float vignetteDarkness;
    uniform float grainIntensity;
    uniform float time;
    varying vec2 vUv;

    // Hash-based noise (fast, no texture needed)
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      // Brightness
      color.rgb += brightness;

      // Contrast (centered on 0.5)
      color.rgb = (color.rgb - 0.5) * (1.0 + contrast) + 0.5;

      // Saturation (luminance-preserving)
      float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      color.rgb = mix(vec3(luma), color.rgb, 1.0 + saturation);

      // Vignette — darken edges, preserve center
      vec2 uv = (vUv - 0.5) * 2.0;
      float dist = dot(uv, uv);
      float vig = 1.0 - smoothstep(vignetteOffset, vignetteOffset + 0.7, dist * vignetteDarkness);
      color.rgb *= mix(1.0, vig, 0.6);

      // Film grain (luminance-weighted — stronger in shadows, fades in highlights)
      float grain = hash(vUv * 1000.0 + time) - 0.5;
      float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      float grainWeight = 1.0 - smoothstep(0.0, 0.6, luminance);
      color.rgb += grain * grainIntensity * grainWeight;

      gl_FragColor = color;
    }
  `
};

export function createScene(canvas: HTMLCanvasElement): SceneContext {
  // Renderer
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // NeutralToneMapping preserves MToon toon colors — linear pass-through
  // below 0.76, only compresses highlights. ACES was shifting our hues.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;

  // Scene — background applied separately via background.ts
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0f); // fallback until background loads

  // Camera — 30deg FOV, portrait aspect, slight upward angle
  const camera = new THREE.PerspectiveCamera(
    30,
    window.innerWidth / window.innerHeight,
    0.1,
    20
  );
  camera.position.set(0, 1.42, 1.0);
  camera.lookAt(0, 1.44, 0);

  // Key light — warm white, front-right above (warm/cool contrast with fill)
  const keyLight = new THREE.DirectionalLight(0xfff0e0, 1.3);
  keyLight.position.set(1, 3, 2);
  scene.add(keyLight);

  // Fill light — cool lavender-blue, front-left (cooler = depth perception)
  const fillLight = new THREE.DirectionalLight(0x8899cc, 0.5);
  fillLight.position.set(-1, 2, 1.5);
  scene.add(fillLight);

  // Rim light — cool blue-white, behind (strongest pop factor against dark BG)
  const rimLight = new THREE.DirectionalLight(0xa0a0ee, 0.9);
  rimLight.position.set(0, 2, -1.5);
  scene.add(rimLight);

  // Hair/kicker light — top-down accent, highlights hair and shoulders
  const kickerLight = new THREE.DirectionalLight(0xddccee, 0.4);
  kickerLight.position.set(0.3, 4, 0);
  scene.add(kickerLight);

  // Hemisphere light — main ambient fill (MToon responds well to this)
  const hemiLight = new THREE.HemisphereLight(0xd0d0dd, 0x141820, 0.45);
  scene.add(hemiLight);

  // Ambient — raise the floor
  const ambient = new THREE.AmbientLight(0x484855, 0.35);
  scene.add(ambient);

  // Eye catch light — bright point near camera for eye sparkle
  const catchLight = new THREE.PointLight(0xffffff, 0.3, 3.0);
  catchLight.position.set(0.05, 1.44, 0.85);
  scene.add(catchLight);

  // ── Post-processing pipeline ──────────────────────────────────────
  // Order: Render → Bloom (needs linear HDR) → Color grade → Output (tone map + sRGB)
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.25,  // strength — subtle glow on rim and highlights
    0.4,   // radius — slightly wider for soft halo
    0.78   // threshold — catch more highlights for rim glow
  );
  composer.addPass(bloomPass);

  // Combined color grade pass (brightness, contrast, saturation, vignette, grain)
  const colorGradePass = new ShaderPass(ColorGradeShader);
  composer.addPass(colorGradePass);

  composer.addPass(new OutputPass());

  // Animate grain noise offset
  const clock = new THREE.Clock();
  const _origRender = composer.render.bind(composer);
  composer.render = function (...args: Parameters<typeof _origRender>) {
    colorGradePass.uniforms['time'].value = performance.now() * 0.001;
    return _origRender(...args);
  };

  // Resize handler
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  });

  return { scene, camera, renderer, composer, clock, transparent: false };
}

/** Access the rim light to change its color for mood */
export function setRimLightColor(scene: THREE.Scene, color: THREE.Color): void {
  const lights = scene.children.filter(
    (c): c is THREE.DirectionalLight => c instanceof THREE.DirectionalLight
  );
  const rim = lights[2]; // key=0, fill=1, rim=2
  if (rim) rim.color.copy(color);

  // Subtly tint fill light toward mood color (25% blend)
  const fill = lights[1]; // fill light
  if (fill) {
    const baseFill = new THREE.Color(0x8899cc);
    fill.color.copy(baseFill).lerp(color, 0.25);
  }

  // Tint hemisphere sky color (15% blend) for ambient mood shift
  const hemi = scene.children.find(
    (c): c is THREE.HemisphereLight => c instanceof THREE.HemisphereLight
  );
  if (hemi) {
    const baseHemiSky = new THREE.Color(0xccccdd);
    hemi.color.copy(baseHemiSky).lerp(color, 0.15);
  }
}
