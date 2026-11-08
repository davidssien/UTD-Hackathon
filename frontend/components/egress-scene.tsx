'use client';
/**
 * The one 3D scene (docs/ARCHITECTURE.md §8 "Scene"). Edit locks it top-down; other modes orbit.
 * Blueprint ground with a white dot grid, walls from `deriveLayout`, cross-hatched
 * occluders, people and heatmap layers, blue-highlighted agent suggestions with
 * reason bubbles, and a CAD viewcube.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  ACTOR_EXITED, ACTOR_QUEUED, ACTOR_TRANSITIONING, deriveLayout, floorsByLevel, pointInPolygon, projectOnSegment, type EditCommand, type EgressDocument, type Floor, type ScalarField, type SlabMaterial,
  PLACEABLES, placeableFootprint, type PlaceableItem, type Vec2, type WallMaterial,
} from '@egress/core';
import type { FloorAirflow } from '@egress/sim';
import type { PlaybackController } from '@egress/client';
import { WallLibrary } from '@/lib/wall-textures';
import { encodeField, fieldScale } from '@/lib/heatmap';
import { stairSteps, upEdgeOf } from '@/lib/stairs';
import { placeableModel, type PartTone } from '@/lib/placeable-models';

/** Part colours per placeable: warm wood for tables and desks, fabric chairs, pale counters, metal vents. */
const PLACEABLE_TONES: Record<PlaceableItem, Partial<Record<PartTone, string>>> = {
  table: { top: '#c79a6a', frame: '#5a4535' },
  desk: { top: '#d9b88f', frame: '#7d6047' },
  chair: { seat: '#3e4a5a', frame: '#23272e' },
  counter: { body: '#d7dce2', top: '#7f8a96' },
  vent: { frame: '#dfe6ee', grille: '#9db2c7' },
};
import { floorSurface, slabCutouts } from '@/lib/floor-surfaces';
import { ViewCube } from './scene/viewcube';

export type SceneTool = 'pan' | 'select' | 'wall' | 'box' | 'erase' | 'door' | 'window' | 'exit' | 'slab' | 'stair' | 'place';
/** Population brush (Simulate, D76): strokes change where people start, never how many. */
export interface PaintBrush { radiusM: number; mode: 'increase' | 'decrease' | 'erase' }
export interface PaintStroke { points: Vec2[]; radiusM: number; mode: PaintBrush['mode'] }
export type PeopleView = 'discrete' | 'heatmap';
export type HeatField = 'people.density' | 'people.congestion';
export type HeatStat = 'instant' | 'timeAverage' | 'perCellPeak';
export interface SceneLayer { family: 'people' | 'air'; people: PeopleView; field: HeatField; stat: HeatStat }
/** An explicit heatmap, e.g. a before/after difference map (diverging palette). */
export interface HeatOverlay { field: ScalarField; diverging: boolean; airflow?: FloorAirflow }
export interface SceneNote { key: string; text: string; entityId: string }
export interface SceneHit { wallId?: string; openingId?: string; slabId?: string; stairId?: string; placeableId?: string }
export interface SceneTag { key: string; text: string; at: Vec2; muted?: boolean }
export interface SceneHandle { view(view: 'top' | 'iso' | 'fit'): void; exportImage(): void }

interface Props {
  doc: EgressDocument | null;
  editing: boolean;
  inputBlocked: boolean;
  entryView: 'iso' | 'top' | null;
  onEntryFrame(view: 'iso' | 'top'): void;
  onEntryError(message: string): void;
  tool: SceneTool;
  wallType: WallMaterial;
  /** The floor being viewed and edited (D75). Floors below draw darker; floors above are hidden. */
  floorId?: string | null;
  /** Finish for the Floor tool (D74). */
  slabMaterial?: SlabMaterial;
  /** The + tool: which placeable a click places, and its rotation (degrees). */
  placeItem?: PlaceableItem;
  placeRotation?: number;
  /** When set outside Edit, left-drag paints population weights instead of orbiting. */
  paint?: PaintBrush | null;
  onPaint?(stroke: PaintStroke): void;
  selected: string | null;
  /** Entity ids drawn in suggestion blue (created or changed by a proposal). */
  highlight?: ReadonlySet<string>;
  notes?: SceneNote[];
  /** Room tags on the floor (Edit): click to correct a room's kind or name. */
  tags?: SceneTag[];
  onTag?(key: string, at: { x: number; y: number }): void;
  playback?: PlaybackController | null;
  layer: SceneLayer;
  theme?: SceneTheme;
  gridStyle?: GridStyle;
  overlay?: HeatOverlay | null;
  onSelect(id: string | null): void;
  onEdit(commands: EditCommand[]): void;
  onContext?(at: { x: number; y: number }, hit: SceneHit | null): void;
}

export type SceneTheme = 'black' | 'white' | 'blueprint';
export type GridStyle = 'lined' | 'dotted' | 'off';
const THEMES: Record<SceneTheme, { ground: string; dots: number }> = { white: { ground: '#ffffff', dots: 0.72 }, black: { ground: '#0b0c0e', dots: 0.7 }, blueprint: { ground: '#1c446f', dots: 1 } };
const SUGGEST = '#3d9bff';
const SELECT = '#ffb020';
const WALL_STYLE: Record<WallMaterial, { thicknessM: number }> = { normal: { thicknessM: 0.2 }, reinforced: { thicknessM: 0.3 }, glass: { thicknessM: 0.12 } };
const OPENING_WIDTH = { door: 0.9, window: 1.2, exit: 1.2 } as const;
const MAX_POLAR = Math.PI * 0.44;
const HEAT_MAX: Record<HeatField, number> = { 'people.density': 3.5, 'people.congestion': 2 };
const HEAT_BLEND_MS = 250;

const toWorld = (p: Vec2, h = 0) => new THREE.Vector3(p.x, h, -p.y);

/** The viewed floor: the requested one, else the lowest. */
function floorOf(doc: EgressDocument | null | undefined, floorId?: string | null): Floor | null {
  if (!doc) return null;
  const sorted = floorsByLevel(doc);
  return sorted.find(f => f.id === floorId) ?? sorted[0] ?? null;
}



function disposeChildren(group: THREE.Object3D) {
  for (const object of [...group.children]) {
    group.remove(object);
    object.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
  }
}

function extrude(points: Vec2[], height: number, material: THREE.Material, bottom = 0) {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, p.y)));
  const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false }), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = bottom;
  return mesh;
}

/** Cross-hatching for walls that hide the floor (D57): evenly spaced screen-space lines, no dither. */
function hatchable<M extends THREE.Material>(m: M): M {
  const hatch = { value: 0 };
  const spacing = { value: 7 * Math.min(globalThis.devicePixelRatio ?? 1, 2) };
  m.userData.hatch = hatch;
  m.onBeforeCompile = shader => {
    shader.uniforms.uHatch = hatch;
    shader.uniforms.uHatchSpacing = spacing;
    shader.fragmentShader = 'uniform float uHatch;\nuniform float uHatchSpacing;\n' + shader.fragmentShader.replace('void main() {', `void main() {
      if (uHatch > 0.5) {
        float a = mod(gl_FragCoord.x + gl_FragCoord.y, uHatchSpacing);
        float b = mod(gl_FragCoord.x - gl_FragCoord.y + 8192.0, uHatchSpacing);
        if (min(a, b) > uHatchSpacing * 0.17) discard;
      }`);
  };
  m.customProgramCacheKey = () => 'egress-hatch';
  return m;
}

