// The Three.js scene shell (feature/3d-migration): camera, lighting, the
// ground plane, and the mouse-to-ground-plane raycast every other 3D module
// builds on. Originated as Phase 2's minimal proof-of-pipeline prototype
// (plain coloured box placeholders, flat lighting); Phase 3+ replaced the
// placeholders with real models (character.ts/zombie.ts/structures.ts) and
// added shadow-casting lights/fog/tone-mapping here — the camera-follow/
// zoom/raycast contract below is UNCHANGED from Phase 2 since main3d.ts and
// input.ts both already depend on its exact shape.
//
// Coordinate mapping (see PROCESS.md's architecture-audit entry): server/
// world x,y maps directly to Three.js scene x,z (the ground plane) — world
// x -> scene x, world y -> scene z. Three.js scene y is used only for
// rendering height and carries no gameplay meaning.
import * as THREE from "three";
import { createGround } from "./ground.ts";

export interface Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  // Moves/orients the camera to follow a world x/y point, at the given zoom
  // (world units visible across the canvas's shorter axis — same meaning as
  // camera.ts's DEFAULT_VIEW_SIZE in the 2D client, so zoom feel carries
  // over). Call once per frame, same as the 2D client's computeCamera.
  updateCamera: (followWorldX: number, followWorldY: number, viewSize: number) => void;
  // Projects a canvas-pixel mouse position onto the world ground plane
  // (scene y = 0) via raycasting — the 3D equivalent of camera.ts's
  // screenToWorld, with the same {x, y} world-space return shape so
  // input.ts needs no change to its own contract.
  screenToWorld: (canvasX: number, canvasY: number) => { x: number; y: number };
  // The inverse of screenToWorld — projects a world ground-plane point to a
  // canvas-pixel position, in the SAME backing-buffer-pixel basis
  // screenToWorld's own canvasX/canvasY inputs use (not CSS pixels — see
  // input.ts's cssToBackingX/Y conversion, which a caller positioning an
  // HTML overlay from this must invert the same way). Used for the 3D
  // crosshair overlay, which has no Canvas2D context to draw into directly.
  worldToScreen: (worldX: number, worldY: number) => { x: number; y: number };
  resize: (width: number, height: number) => void;
  render: () => void;
}

// A fixed elevation/azimuth three-quarter isometric-style look, applied as
// a camera OFFSET from the follow target rather than a fixed world
// position — this is what makes "follow" work: the offset stays constant
// in camera-relative terms as the target moves. Chosen angles read as a
// classic isometric-ish top-down-but-angled view (brief's "elevated
// isometric or three-quarter top-down 3D camera").
const CAMERA_ELEVATION = 55; // degrees above the ground plane
// Exported so isometric-input.ts can derive its screen-relative WASD remap
// from the SAME fixed azimuth the camera actually uses, instead of a second
// hardcoded copy of "45" that could silently drift out of sync with it.
export const CAMERA_AZIMUTH = 45; // degrees around the vertical axis
const CAMERA_DISTANCE = 600; // world units back from the follow target, along the elevation/azimuth direction

function cameraOffset(): THREE.Vector3 {
  const elevRad = (CAMERA_ELEVATION * Math.PI) / 180;
  const azimRad = (CAMERA_AZIMUTH * Math.PI) / 180;
  const horizontalDist = CAMERA_DISTANCE * Math.cos(elevRad);
  return new THREE.Vector3(horizontalDist * Math.cos(azimRad), CAMERA_DISTANCE * Math.sin(elevRad), horizontalDist * Math.sin(azimRad));
}

