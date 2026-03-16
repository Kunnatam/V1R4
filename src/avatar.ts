import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM, VRMUtils } from '@pixiv/three-vrm';

let vrm: VRM | null = null;

export function getVRM(): VRM | null {
  return vrm;
}

export async function loadAvatar(scene: THREE.Scene, url: string): Promise<VRM> {
  // Remove previous model if swapping
  if (vrm) {
    scene.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
    vrm = null;
  }

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const model = gltf.userData.vrm as VRM;
        if (!model) {
          reject(new Error('No VRM data found in GLTF'));
          return;
        }

        VRMUtils.removeUnnecessaryVertices(model.scene);
        VRMUtils.combineSkeletons(model.scene);
        VRMUtils.rotateVRM0(model);

        // Disable frustum culling so model doesn't disappear at edges
        model.scene.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            obj.frustumCulled = false;
          }
        });

        scene.add(model.scene);
        vrm = model;
        setupRestPose(model);
        enhanceMToonMaterials(model);
        // Log spring bone and expression info for debugging
        const sbm = model.springBoneManager;
        const joints = sbm?.joints?.size ?? 0;
        console.log(`[V1R4] Spring bones: ${joints} joints`);
        const exprs = model.expressionManager?.expressions?.map(e => e.expressionName) ?? [];
        console.log(`[V1R4] Expressions: ${exprs.join(', ')}`);
        // Log which humanoid bones are available
        const humanoid = model.humanoid;
        if (humanoid) {
          const boneNames = [
            'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
            'leftEye', 'rightEye', 'jaw',
            'leftShoulder', 'rightShoulder',
            'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
            'leftHand', 'rightHand',
            'leftThumbMetacarpal', 'leftIndexProximal', 'leftMiddleProximal',
            'leftRingProximal', 'leftLittleProximal',
          ];
          const available = boneNames.filter(b => humanoid.getNormalizedBoneNode(b as any));
          console.log(`[V1R4] Bones available: ${available.join(', ')}`);
        }
        console.log('[V1R4] VRM loaded:', url);
        resolve(model);
      },
      (progress) => {
        const pct = progress.total > 0 ? (progress.loaded / progress.total * 100).toFixed(0) : '?';
        console.log(`[V1R4] Loading VRM: ${pct}%`);
      },
      (error) => reject(error)
    );
  });
}

/** Rotate arms down from T-pose to a natural rest pose */
// Rest pose values — detected from model's bind pose on load
// Exported so idle.ts can use them instead of hardcoded values
export let REST_ARM_Z = 1.1;       // upper arm Z rotation (positive = left arm down)
export let REST_FOREARM_Z = 0.2;   // lower arm Z rotation (positive = left elbow bend)

function setupRestPose(model: VRM): void {
  const humanoid = model.humanoid;
  if (!humanoid) return;

  const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm');
  const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm');
  const leftLowerArm = humanoid.getNormalizedBoneNode('leftLowerArm');
  const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm');

  // Detect bind pose — target is arms at ~25° from body (1.1 rad from T-pose)
  const TARGET_Z = 1.1;
  if (leftUpperArm) {
    const bindZ = leftUpperArm.rotation.z;
    REST_ARM_Z = bindZ === 0 ? TARGET_Z : TARGET_Z; // T-pose: bindZ ≈ 0, apply full rotation
    // If model already has arms partially down (VRM 1.0 relaxed pose), reduce offset
    if (Math.abs(bindZ) > 0.3) {
      REST_ARM_Z = bindZ + (TARGET_Z - Math.abs(bindZ));
    }
    console.log(`[V1R4] Arm bind pose Z: ${bindZ.toFixed(3)}, rest target: ${REST_ARM_Z.toFixed(3)}`);
  }

  // Apply rest pose
  if (leftUpperArm) leftUpperArm.rotation.z = REST_ARM_Z;
  if (rightUpperArm) rightUpperArm.rotation.z = -REST_ARM_Z;

  // Forearms
  const FOREARM_TARGET = 0.2;
  if (leftLowerArm) {
    const bindZ = leftLowerArm.rotation.z;
    REST_FOREARM_Z = Math.abs(bindZ) > 0.1 ? bindZ + (FOREARM_TARGET - Math.abs(bindZ)) : FOREARM_TARGET;
  }
  if (leftLowerArm) leftLowerArm.rotation.z = REST_FOREARM_Z;
  if (rightLowerArm) rightLowerArm.rotation.z = -REST_FOREARM_Z;
}

/** Enhance MToon materials — parametric rim, shade color warmth, shade boundary */
function enhanceMToonMaterials(model: VRM): void {
  let matCount = 0;
  model.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!(mat as any).isMToonMaterial) continue;
      const mtoon = mat as any;
      matCount++;

      // ── Parametric rim — Fresnel edge glow baked into MToon shader ──
      // Creates a consistent edge highlight independent of light positions.
      // rimLightingMixFactor 0.5 = half emission-like, half scene-lit
      if (mtoon.parametricRimColorFactor) {
        mtoon.parametricRimColorFactor.setRGB(0.35, 0.33, 0.4); // soft neutral rim
      }
      if ('parametricRimFresnelPowerFactor' in mtoon) {
        mtoon.parametricRimFresnelPowerFactor = 3.5; // wide, soft rim (lower = wider)
      }
      if ('parametricRimLiftFactor' in mtoon) {
        mtoon.parametricRimLiftFactor = 0.05; // slight inward expansion
      }
      if ('rimLightingMixFactor' in mtoon) {
        mtoon.rimLightingMixFactor = 0.5; // half emissive, half scene-responsive
      }

      // ── Shade color warmth — shift shadows slightly warmer ──
      // Pure black/gray shadows look dead. Warm tint adds life.
      if (mtoon.shadeColorFactor) {
        const shade = mtoon.shadeColorFactor;
        // Nudge shade color slightly warmer (add red, reduce blue)
        shade.r = Math.min(1.0, shade.r * 1.15 + 0.03);
        shade.g = Math.min(1.0, shade.g * 1.05);
        shade.b = Math.max(0.0, shade.b * 0.92);
      }

      // ── Shade boundary — slightly softer for more natural look ──
      if ('shadingToonyFactor' in mtoon && mtoon.shadingToonyFactor > 0.85) {
        mtoon.shadingToonyFactor = 0.82; // soften hard cel boundary slightly
      }

      mtoon.needsUpdate = true;
    }
  });
  console.log(`[V1R4] Enhanced ${matCount} MToon materials: parametric rim + warm shading`);
}

/** Set a VRM expression (blend shape) value. Silently ignores unknown names. */
export function setExpression(name: string, value: number): void {
  if (!vrm?.expressionManager) return;
  vrm.expressionManager.setValue(name, value);
}

/** Update VRM internal state — call every frame. */
export function updateAvatar(delta: number): void {
  if (!vrm) return;
  vrm.update(delta);
}