/** The dot grid. `overlay` draws only the dots (transparent), for the grid raised to an upper floor (D75). */
function groundMaterial(theme: SceneTheme, overlay = false) {
  return new THREE.ShaderMaterial({
    transparent: overlay, depthWrite: !overlay,
    uniforms: { uBase: { value: new THREE.Color(THEMES[theme].ground) }, uDot: { value: new THREE.Color('#ffffff') }, uGain: { value: THEMES[theme].dots }, uOverlay: { value: overlay ? 1 : 0 }, uLined: { value: 0 } },
    vertexShader: `varying vec2 vPlan;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vPlan = vec2(w.x, -w.z); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uBase; uniform vec3 uDot; uniform float uGain; uniform float uOverlay; uniform float uLined; varying vec2 vPlan;
      float dots(vec2 p, float spacing, float radiusPx) {
        vec2 px = max(fwidth(p), vec2(1e-5));
        vec2 d = (fract(p / spacing + 0.5) - 0.5) * spacing;
        vec2 dist = abs(d / px);
        if (uLined > 0.5) return 1.0 - smoothstep(0.0, 1.1, min(dist.x, dist.y));
        return 1.0 - smoothstep(radiusPx - 0.6, radiusPx + 0.6, length(dist));
      }
      void main() {
        float mpp = max(fwidth(vPlan.x), fwidth(vPlan.y));
        float minor = dots(vPlan, 0.25, 0.85) * 0.30 * (1.0 - smoothstep(0.035, 0.07, mpp));
        float major = dots(vPlan, 1.0, 1.25) * 0.62 * (1.0 - smoothstep(0.15, 0.3, mpp));
        float coarse = dots(vPlan, 5.0, 1.5) * 0.55;
        float d = uGain * max(max(minor, major), coarse);
        gl_FragColor = uOverlay > 0.5 ? vec4(uDot, d) : vec4(mix(uBase, uDot, d), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * Smooth heatmap (D71): cubic B-spline sampling over walkable cells only (walls never bleed),
 * a blend from the previous sample to the next over `uMix`, and the palette applied after
 * interpolation, so heat reads as smooth curves rather than 0.25 m squares.
 */
function heatMaterial() {
  const texture = () => { const t = new THREE.DataTexture(new Float32Array(2), 1, 1, THREE.RGFormat, THREE.FloatType); t.needsUpdate = true; return t; };
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uPrev: { value: texture() }, uNext: { value: texture() }, uMix: { value: 1 }, uScale: { value: 1 },
      uDiverging: { value: 0 }, uAir: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `precision highp float;
      uniform sampler2D uPrev; uniform sampler2D uNext; uniform float uMix; uniform float uScale; uniform float uDiverging; uniform float uAir; uniform vec2 uSize;
      varying vec2 vUv;
      float bspline(float x) { x = abs(x); if (x < 1.0) return (4.0 - 6.0 * x * x + 3.0 * x * x * x) / 6.0; if (x < 2.0) { float t = 2.0 - x; return t * t * t / 6.0; } return 0.0; }
      float smoothSample(sampler2D tex, vec2 uv) {
        vec2 p = uv * uSize - 0.5; vec2 i = floor(p); vec2 f = p - i;
        float sum = 0.0, weights = 0.0;
        for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
          ivec2 c = clamp(ivec2(i) + ivec2(x, y), ivec2(0), ivec2(uSize) - 1);
          vec2 cell = texelFetch(tex, c, 0).rg;
          float w = bspline(float(x) - f.x) * bspline(float(y) - f.y) * cell.g;
          sum += cell.r * w; weights += w;
        }
        return weights > 0.0 ? sum / weights : 0.0;
      }
      void main() {
        if (texelFetch(uNext, ivec2(floor(vUv * uSize)), 0).g < 0.5) discard;
        float v = mix(smoothSample(uPrev, vUv), smoothSample(uNext, vUv), uMix);
        float t = clamp(abs(v) / uScale, 0.0, 1.0);
        if (t < 0.004) discard;
        vec3 c;
        if (uAir > 0.5) c = mix(vec3(0.72, 0.94, 0.95), vec3(0.03, 0.43, 0.63), sqrt(t));
        else if (uDiverging > 0.5) c = v < 0.0 ? vec3(0.27, 0.86, 1.0) : vec3(1.0, 0.33, 0.25);
        else if (t < 0.5) c = mix(vec3(1.0, 0.88, 0.43), vec3(1.0, 0.55, 0.16), t / 0.5);
        else c = mix(vec3(1.0, 0.55, 0.16), vec3(0.88, 0.12, 0.16), (t - 0.5) / 0.5);
        gl_FragColor = vec4(c, (70.0 + 170.0 * sqrt(t)) / 255.0);
      }`,
  });
}

function airArrows(flow: FloorAirflow) {
  const { grid, values } = flow.magnitude;
  const points: number[] = [];
  const stride = Math.max(6, Math.ceil(Math.max(grid.width, grid.height) / 35));
  for (let row = stride >> 1; row < grid.height; row += stride) {
    for (let col = stride >> 1; col < grid.width; col += stride) {
      const i = row * grid.width + col, speed = values[i];
      if (!(speed > 0.002)) continue;
      const dx = flow.x[i] / speed, dy = flow.y[i] / speed;
      const x = grid.origin.x + (col + 0.5) * grid.cellSizeM, y = grid.origin.y + (row + 0.5) * grid.cellSizeM;
      const half = Math.min(0.34, 0.2 * stride * grid.cellSizeM), head = half * 0.7;
      const tipX = x + dx * half, tipY = y + dy * half;
      points.push(x - dx * half, 0, -(y - dy * half), tipX, 0, -tipY);
      for (const side of [-1, 1]) points.push(tipX, 0, -tipY, tipX - head * dx + side * head * dy * 0.6, 0, -(tipY - head * dy - side * head * dx * 0.6));
    }
  }
  return new THREE.Float32BufferAttribute(points, 3);
}

interface Runtime {
  camera: THREE.OrthographicCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  walls: THREE.Group;
  floors: THREE.Group;
  /** Dots-only grid raised to the viewed floor; the ground then renders only the background. */
  grid: THREE.Mesh;
  ground: THREE.Mesh;
  library: WallLibrary;
  cube: ViewCube;
  anchors: Map<string, THREE.Vector3>;
  dirty: boolean;
  geometryChanged: boolean;
  viewedFloor: number;
  afterFrame?: () => void;
  bounds: { center: THREE.Vector3; extent: number };
  frame(view: 'top' | 'iso' | 'fit', animate?: boolean): void;
  cancel(): void;
}

const EgressScene = forwardRef<SceneHandle, Props>(function EgressScene(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const cubeHost = useRef<HTMLDivElement>(null);
  const dim = useRef<HTMLDivElement>(null);
  const noteEls = useRef(new Map<string, HTMLDivElement>());
  const tagEls = useRef(new Map<string, HTMLButtonElement>());
  const runtime = useRef<Runtime | null>(null);
  const latest = useRef(props);
  const framedProject = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [library, setLibrary] = useState<WallLibrary | null>(null);
  useEffect(() => { latest.current = props; if (runtime.current) runtime.current.dirty = true; });
  useEffect(() => { let live = true; void WallLibrary.load().then(l => { if (live) setLibrary(l); }); return () => { live = false; }; }, []);

  useImperativeHandle(ref, () => ({
    view(view) { runtime.current?.frame(latest.current.editing && view === 'iso' ? 'top' : view); },
    exportImage() {
      const r = runtime.current; if (!r) return;
      r.renderer.render(r.scene, r.camera);
      const a = document.createElement('a'); a.download = 'egress-plan.png'; a.href = r.renderer.domElement.toDataURL('image/png'); a.click();
    },
  }), []);

  // ── Renderer, camera, input (once) ────────────────────────────────────────
  useEffect(() => {
    if (!library) return;
    const node = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch { queueMicrotask(() => setError('3D rendering is unavailable in this browser.')); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.type = THREE.PCFShadowMap;
    const theme = latest.current.theme ?? 'blueprint';
    renderer.setClearColor(THEMES[theme].ground);
    node.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#5d7896', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 2.0); sun.position.set(14, 26, 9); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40 }); sun.shadow.normalBias = 0.03;
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMaterial(theme));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.renderOrder = -1;
    const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.22 }));
    shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.y = -0.005; shadowCatcher.receiveShadow = true;
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMaterial(theme, true));
    grid.rotation.x = -Math.PI / 2; grid.visible = false; grid.renderOrder = 1;
    const walls = new THREE.Group(), floors = new THREE.Group(), preview = new THREE.Group();
    scene.add(ground, shadowCatcher, grid, floors, walls, preview);
    const brush = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthTest: false }));
    brush.rotation.x = -Math.PI / 2; brush.renderOrder = 10; brush.visible = false; scene.add(brush);

    const ring = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.11, 24), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false }));
    ring.rotation.x = -Math.PI / 2; ring.renderOrder = 10; ring.visible = false; scene.add(ring);

    const people = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 12, 8), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }), 4000);
    people.count = 0; people.frustumCulled = false; scene.add(people);
    const heat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), heatMaterial());
    heat.rotation.x = -Math.PI / 2; heat.position.y = 0.03; heat.visible = false; heat.renderOrder = 2; scene.add(heat);
    const arrows = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#184b68', depthWrite: false }));
    arrows.visible = false; arrows.renderOrder = 3; scene.add(arrows);
    let heatKey = '', lastHeat = -Infinity, lastSample = '';
    let lastHeatSource: ScalarField | PlaybackController | null = null;

    const camera = new THREE.OrthographicCamera(-15, 15, 15, -15, 0.05, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.14; controls.screenSpacePanning = true;
    controls.minPolarAngle = 0; controls.maxPolarAngle = MAX_POLAR; controls.minZoom = 0.25; controls.maxZoom = 12;

    const bounds = { center: new THREE.Vector3(), extent: 16 };
    let transition: { start: number; from: THREE.Vector3; to: THREE.Vector3; targetFrom: THREE.Vector3; targetTo: THREE.Vector3; zoomFrom: number; zoomTo: number } | null = null;
    const distance = () => Math.max(80, bounds.extent * 4);
    const fitFrustum = () => {
      const half = Math.max(8, bounds.extent) * 0.62, aspect = Math.max(0.2, node.clientWidth / Math.max(1, node.clientHeight));
      camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half; camera.updateProjectionMatrix();
    };
    const aim = (direction: THREE.Vector3, opts: { animate?: boolean; target?: THREE.Vector3; zoom?: number } = {}) => {
      const dir = direction.clone().normalize();
      const elevation = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      const minElevation = Math.PI / 2 - MAX_POLAR;
      if (elevation < minElevation) { // keep the camera above the floor
        const flat = new THREE.Vector3(dir.x, 0, dir.z);
        if (flat.lengthSq() < 1e-6) flat.set(0, 0, 1);
        flat.normalize().multiplyScalar(Math.cos(minElevation)); dir.set(flat.x, Math.sin(minElevation), flat.z);
      }
      if (Math.abs(dir.x) < 1e-4 && Math.abs(dir.z) < 1e-4) dir.set(0, 1, 0.0006).normalize(); // straight down, north up
      const target = opts.target ?? controls.target.clone();
      const to = target.clone().addScaledVector(dir, distance());
      const zoom = opts.zoom ?? camera.zoom;
      if (opts.animate !== false && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        transition = { start: performance.now(), from: camera.position.clone(), to, targetFrom: controls.target.clone(), targetTo: target, zoomFrom: camera.zoom, zoomTo: zoom };
      } else {
        transition = null; camera.position.copy(to); controls.target.copy(target); camera.zoom = zoom; camera.updateProjectionMatrix(); controls.update();
      }
    };
    const cube = new ViewCube(
      (dTheta, dPhi) => {
        if (latest.current.editing) return;
        transition = null;
        const offset = camera.position.clone().sub(controls.target);
        const s = new THREE.Spherical().setFromVector3(offset);
        s.theta += dTheta; s.phi = THREE.MathUtils.clamp(s.phi + dPhi, 0.0006, MAX_POLAR);
        camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(s));
        controls.update();
      },
      dir => aim(latest.current.editing ? new THREE.Vector3(0, 1, 0) : dir),
    );
    cubeHost.current?.appendChild(cube.element);

    let anchor: Vec2 | null = null, chainStart: Vec2 | null = null;
    let down: { at: Vec2 | null; px: Vec2; button: number } | null = null;
    let stroke: Vec2[] | null = null;
    const workFloor = () => floorOf(latest.current.doc, latest.current.floorId);
    const workHeight = () => workFloor()?.elevationM ?? 0;
    let roomCache: { doc: EgressDocument; rooms: ReturnType<typeof deriveLayout>['topology']['rooms'] } | null = null;
    const roomAt = (p: Vec2, floorId: string) => {
      const doc = latest.current.doc; if (!doc) return null;
      if (roomCache?.doc !== doc) roomCache = { doc, rooms: deriveLayout(doc).topology.rooms };
      return roomCache.rooms.find(r => r.floorId === floorId && pointInPolygon(p, r.polygon)) ?? null;
    };
    let spaceHeld = false;
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const r: Runtime = {
      camera, controls, renderer, scene, walls, floors, grid, ground, library, cube, anchors: new Map(), bounds, dirty: true, geometryChanged: true, viewedFloor: 0,
      cancel() { r.dirty = true; anchor = null; chainStart = null; stroke = null; disposeChildren(preview); if (dim.current) dim.current.hidden = true; },
      frame(view, animate = true) {
        r.cancel();
        const vs = latest.current.doc?.vertices ?? [];
        if (vs.length) {
          const xs = vs.map(v => v.position.x), ys = vs.map(v => v.position.y);
          bounds.center.set((Math.min(...xs) + Math.max(...xs)) / 2, 0, -(Math.min(...ys) + Math.max(...ys)) / 2);
          bounds.extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 10);
        } else {
          bounds.center.set(0, 0, 0); bounds.extent = 16;
        }
        fitFrustum();
        const top = view === 'top' || (view === 'fit' && latest.current.editing);
        const dir = top ? new THREE.Vector3(0, 1, 0) : view === 'iso' || view === 'fit' ? new THREE.Vector3(0.9, 1.05, 1.15) : new THREE.Vector3(0, 1, 0);
        aim(view === 'fit' && !latest.current.editing ? camera.position.clone().sub(controls.target) : dir, { animate, target: bounds.center.clone(), zoom: 1 });
      },
    };
    const invalidate = () => { r.dirty = true; };
    controls.addEventListener('change', invalidate);
    runtime.current = r;
    r.frame('top', false);

    const ndc = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
    };
    const groundAt = (e: PointerEvent): Vec2 | null => {
      plane.constant = -workHeight();
      ray.setFromCamera(ndc(e), camera);
      const p = ray.ray.intersectPlane(plane, new THREE.Vector3());
      return p ? { x: p.x, y: -p.z } : null;
    };
    /** Snap to an existing vertex within 0.3 m, else to the 0.25 m dot grid. */
    const snap = (p: Vec2): Vec2 => {
      let best: Vec2 | null = null, bestD = 0.3;
      const floorId = workFloor()?.id;
      for (const v of latest.current.doc?.vertices ?? []) {
        if (v.floorId !== floorId) continue;
        const d = Math.hypot(v.position.x - p.x, v.position.y - p.y);
        if (d < bestD) { bestD = d; best = v.position; }
      }
      return best ?? { x: Math.round(p.x * 4) / 4, y: Math.round(p.y * 4) / 4 };
    };
    const constrain = (a: Vec2, b: Vec2, free: boolean): Vec2 => free ? b : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    /** Openings, then walls, stairs and floor surfaces on the viewed floor. */
    const pick = (e: PointerEvent): SceneHit | null => {
      ray.setFromCamera(ndc(e), camera);
      const floorId = workFloor()?.id;
      const hits = ray.intersectObjects([...walls.children, ...floors.children], true)
        .filter(h => h.object.userData.floorId === floorId && !h.object.userData.below);
      const hit = hits.find(h => h.object.userData.openingId) ?? hits.find(h => h.object.userData.wallId) ?? hits.find(h => h.object.userData.placeableId) ?? hits.find(h => h.object.userData.stairId) ?? hits.find(h => h.object.userData.slabId);
      if (!hit) return null;
      const { wallId, openingId, slabId, stairId, placeableId } = hit.object.userData as SceneHit;
      return { wallId, openingId, slabId, stairId, placeableId };
    };
    const showDim = (e: PointerEvent, text: string) => {
      const el = dim.current; if (!el) return;
      const rect = node.getBoundingClientRect();
      el.hidden = false; el.textContent = text;
      // Keep the label inside the viewport.
      const x = Math.min(e.clientX - rect.left + 16, rect.width - el.offsetWidth - 8);
      const y = Math.min(e.clientY - rect.top + 14, rect.height - el.offsetHeight - 8);
      el.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
    };
    const line = (points: Vec2[], color = '#ffffff') => {
      const h = workHeight() + 0.06;
      preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(p => toWorld(p, h))), new THREE.LineBasicMaterial({ color, depthTest: false })));
    };
    const rectangle = (a: Vec2, b: Vec2, color = '#ffffff') => line([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a], color);
    const nearestWall = (p: Vec2) => {
      const doc = latest.current.doc; if (!doc) return null;
      const vertices = new Map(doc.vertices.map(v => [v.id, v.position]));
      const floorId = workFloor()?.id;
      let best: { wallId: string; a: Vec2; b: Vec2; t: number; distance: number; length: number; thickness: number } | null = null;
      for (const w of doc.walls) {
        if (w.floorId !== floorId) continue;
        const a = vertices.get(w.startVertexId), b = vertices.get(w.endVertexId);
        if (!a || !b) continue;
        const hit = projectOnSegment(p, a, b);
        if (!best || hit.distance < best.distance) best = { wallId: w.id, a, b, t: hit.t, distance: hit.distance, length: Math.hypot(b.x - a.x, b.y - a.y), thickness: w.thicknessM };
      }
      return best && best.distance < 0.65 ? best : null;
    };
    const openingPlacement = (p: Vec2, kind: 'door' | 'window' | 'exit') => {
      const w = nearestWall(p); if (!w) return null;
      const width = Math.min(OPENING_WIDTH[kind], w.length - 0.1);
      if (width < 0.5) return null;
      const offset = THREE.MathUtils.clamp(Math.round(w.t * w.length * 20) / 20, width / 2 + 0.05, w.length - width / 2 - 0.05);
      return { ...w, offset, width };
    };

    const painting = () => !latest.current.editing && !!latest.current.paint;
    const onDown = (e: PointerEvent) => {
      r.dirty = true;
      if (painting() && e.button === 0 && !transition) {
        const at = groundAt(e); if (!at) return;
        stroke = [at]; renderer.domElement.setPointerCapture(e.pointerId); return;
      }
      if (!latest.current.editing || transition) return;
      if (e.button === 1 || (e.button === 0 && (spaceHeld || latest.current.tool === 'pan'))) return; // OrbitControls pans
      down = { at: groundAt(e), px: { x: e.clientX, y: e.clientY }, button: e.button };
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      r.dirty = true;
      const state = latest.current;
      if (painting()) {
        ring.visible = false;
        const at = groundAt(e); if (!at) return;
        const radius = state.paint!.radiusM;
        brush.visible = true; brush.scale.setScalar(radius); brush.position.set(at.x, workHeight() + 0.08, -at.y);
        (brush.material as THREE.MeshBasicMaterial).color.set(state.paint!.mode === 'increase' ? '#ffc65c' : state.paint!.mode === 'decrease' ? '#6fc3ff' : '#ffffff');
        if (stroke) {
          const last = stroke[stroke.length - 1];
          if (Math.hypot(at.x - last.x, at.y - last.y) >= radius / 4 && stroke.length < 4096) { stroke.push(at); disposeChildren(preview); line(stroke, '#ffc65c'); }
        }
        return;
      }
      brush.visible = false;
      if (!state.editing || spaceHeld || state.tool === 'pan') { ring.visible = false; return; }
      const raw = groundAt(e); if (!raw) return;
      const p = snap(raw), tool = state.tool;
      ring.visible = tool !== 'select' && !spaceHeld;
      ring.position.set(p.x, workHeight() + 0.02, -p.y);
      disposeChildren(preview);
      if (dim.current) dim.current.hidden = true;
      const dragging = down?.button === 0 && down.at ? snap(down.at) : null;
      if (tool === 'wall' && (anchor || dragging)) {
        const a = anchor ?? dragging!, b = constrain(a, p, e.shiftKey);
        line([a, b]); showDim(e, `${Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} m`);
      } else if (tool === 'box' && dragging) {
        line([dragging, { x: p.x, y: dragging.y }, p, { x: dragging.x, y: p.y }, dragging]);
        showDim(e, `${Math.abs(p.x - dragging.x).toFixed(2)} × ${Math.abs(p.y - dragging.y).toFixed(2)} m`);
      } else if (tool === 'erase' && dragging) {
        line([dragging, p], '#ff8a80');
      } else if (tool === 'slab') {
        if (dragging) { rectangle(dragging, p, '#ffc65c'); showDim(e, `${Math.abs(p.x - dragging.x).toFixed(2)} × ${Math.abs(p.y - dragging.y).toFixed(2)} m`); }
        else {
          const floor = workFloor(), slab = floor && state.doc?.slabs.find(sl => sl.floorId === floor.id && pointInPolygon(raw, sl.polygon));
          const outline = slab ? slab.polygon : floor ? roomAt(raw, floor.id)?.polygon : null;
          if (outline) { line([...outline, outline[0]], '#ffc65c'); ring.visible = false; }
        }
      } else if (tool === 'place') {
        const item = state.placeItem ?? 'table';
        const corners = placeableFootprint({ item, position: p, rotationDeg: state.placeRotation ?? 0 });
        line([...corners, corners[0]], PLACEABLES[item].suppliesAir ? '#6fc3ff' : '#ffc65c');
        showDim(e, `${PLACEABLES[item].name} · R rotates`);
        ring.visible = false;
      } else if (tool === 'stair' && dragging) {
        rectangle(dragging, p, '#7dc8ff');
        const up = upEdgeOf(dragging, p), c = { x: (dragging.x + p.x) / 2, y: (dragging.y + p.y) / 2 };
        const tip = { x: up === 'e' ? Math.max(dragging.x, p.x) : up === 'w' ? Math.min(dragging.x, p.x) : c.x, y: up === 'n' ? Math.max(dragging.y, p.y) : up === 's' ? Math.min(dragging.y, p.y) : c.y };
        line([c, tip], '#7dc8ff');
        showDim(e, `${Math.abs(p.x - dragging.x).toFixed(2)} × ${Math.abs(p.y - dragging.y).toFixed(2)} m · up`);
      } else if (tool === 'door' || tool === 'window' || tool === 'exit') {
        const o = openingPlacement(raw, tool);
        if (o) {
          const ux = (o.b.x - o.a.x) / o.length, uy = (o.b.y - o.a.y) / o.length;
          const c = { x: o.a.x + ux * o.offset, y: o.a.y + uy * o.offset };
          const half = o.width / 2, n = { x: -uy * (o.thickness / 2 + 0.08), y: ux * (o.thickness / 2 + 0.08) };
          line([{ x: c.x - ux * half + n.x, y: c.y - uy * half + n.y }, { x: c.x + ux * half + n.x, y: c.y + uy * half + n.y }, { x: c.x + ux * half - n.x, y: c.y + uy * half - n.y }, { x: c.x - ux * half - n.x, y: c.y - uy * half - n.y }, { x: c.x - ux * half + n.x, y: c.y - uy * half + n.y }], tool === 'exit' ? '#7dffa8' : '#ffffff');
          showDim(e, `${o.width.toFixed(2)} m`);
          ring.visible = false;
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      r.dirty = true;
      const state = latest.current, start = down;
      down = null;
      if (stroke) {
        const points = stroke; stroke = null; disposeChildren(preview);
        if (state.paint && state.onPaint) state.onPaint({ points, radiusM: state.paint.radiusM, mode: state.paint.mode });
        return;
      }
      if (!state.editing || !start || transition) return;
      const moved = Math.hypot(e.clientX - start.px.x, e.clientY - start.px.y) > 5;
      const raw = groundAt(e);
      if (start.button === 2) {
        if (anchor) { r.cancel(); return; } // right-click ends a wall chain
        if (!moved) {
          const rect = node.getBoundingClientRect();
          state.onContext?.({ x: e.clientX - rect.left, y: e.clientY - rect.top }, pick(e));
        }
        return;
      }
      if (start.button !== 0 || !raw || !state.doc) return;
      const p = snap(raw), floorId = workFloor()?.id;
      if (!floorId) return;
      const spec = { floorId, thicknessM: WALL_STYLE[state.wallType].thicknessM, heightM: 2.8, material: state.wallType };
      const from = start.at ? snap(start.at) : null;
      if (state.tool === 'wall') {
        if (!anchor && moved && from) {
          const b = constrain(from, p, e.shiftKey);
          if (Math.hypot(b.x - from.x, b.y - from.y) >= 0.25) state.onEdit([{ kind: 'createWallChain', points: [from, b], ...spec }]);
          return;
        }
        if (!anchor) { anchor = p; chainStart = p; return; }
        const b = constrain(anchor, p, e.shiftKey);
        if (Math.hypot(b.x - anchor.x, b.y - anchor.y) >= 0.25) state.onEdit([{ kind: 'createWallChain', points: [anchor, b], ...spec }]);
        const closed = chainStart && Math.hypot(b.x - chainStart.x, b.y - chainStart.y) < 0.01;
        if (closed) r.cancel(); else anchor = b;
      } else if (state.tool === 'box' && from && moved) {
        if (Math.abs(p.x - from.x) >= 0.5 && Math.abs(p.y - from.y) >= 0.5) {
          state.onEdit([{ kind: 'createBox', min: { x: Math.min(from.x, p.x), y: Math.min(from.y, p.y) }, max: { x: Math.max(from.x, p.x), y: Math.max(from.y, p.y) }, ...spec }]);
        }
      } else if (state.tool === 'erase') {
        if (from && moved) state.onEdit([{ kind: 'eraseByLine', floorId, from, to: p }]);
        else { const hit = pick(e); const id = hit?.openingId ?? hit?.wallId ?? hit?.placeableId ?? hit?.stairId ?? hit?.slabId; if (id) state.onEdit([{ kind: 'deleteEntities', ids: [id] }]); }
      } else if (state.tool === 'select') {
        const hit = pick(e); state.onSelect(hit?.openingId ?? hit?.wallId ?? hit?.placeableId ?? hit?.stairId ?? hit?.slabId ?? null);
      } else if (state.tool === 'place' && !moved) {
        state.onEdit([{ kind: 'createPlaceable', floorId, item: state.placeItem ?? 'table', position: p, rotationDeg: state.placeRotation ?? 0 }]);
      } else if (state.tool === 'slab') {
        const material = state.slabMaterial ?? 'wood';
        if (from && moved) {
          if (Math.abs(p.x - from.x) >= 0.5 && Math.abs(p.y - from.y) >= 0.5) {
            const x0 = Math.min(from.x, p.x), x1 = Math.max(from.x, p.x), y0 = Math.min(from.y, p.y), y1 = Math.max(from.y, p.y);
            state.onEdit([{ kind: 'createSlab', floorId, polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], material }]);
          }
        } else {
          // Click: refinish the surface under the pointer, else fill the room.
          ray.setFromCamera(ndc(e), camera);
          const surface = ray.intersectObjects(floors.children).find(hit => hit.object.userData.slabId && hit.object.userData.floorId === floorId);
          const slab = surface && state.doc.slabs.find(sl => sl.id === surface.object.userData.slabId);
          if (slab) { if (slab.material !== material) state.onEdit([{ kind: 'updateSlab', slabId: slab.id, patch: { material } }]); }
          else { const room = roomAt(raw, floorId); if (room) state.onEdit([{ kind: 'createSlab', floorId, polygon: room.polygon, material }]); }
        }
      } else if (state.tool === 'stair' && from && moved) {
        if (Math.abs(p.x - from.x) >= 0.8 && Math.abs(p.y - from.y) >= 0.8) state.onEdit([{ kind: 'createStair', floorId, min: from, max: p, upEdge: upEdgeOf(from, p) }]);
      } else if (state.tool === 'door' || state.tool === 'window' || state.tool === 'exit') {
        const o = openingPlacement(raw, state.tool);
        if (o) state.onEdit([{ kind: 'createOpening', wallId: o.wallId, openingKind: state.tool, offsetM: o.offset, widthM: o.width }]);
      }
      disposeChildren(preview);
      if (dim.current && state.tool !== 'wall') dim.current.hidden = true;
    };
    const onLeave = () => { r.dirty = true; ring.visible = false; brush.visible = false; };
    const keydown = (e: KeyboardEvent) => {
      if (latest.current.inputBlocked || (e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') r.cancel();
      if (e.code === 'Space' && latest.current.editing && !spaceHeld) { spaceHeld = true; controls.mouseButtons.LEFT = THREE.MOUSE.PAN; renderer.domElement.style.cursor = 'grab'; }
    };
    const restorePointer = () => {
      spaceHeld = false;
      const state = latest.current;
      if (state.editing) controls.mouseButtons.LEFT = state.tool === 'pan' ? THREE.MOUSE.PAN : null as unknown as THREE.MOUSE;
      renderer.domElement.style.cursor = '';
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.code === 'Space' && spaceHeld) { restorePointer(); }
    };
    const noMenu = (e: Event) => e.preventDefault();
    const el = renderer.domElement;
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave); el.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', restorePointer);

    const resize = new ResizeObserver(() => {
      r.dirty = true;
      renderer.setSize(node.clientWidth, node.clientHeight);
      const half = camera.top, aspect = node.clientWidth / Math.max(1, node.clientHeight);
      camera.left = -half * aspect; camera.right = half * aspect; camera.updateProjectionMatrix();
    });
    resize.observe(node);

    const matrix = new THREE.Matrix4(), color = new THREE.Color(), screen = new THREE.Vector3();
    const amber = new THREE.Color('#ffc65c'), queued = new THREE.Color('#ff6a3d');
    let raf = 0, lastHatch = 0;
    const hatchOrientation = new THREE.Quaternion();
    let lastEditing: boolean | null = null;
    let lastActorFloor = -1;
    let lastPlayback: PlaybackController | null = null;
    let lastActorState: ReturnType<PlaybackController['state']['get']> | undefined;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const state = latest.current;
      if (transition) {
        const t = Math.min(1, (now - transition.start) / 600), k = t * t * (3 - 2 * t);
        const a = transition.from.clone().sub(transition.targetFrom), b = transition.to.clone().sub(transition.targetTo);
        const q = new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
        const dir = a.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(q, k));
        controls.target.lerpVectors(transition.targetFrom, transition.targetTo, k);
        camera.position.copy(controls.target).addScaledVector(dir, THREE.MathUtils.lerp(a.length(), b.length(), k));
        camera.zoom = THREE.MathUtils.lerp(transition.zoomFrom, transition.zoomTo, k); camera.updateProjectionMatrix();
        if (t === 1) transition = null;
      }
      const cameraChanged = controls.update();
      cube.sync(camera, controls.target);

      // Cross-hatch walls that hide the floor; never in top-down views (D57).
      if (r.geometryChanged || lastEditing !== state.editing || (now - lastHatch > 150 && !hatchOrientation.equals(camera.quaternion))) {
        r.geometryChanged = false;
        lastEditing = state.editing;
        hatchOrientation.copy(camera.quaternion);
        walls.updateWorldMatrix(true, true);
        renderer.shadowMap.needsUpdate = true;
        r.dirty = true;
        lastHatch = now;
        const offset = camera.position.clone().sub(controls.target).normalize();
        const topDown = offset.y > Math.cos(THREE.MathUtils.degToRad(14));
        const hide = new Set<string>();
        if (!state.editing && !topDown && state.doc) {
          const direction = camera.getWorldDirection(new THREE.Vector3());
          const viewed = floorOf(state.doc, state.floorId);
          const heights = new Map(state.doc.floors.filter(f => !viewed || f.level <= viewed.level).map(f => [f.id, f.elevationM]));
          for (const room of deriveLayout(state.doc).topology.rooms) {
            const h = heights.get(room.floorId); if (h === undefined) continue;
            const c = room.polygon.reduce((s, p) => ({ x: s.x + p.x / room.polygon.length, y: s.y + p.y / room.polygon.length }), { x: 0, y: 0 });
            const samples = [c, ...room.polygon.slice(0, 12).map(p => ({ x: p.x * 0.8 + c.x * 0.2, y: p.y * 0.8 + c.y * 0.2 }))];
            for (const p of samples) {
              const target = toWorld(p, h + 0.05);
              ray.set(target.clone().addScaledVector(direction, -200), direction); ray.far = 199.9;
              for (const h of ray.intersectObjects(walls.children, true)) if (h.object.userData.wallId) hide.add(h.object.userData.wallId);
            }
          }
          ray.far = Infinity;
        }
        walls.traverse(o => {
          if (!(o instanceof THREE.Mesh)) return;
          const hatched = hide.has(o.userData.wallId) && !o.userData.highlight;
          const u = (o.material as THREE.Material).userData.hatch as { value: number } | undefined;
          if (u) u.value = hatched ? 1 : 0;
          o.castShadow = !state.editing && !hatched && !o.userData.glass;
        });
      }

      // People layer.
      const playback = state.playback;
      const discrete = state.layer.family !== 'people' || state.layer.people === 'discrete' ? playback ?? null : null;
      const actorState = discrete?.state.get();
      if (discrete !== lastPlayback || actorState !== lastActorState || r.viewedFloor !== lastActorFloor) {
        lastActorFloor = r.viewedFloor;
        lastPlayback = discrete;
        lastActorState = actorState;
        r.dirty = true;
        const actors = discrete?.actorsNow();
        people.count = actors ? Math.min(actors.actorFlags.length, 4000) : 0;
        if (actors) {
          for (let i = 0; i < people.count; i++) {
            const flag = actors.actorFlags[i], floor = actors.actorFloor?.[i] ?? 0;
            const onVisibleStair = flag === ACTOR_TRANSITIONING && floor === r.viewedFloor + 1;
            const gone = flag === ACTOR_EXITED || (floor > r.viewedFloor && !onVisibleStair);
            matrix.makeScale(gone ? 0 : 1, gone ? 0 : 1, gone ? 0 : 1);
            matrix.setPosition(actors.actorXY[i * 2], (actors.actorElevation?.[i] ?? 0) + 0.2, -actors.actorXY[i * 2 + 1]);
            people.setMatrixAt(i, matrix);
            people.setColorAt(i, color.copy(flag === ACTOR_QUEUED ? queued : amber));
          }
          people.instanceMatrix.needsUpdate = true;
          if (people.instanceColor) people.instanceColor.needsUpdate = true;
        }
      }

      // Heatmap layer (or an explicit overlay such as a difference map): a new sample every
      // 250 ms, blended in from the previous one over the same 250 ms (D71).
      const heatUniforms = (heat.material as THREE.ShaderMaterial).uniforms;
      const overlay = state.overlay;
      const crowdHeat = state.layer.family === 'people' && state.layer.people === 'heatmap' ? playback : null;
      const source = overlay?.field ?? crowdHeat ?? null;
      const tick = crowdHeat?.state.get().tick ?? 0;
      const sample = overlay ? 'static' : `${state.floorId},${state.layer.field},${state.layer.stat},${Math.floor(tick / 5)}`;
      if ((source !== lastHeatSource || sample !== lastSample) && (source !== lastHeatSource || now - lastHeat >= HEAT_BLEND_MS)) {
        lastSample = sample; lastHeatSource = source;
        const field = overlay?.field ?? crowdHeat?.field(state.layer.field, state.layer.stat, state.floorId ?? undefined);
        r.dirty = true;
        heat.visible = !!field;
        arrows.visible = !!overlay?.airflow;
        if (field) {
          const g = field.grid, key = `${field.fieldId},${field.aggregation},${g.floorId},${g.origin.x},${g.origin.y},${g.width},${g.height},${g.cellSizeM}`;
          const next = new THREE.DataTexture(encodeField(field), g.width, g.height, THREE.RGFormat, THREE.FloatType);
          next.needsUpdate = true;
          const fresh = key !== heatKey || !!overlay;
          const prev = heatUniforms.uPrev.value as THREE.Texture, current = heatUniforms.uNext.value as THREE.Texture;
          if (prev !== current) prev.dispose();
          if (fresh) current.dispose();
          heatUniforms.uPrev.value = fresh ? next : current;
          heatUniforms.uNext.value = next;
          heatUniforms.uSize.value.set(g.width, g.height);
          heatUniforms.uScale.value = overlay?.airflow ? 0.25 : fieldScale(field, !!overlay?.diverging, HEAT_MAX[state.layer.field] ?? 2);
          heatUniforms.uDiverging.value = overlay?.diverging ? 1 : 0;
          heatUniforms.uAir.value = overlay?.airflow ? 1 : 0;
          lastHeat = fresh ? -Infinity : now;
          const elevation = state.doc?.floors.find(f => f.id === g.floorId)?.elevationM ?? 0;
          heat.scale.set(g.width * g.cellSizeM, g.height * g.cellSizeM, 1);
          heat.position.set(g.origin.x + g.width * g.cellSizeM / 2, elevation + 0.03, -(g.origin.y + g.height * g.cellSizeM / 2));
          if (overlay?.airflow) {
            arrows.geometry.dispose();
            arrows.geometry = new THREE.BufferGeometry();
            arrows.geometry.setAttribute('position', airArrows(overlay.airflow));
            arrows.position.y = elevation + 0.045;
          }
          heatKey = key;
        } else { heatKey = ''; }
      }
      const wasBlending = heatUniforms.uMix.value < 1;
      heatUniforms.uMix.value = Math.min(1, (now - lastHeat) / HEAT_BLEND_MS);

      if (!r.dirty && !cameraChanged && !transition && !r.afterFrame && !wasBlending && heatUniforms.uMix.value >= 1) return;
      r.dirty = false;
      renderer.render(scene, camera);
      if (!transition && r.afterFrame) {
        const done = r.afterFrame;
        r.afterFrame = undefined;
        done();
      }

      // Reason bubbles follow their entities.
      const w = node.clientWidth, h = node.clientHeight;
      for (const [key, anchorPoint] of r.anchors) {
        const bubble = noteEls.current.get(key); if (!bubble) continue;
        screen.copy(anchorPoint).project(camera);
        const visible = screen.z < 1 && Math.abs(screen.x) < 1.1 && Math.abs(screen.y) < 1.1;
        bubble.style.visibility = visible ? 'visible' : 'hidden';
        bubble.style.transform = `translate(${(screen.x + 1) / 2 * w}px, ${(1 - screen.y) / 2 * h}px)`;
      }
      // Room tags sit on the floor at each room's centre.
      const tagHeight = (floorOf(state.doc, state.floorId)?.elevationM ?? 0) + 0.05;
      for (const tag of latest.current.tags ?? []) {
        const el = tagEls.current.get(tag.key); if (!el) continue;
        screen.set(tag.at.x, tagHeight, -tag.at.y).project(camera);
        el.style.transform = `translate(${(screen.x + 1) / 2 * w}px, ${(1 - screen.y) / 2 * h}px) translate(-50%, -50%)`;
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      controls.removeEventListener('change', invalidate);
      cancelAnimationFrame(raf); resize.disconnect(); controls.dispose(); cube.dispose();
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave); el.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', restorePointer);
      disposeChildren(walls); disposeChildren(floors); disposeChildren(preview);
      for (const m of [ground, shadowCatcher, grid, brush, ring, people, heat, arrows]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      for (const k of ['uPrev', 'uNext']) ((heat.material as THREE.ShaderMaterial).uniforms[k].value as THREE.Texture).dispose();
      library.dispose(); renderer.dispose(); el.remove();
      runtime.current = null; framedProject.current = null;
    };
  }, [library]);

  // ── Mode: Edit is locked top-down ─────────────────────────────────────────
  useEffect(() => {
    const r = runtime.current; if (!r) return;
    r.cancel();
    r.controls.enableRotate = !props.editing;
    r.controls.mouseButtons = props.editing
      ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null as unknown as THREE.MOUSE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    r.controls.touches.ONE = props.editing ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    r.cube.setLocked(props.editing);
    r.frame(props.editing ? 'top' : 'iso');
  }, [props.editing, library]);
  useEffect(() => { runtime.current?.cancel(); }, [props.tool, props.wallType, props.floorId]);
  useEffect(() => {
    const r = runtime.current; if (!r || !props.editing) return;
    r.controls.mouseButtons.LEFT = props.tool === 'pan' ? THREE.MOUSE.PAN : null as unknown as THREE.MOUSE;
  }, [props.tool, props.editing, library]);
  // Painting (outside Edit) takes the left button; orbit returns when the brush is put away.
  const painting = !props.editing && !!props.paint;

  useEffect(() => {
    const r = runtime.current; if (!r || props.editing) return;
    r.controls.mouseButtons = { LEFT: painting ? (null as unknown as THREE.MOUSE) : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    r.controls.touches.ONE = painting ? (null as unknown as THREE.TOUCH) : THREE.TOUCH.ROTATE;
    r.renderer.domElement.style.cursor = painting ? 'crosshair' : '';
  }, [painting, props.editing, library]);

  const gridElevation = floorOf(props.doc, props.floorId)?.elevationM ?? 0;
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    const theme = props.theme ?? 'blueprint', style = props.gridStyle ?? 'dotted';
    const colors = THEMES[theme];
    r.renderer.setClearColor(colors.ground);
    for (const mesh of [r.ground, r.grid]) {
      const uniforms = (mesh.material as THREE.ShaderMaterial).uniforms;
      uniforms.uBase.value.set(colors.ground);
      uniforms.uDot.value.set(theme === 'white' ? '#445770' : '#ffffff');
      uniforms.uLined.value = style === 'lined' ? 1 : 0;
      uniforms.uGain.value = style === 'off' || (mesh === r.ground && gridElevation !== 0) ? 0 : colors.dots;
    }
    r.grid.visible = gridElevation !== 0 && style !== 'off';
    r.grid.position.y = gridElevation + 0.001;
    r.dirty = true;
  }, [props.theme, props.gridStyle, gridElevation, library]);

  const finishCuts = useMemo(() => slabCutouts(props.doc?.slabs ?? []), [props.doc?.slabs]);
  // ── Geometry ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const r = runtime.current; if (!r) return;
    r.geometryChanged = true;
    disposeChildren(r.walls); disposeChildren(r.floors);
    const doc = props.doc; if (!doc) return;
    const derived = deriveLayout(doc), highlight = props.highlight ?? new Set<string>();
    // Floors (D75): the viewed floor and those below it; below ones darker and not pickable.
    const viewed = floorOf(doc, props.floorId);
    const level = viewed?.level ?? 0;
    r.viewedFloor = floorsByLevel(doc).findIndex(f => f.id === viewed?.id);
    const shown = new Map(doc.floors.filter(f => f.level <= level).map(f => [f.id, f]));
    const height = (floorId: string) => shown.get(floorId)?.elevationM ?? 0;
    const below = (floorId: string) => (shown.get(floorId)?.level ?? 0) < level;
    const dimmed = <M extends THREE.MeshStandardMaterial>(m: M, floorId: string): M => {
      if (below(floorId)) { m.color.multiplyScalar(0.3); m.emissive.set('#000000'); }
      return m;
    };

    const byWall = new Map(doc.walls.map(w => [w.id, w]));
    const groups = new Map<string, THREE.Group>();
    const style = (m: THREE.MeshStandardMaterial, ids: string[]) => {
      if (ids.some(id => highlight.has(id))) { m.color.set(SUGGEST); m.emissive.set(SUGGEST); m.emissiveIntensity = 0.55; m.map = null; }
      else if (props.selected && ids.includes(props.selected)) { m.emissive.set(SELECT); m.emissiveIntensity = 0.45; }
      return m;
    };
    const tag = (mesh: THREE.Mesh, wallId: string, openingId?: string, glass = false) => {
      const floorId = byWall.get(wallId)?.floorId ?? '';
      mesh.userData = { wallId, openingId, floorId, below: below(floorId), glass, highlight: highlight.has(wallId) || (!!openingId && highlight.has(openingId)) };
      mesh.receiveShadow = true;
      return mesh;
    };
    for (const wall of doc.walls) {
      if (!shown.has(wall.floorId)) continue;
      const g = new THREE.Group(); groups.set(wall.id, g); r.walls.add(g);
    }
    const wallMaterial = (wallId: string) => {
      const wall = byWall.get(wallId)!;
      return dimmed(style(hatchable(r.library.material(wall)), [wallId]), wall.floorId);
    };
    for (const piece of derived.walls.pieces) {
      const wall = byWall.get(piece.wallId); if (!wall || !groups.has(wall.id)) continue;
      groups.get(wall.id)!.add(tag(extrude(piece.polygon, wall.heightM, wallMaterial(wall.id), height(wall.floorId)), wall.id, undefined, wall.material === 'glass'));
    }
    for (const hub of derived.walls.hubs) {
      const wall = doc.walls.find(w => w.startVertexId === hub.vertexId || w.endVertexId === hub.vertexId);
      if (wall && groups.has(wall.id)) groups.get(wall.id)!.add(tag(extrude(hub.polygon, wall.heightM, wallMaterial(wall.id), height(wall.floorId)), wall.id, undefined, wall.material === 'glass'));
    }
    const vertices = new Map(doc.vertices.map(v => [v.id, v.position]));
    const anchors = new Map<string, THREE.Vector3>();
    const entityAnchor = new Map<string, THREE.Vector3>();
    for (const wall of doc.walls) {
      const a = vertices.get(wall.startVertexId), b = vertices.get(wall.endVertexId);
      if (a && b) entityAnchor.set(wall.id, toWorld({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, height(wall.floorId) + wall.heightM + 0.2));
    }
    for (const o of doc.openings) {
      const wall = byWall.get(o.wallId); if (!wall || !groups.has(wall.id)) continue;
      const a = vertices.get(wall.startVertexId)!, b = vertices.get(wall.endVertexId)!;
      const angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.hypot(b.x - a.x, b.y - a.y);
      const center = { x: a.x + (b.x - a.x) * o.offsetM / length, y: a.y + (b.y - a.y) * o.offsetM / length };
      entityAnchor.set(o.id, toWorld(center, height(wall.floorId) + wall.heightM + 0.2));
      const group = new THREE.Group(); group.position.copy(toWorld(center, height(wall.floorId))); group.rotation.y = angle;
      groups.get(wall.id)!.add(group);
      const lit = highlight.has(o.id);
      const box = (width: number, height: number, depth: number, x: number, y: number, look: string | null, glass = false) => {
        const m = look ? new THREE.MeshStandardMaterial({ color: look, roughness: 0.6, transparent: glass, opacity: glass ? 0.35 : 1 }) : r.library.material(wall);
        const mesh = tag(new THREE.Mesh(new THREE.BoxGeometry(width, Math.max(0.005, height), depth), dimmed(style(hatchable(m), lit ? [o.id] : [wall.id, o.id]), wall.floorId)), wall.id, o.id, glass);
        mesh.position.set(x, y, 0); group.add(mesh); return mesh;
      };
      const top = o.sillHeightM + o.openingHeightM;
      const frame = o.openingKind === 'exit' ? '#3ddc84' : o.openingKind === 'door' ? '#d9c3a0' : '#eef3f8';
      if (o.sillHeightM > 0) box(o.widthM, o.sillHeightM, wall.thicknessM, 0, o.sillHeightM / 2, null, wall.material === 'glass');
      if (wall.heightM > top) box(o.widthM, wall.heightM - top, wall.thicknessM, 0, (wall.heightM + top) / 2, null, wall.material === 'glass');
      for (const x of [-o.widthM / 2 + 0.025, o.widthM / 2 - 0.025]) box(0.05, o.openingHeightM, wall.thicknessM + 0.03, x, o.sillHeightM + o.openingHeightM / 2, frame);
      box(o.widthM, 0.05, wall.thicknessM + 0.03, 0, top - 0.025, frame);
      if (o.openingKind === 'window') {
        box(o.widthM, 0.05, wall.thicknessM + 0.03, 0, o.sillHeightM + 0.025, frame);
        box(o.widthM - 0.1, o.openingHeightM - 0.1, 0.03, 0, o.sillHeightM + o.openingHeightM / 2, '#9fd6f0', true);
      } else {
        const leaf = box(o.widthM - 0.08, o.openingHeightM - 0.05, 0.055, 0, o.openingHeightM / 2, frame);
        if (o.state === 'open') { leaf.rotation.y = Math.PI * 0.43; leaf.position.x = -o.widthM / 2 + 0.04 + Math.cos(leaf.rotation.y) * (o.widthM - 0.08) / 2; leaf.position.z = -Math.sin(leaf.rotation.y) * (o.widthM - 0.08) / 2; }
      }
      if (lit) { // a glowing volume so a changed opening reads at any zoom
        const glow = new THREE.Mesh(new THREE.BoxGeometry(o.widthM + 0.12, o.openingHeightM + 0.1, wall.thicknessM + 0.25), new THREE.MeshBasicMaterial({ color: SUGGEST, transparent: true, opacity: 0.35, depthWrite: false }));
        glow.position.set(0, o.sillHeightM + o.openingHeightM / 2, 0); glow.userData = { wallId: wall.id, openingId: o.id, highlight: true };
        group.add(glow);
      }
    }
    for (const room of derived.topology.rooms) {
      if (!shown.has(room.floorId)) continue;
      const surface = floorSurface(room.polygon, doc.stairs.filter(s => s.toFloorId === room.floorId));
      const mesh = new THREE.Mesh(surface, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: below(room.floorId) ? 0.03 : 0.07, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = height(room.floorId) + 0.004; r.floors.add(mesh);
    }
    // Floor surfaces (D74).
    for (const slab of doc.slabs ?? []) {
      if (!shown.has(slab.floorId)) continue;
      const m = dimmed(style(r.library.floorMaterial(slab.material), [slab.id]), slab.floorId);
      const cutouts = [...doc.stairs.filter(s => s.toFloorId === slab.floorId), ...(finishCuts.get(slab.id) ?? [])];
      const mesh = new THREE.Mesh(floorSurface(slab.polygon, cutouts), m);
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = height(slab.floorId) + 0.008; mesh.receiveShadow = true;
      mesh.userData = { slabId: slab.id, floorId: slab.floorId, below: below(slab.floorId) };
      r.floors.add(mesh);
    }
    // Placeables: simple part-built models (tables on legs, chairs with backs, grilled ceiling vents).
    for (const p of doc.placeables ?? []) {
      const f = shown.get(p.floorId); if (!f) continue;
      const spec = PLACEABLES[p.item], tones = PLACEABLE_TONES[p.item];
      const materials = new Map<PartTone, THREE.MeshStandardMaterial>();
      const material = (tone: PartTone) => {
        let m = materials.get(tone);
        if (!m) { m = dimmed(style(new THREE.MeshStandardMaterial({ color: tones[tone] ?? '#9aa3ad', roughness: tone === 'top' ? 0.55 : 0.8 }), [p.id]), p.floorId); materials.set(tone, m); }
        return m;
      };
      const group = new THREE.Group();
      group.position.set(p.position.x, f.elevationM, -p.position.y);
      group.rotation.y = (p.rotationDeg * Math.PI) / 180;
      for (const part of placeableModel(p.item, f.ceilingHeightM)) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...part.size), material(part.tone));
        mesh.position.set(...part.at);
        mesh.castShadow = !below(p.floorId) && !spec.suppliesAir; mesh.receiveShadow = true;
        mesh.userData = { placeableId: p.id, floorId: p.floorId, below: below(p.floorId) };
        group.add(mesh);
      }
      r.floors.add(group);
      entityAnchor.set(p.id, toWorld(p.position, f.elevationM + (spec.maxZ ?? f.ceilingHeightM) + 0.2));
    }
    // Stairs (D75): solid steps from the lower floor up to the next.
    for (const stair of doc.stairs ?? []) {
      if (!shown.has(stair.floorId)) continue;
      const to = doc.floors.find(f => f.id === stair.toFloorId);
      const base = height(stair.floorId), rise = Math.max(0.5, (to?.elevationM ?? base + 3) - base);
      const m = dimmed(style(new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.8 }), [stair.id]), stair.floorId);
      for (const step of stairSteps(stair, rise)) {
        const w = step.max.x - step.min.x, d = step.max.y - step.min.y;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, step.top, d), m);
        mesh.position.set((step.min.x + step.max.x) / 2, base + step.top / 2, -(step.min.y + step.max.y) / 2);
        mesh.castShadow = !below(stair.floorId); mesh.receiveShadow = true;
        mesh.userData = { stairId: stair.id, floorId: stair.floorId, below: below(stair.floorId) };
        r.floors.add(mesh);
      }
      entityAnchor.set(stair.id, toWorld({ x: (stair.min.x + stair.max.x) / 2, y: (stair.min.y + stair.max.y) / 2 }, base + rise + 0.2));
    }
    for (const note of props.notes ?? []) { const at = entityAnchor.get(note.entityId); if (at) anchors.set(note.key, at); }
    r.anchors = anchors;
    if (framedProject.current !== doc.projectId) { framedProject.current = doc.projectId; r.frame(latest.current.editing ? 'top' : 'iso', false); }
  }, [props.doc, props.selected, props.highlight, props.notes, props.floorId, library, finishCuts]);

  // Geometry above is ready before framing. Acknowledge the camera only after its final frame is drawn.
  useEffect(() => {
    const view = props.entryView;
    if (!view) return;
    if (error) { latest.current.onEntryError(error); return; }
    const r = runtime.current; if (!r) return;
    r.frame(view, view === 'top');
    r.afterFrame = () => latest.current.onEntryFrame(view);
    return () => { r.afterFrame = undefined; };
  }, [props.entryView, library, error]);

  return <div className={`egress-scene tool-${props.editing ? props.tool : 'view'}`} ref={host} aria-label="Building model">
    {error && <p className="scene-error" role="alert">{error}</p>}
    <div className="viewcube-host" ref={cubeHost} title={props.editing ? 'Edit is top-down' : 'Drag to orbit · click a face, edge or corner'} />
    <div className="scene-dim" ref={dim} hidden />
    {(props.notes ?? []).map(n => <div key={n.key} className="scene-note" ref={el => { if (el) noteEls.current.set(n.key, el); else noteEls.current.delete(n.key); }}><span>{n.text}</span></div>)}
    {(props.tags ?? []).map(t => <button key={t.key} className={`room-tag ${t.muted ? 'muted' : ''}`} ref={el => { if (el) tagEls.current.set(t.key, el); else tagEls.current.delete(t.key); }}
      onClick={e => { const r = host.current!.getBoundingClientRect(); props.onTag?.(t.key, { x: e.clientX - r.left, y: e.clientY - r.top }); }}>{t.text}</button>)}
  </div>;
});

export default EgressScene;