export function createScene3D(canvas: HTMLCanvasElement): Scene3D {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  // A post-apocalyptic dusk/overcast sky tone rather than Phase 2's flat
  // near-black background — paired with fog below so distant geometry (the
  // far edge of the 1000x1000 world) fades instead of hard-cutting against
  // the sky colour.
  const skyColor = new THREE.Color(0x3a4258);
  scene.background = skyColor;
  // Fog distance is VIEW-SPACE depth from the camera, not distance from the
  // follow target — with the isometric camera sitting CAMERA_DISTANCE (600)
  // units back and the 1000x1000 world extending well past that in every
  // direction once the camera starts following a live player (rather than
  // sitting at its initial default), view-space depth to the far side of
  // the map comfortably exceeds a few hundred units. An earlier near/far
  // pair (900/2200) looked fine before the camera ever moved but fogged out
  // almost the entire ground plane into a dark gradient the moment the
  // first server snapshot arrived and the camera re-centred on the player's
  // spawn point — confirmed by reproducing it with fog temporarily removed.
  // These values keep the full world comfortably inside the clear range
  // regardless of where the camera is following.
  scene.fog = new THREE.Fog(skyColor, 1600, 3400);

  // Orthographic, not perspective — a true isometric-style read (parallel
  // lines stay parallel, a far zombie isn't tinier just from perspective
  // foreshortening) and it makes screenToWorld's ground-plane raycast exact
  // regardless of camera distance, matching the 2D client's own
  // zoom-independent screen<->world mapping (camera.ts's cameraScale).
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);

  const ambient = new THREE.AmbientLight(0x8a93b0, 0.55);
  scene.add(ambient);
  // A cool hemisphere fill (sky vs. ground tint) so shadowed faces don't go
  // flat black — cheap (one extra light, no shadow map of its own) and a
  // standard atmospheric-lighting technique for an outdoor scene.
  const hemi = new THREE.HemisphereLight(0x8fa6c9, 0x2a2418, 0.5);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffdcb0, 1.6);
  sun.position.set(300, 500, 200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -500;
  sun.shadow.camera.right = 500;
  sun.shadow.camera.top = 500;
  sun.shadow.camera.bottom = -500;
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 1500;
  // Setting an OrthographicCamera's left/right/top/bottom/near/far only
  // stages new values — nothing recomputes .projectionMatrix from them
  // until updateProjectionMatrix() runs.
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 2;
  scene.add(sun);
  // The shadow camera follows the directional light's own target, which
  // defaults to the origin — re-pointed at the world's centre (not (0,0,0))
  // so the shadow frustum above actually covers the playable 1000x1000
  // world instead of being centred off in a corner.
  sun.target.position.set(500, 0, 500);
  scene.add(sun.target);

  const ground = createGround();
  scene.add(ground);

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y = 0

  let canvasWidth = 1;
  let canvasHeight = 1;

  function resize(width: number, height: number): void {
    canvasWidth = Math.max(1, width);
    canvasHeight = Math.max(1, height);
    renderer.setSize(canvasWidth, canvasHeight, false);
  }

  function updateCamera(followWorldX: number, followWorldY: number, viewSize: number): void {
    const offset = cameraOffset();
    // Three.js scene x,z <- world x,y (see this file's own top comment).
    const targetScenePos = new THREE.Vector3(followWorldX, 0, followWorldY);
    camera.position.copy(targetScenePos).add(offset);
    camera.lookAt(targetScenePos);

    // Orthographic frustum sized from viewSize exactly like camera.ts's
    // computeCamera sizes its 2D viewWidth/viewHeight: viewSize is world
    // units across the canvas's SHORTER axis, the longer axis scales with
    // the canvas's own aspect ratio.
    const aspect = canvasWidth / canvasHeight;
    const halfShort = viewSize / 2;
    const halfX = aspect >= 1 ? halfShort * aspect : halfShort;
    const halfY = aspect >= 1 ? halfShort : halfShort / aspect;
    camera.left = -halfX;
    camera.right = halfX;
    camera.top = halfY;
    camera.bottom = -halfY;
    camera.updateProjectionMatrix();
  }

  function screenToWorld(canvasX: number, canvasY: number): { x: number; y: number } {
    const ndcX = (canvasX / canvasWidth) * 2 - 1;
    const ndcY = -(canvasY / canvasHeight) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hit = new THREE.Vector3();
    const hitOrNull = raycaster.ray.intersectPlane(groundPlane, hit);
    if (!hitOrNull) return { x: followedWorldX, y: followedWorldY }; // camera looking away from the ground plane — shouldn't happen at these fixed angles, but fall back to the last follow point rather than NaN
    return { x: hit.x, y: hit.z };
  }

  // Tracked purely as screenToWorld's degenerate fallback above.
  let followedWorldX = 500;
  let followedWorldY = 500;
  const updateCameraWrapped = (x: number, y: number, viewSize: number): void => {
    followedWorldX = x;
    followedWorldY = y;
    updateCamera(x, y, viewSize);
  };

  function worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const p = new THREE.Vector3(worldX, 0, worldY).project(camera);
    return { x: ((p.x + 1) / 2) * canvasWidth, y: ((1 - p.y) / 2) * canvasHeight };
  }

  function render(): void {
    renderer.render(scene, camera);
  }

  return { renderer, scene, camera, updateCamera: updateCameraWrapped, screenToWorld, worldToScreen, resize, render };
}
