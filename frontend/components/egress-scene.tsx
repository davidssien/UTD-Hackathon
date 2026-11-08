'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { deriveLayout, projectOnSegment, type EditCommand, type EgressDocument, type Vec2, type WallMaterial } from '@egress/core';
import type { PlaybackController } from '@egress/client';

export type SceneTool = 'select' | 'wall' | 'box' | 'erase' | 'door' | 'window' | 'exit' | 'pan';
type CameraPreset = 'top' | 'iso' | 'front' | 'back' | 'left' | 'right' | 'fit';
export type SceneHandle = { preset: (view: CameraPreset) => void; exportImage: () => void };
type Props = { doc: EgressDocument | null; editing: boolean; tool: SceneTool; material: WallMaterial; selected: string | null; onSelect: (id: string | null) => void; onEdit: (commands: EditCommand[]) => void; playback?: PlaybackController | null };
type Runtime = { scene: THREE.Scene; camera: THREE.OrthographicCamera; controls: OrbitControls; renderer: THREE.WebGLRenderer; walls: THREE.Group; floors: THREE.Group; preview: THREE.Group; center: THREE.Vector3; extent: number; frame: (preset: CameraPreset, animate?: boolean) => void; cancel: () => void };
const COLORS = { normal: '#f1f0e8', reinforced: '#a8babd', glass: '#8dc5ce' };

function clear(group: THREE.Group) {
  for (const object of [...group.children]) {
    group.remove(object);
    object.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Line) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
      }
    });
  }
}

function polygon(points: Vec2[], height: number, bottom: number, material: THREE.Material) {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, p.y)));
  const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false }), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = bottom;
  mesh.receiveShadow = true;
  return mesh;
}

const EgressScene = forwardRef<SceneHandle, Props>(function EgressScene(props, ref) {
  const host = useRef<HTMLDivElement>(null), runtime = useRef<Runtime | null>(null);
  const latest = useRef(props), cube = useRef<HTMLDivElement>(null), framed = useRef<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { latest.current = props; });
  useImperativeHandle(ref, () => ({
    preset(view) { runtime.current?.frame(latest.current.editing && view !== 'fit' ? 'top' : view); },
    exportImage() {
      const r = runtime.current;
      if (!r) return;
      r.renderer.render(r.scene, r.camera);
      const a = document.createElement('a'); a.download = 'egress-plan.png'; a.href = r.renderer.domElement.toDataURL('image/png'); a.click();
    },
  }), []);

  useEffect(() => {
    const node = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch { setError('3D rendering is unavailable in this browser. Try enabling hardware acceleration.'); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor('#e9eef0'); node.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#94a8b8', 2.4));
    const sun = new THREE.DirectionalLight('#fff6e5', 2.4); sun.position.set(12, 24, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35 }); sun.shadow.normalBias = .03; scene.add(sun);
    const camera = new THREE.OrthographicCamera(-15, 15, 15, -15, .05, 500);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .12; controls.screenSpacePanning = false;
    controls.minPolarAngle = .001; controls.maxPolarAngle = Math.PI * .44; controls.minZoom = .35; controls.maxZoom = 8;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    const walls = new THREE.Group(), floors = new THREE.Group(), preview = new THREE.Group(); scene.add(floors, walls, preview);
    const grid = new THREE.GridHelper(100, 100, '#a7b8c1', '#c9d4d9'); grid.position.y = -.025; scene.add(grid);
    const points: number[] = [];
    for (let x = -25; x <= 25; x += .25) for (let z = -25; z <= 25; z += .25) points.push(x, -.015, z);
    const dots = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)), new THREE.PointsMaterial({ color: '#8fa6b4', size: .022 })); scene.add(dots);
    const people = new THREE.InstancedMesh(new THREE.SphereGeometry(.17, 10, 8), new THREE.MeshStandardMaterial({ color: '#f9d995' }), 2000); people.count = 0; scene.add(people);
    const matrix = new THREE.Matrix4();
    let transition: { start: number; from: THREE.Vector3; to: THREE.Vector3; targetFrom: THREE.Vector3; targetTo: THREE.Vector3 } | null = null;
    let anchor: Vec2 | null = null, down: Vec2 | null = null, downPixels: Vec2 | null = null;
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const r: Runtime = { scene, camera, controls, renderer, walls, floors, preview, center: new THREE.Vector3(), extent: 20, cancel() { anchor = null; down = null; clear(preview); }, frame(view, animate = true) {
      r.cancel();
      const fit = view === 'fit';
      const vertices = latest.current.doc?.vertices;
      if (fit && vertices?.length) {
        const xs = vertices.map(v => v.position.x), ys = vertices.map(v => v.position.y);
        r.center.set((Math.min(...xs) + Math.max(...xs)) / 2, 0, -(Math.min(...ys) + Math.max(...ys)) / 2);
        r.extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 12);
      }
      const top = latest.current.editing || view === 'top';
      const d = Math.max(8, r.extent);
      const target = r.center.clone(); target.y = 0;
      const offset = top ? new THREE.Vector3(0, d * 1.5, .001)
        : view === 'front' ? new THREE.Vector3(0, d * .38, d * 1.5)
        : view === 'back' ? new THREE.Vector3(0, d * .38, -d * 1.5)
        : view === 'left' ? new THREE.Vector3(-d * 1.5, d * .38, 0)
        : view === 'right' ? new THREE.Vector3(d * 1.5, d * .38, 0)
        : new THREE.Vector3(d, d * 1.15, d);
      const to = target.clone().add(offset);
      if (fit) camera.zoom = 1;
      const half = d * .7, aspect = Math.max(.2, node.clientWidth / Math.max(1, node.clientHeight));
      camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half; camera.updateProjectionMatrix();
      if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) transition = { start: performance.now(), from: camera.position.clone(), to, targetFrom: controls.target.clone(), targetTo: target };
      else { transition = null; camera.position.copy(to); controls.target.copy(target); camera.lookAt(target); controls.update(); }
    } };
    runtime.current = r;
    r.frame('top', false);
    const ground = (e: PointerEvent): Vec2 | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
      const p = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!p) return null;
      return { x: Math.round(p.x * 4) / 4, y: Math.round(-p.z * 4) / 4 };
    };
    const pick = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
      return ray.intersectObjects(walls.children, true)[0]?.object.userData as { wallId?: string; openingId?: string } | undefined;
    };
    const outline = (a: Vec2, b: Vec2, box: boolean) => {
      clear(preview);
      const path = box ? [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a] : [a, b];
      preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map(p => new THREE.Vector3(p.x, .06, -p.y))), new THREE.LineBasicMaterial({ color: '#f1bd66', depthTest: false })));
    };
    const endPoint = (a: Vec2, b: Vec2, free: boolean) => free ? b : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    const onDown = (e: PointerEvent) => {
      if (!latest.current.editing || latest.current.tool === 'pan' || e.button !== 0 || transition) return;
      down = ground(e); downPixels = { x: e.clientX, y: e.clientY };
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!latest.current.editing) return;
      const p = ground(e); if (!p) return;
      const { tool } = latest.current;
      if (tool === 'wall' && (anchor || down)) outline(anchor ?? down!, endPoint(anchor ?? down!, p, e.shiftKey), false);
      if ((tool === 'box' || tool === 'erase') && down) outline(down, p, tool === 'box');
    };
    const onUp = (e: PointerEvent) => {
      const state = latest.current, p = ground(e), start = down;
      const moved = downPixels ? Math.hypot(e.clientX - downPixels.x, e.clientY - downPixels.y) > 6 : false;
      down = null; downPixels = null;
      if (!state.editing || e.button !== 0 || state.tool === 'pan' || !p || !state.doc || transition) return;
      const floorId = state.doc.floors[0]?.id; if (!floorId) return;
      const spec = { floorId, thicknessM: state.material === 'reinforced' ? .3 : state.material === 'glass' ? .12 : .2, heightM: 2.8, material: state.material };
      if (state.tool === 'wall') {
        const a = anchor ?? (moved ? start : null);
        if (!a) { anchor = p; return; }
        const b = endPoint(a, p, e.shiftKey);
        if (Math.hypot(b.x - a.x, b.y - a.y) >= .5) state.onEdit([{ kind: 'createWallChain', points: [a, b], ...spec }]);
        anchor = null;
      } else if (state.tool === 'box' && start && moved) {
        state.onEdit([{ kind: 'createBox', min: { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y) }, max: { x: Math.max(start.x, p.x), y: Math.max(start.y, p.y) }, ...spec }]);
      } else if (state.tool === 'erase') {
        if (start && moved) state.onEdit([{ kind: 'eraseByLine', floorId, from: start, to: p }]);
        else { const hit = pick(e); if (hit?.openingId || hit?.wallId) state.onEdit([{ kind: 'deleteEntities', ids: [hit.openingId ?? hit.wallId!] }]); }
      } else if (state.tool === 'select') state.onSelect(pick(e)?.wallId ?? null);
      else if (state.tool === 'door' || state.tool === 'exit' || state.tool === 'window') {
        const vertices = new Map(state.doc.vertices.map(v => [v.id, v.position]));
        const nearest = state.doc.walls.map(w => {
          const a = vertices.get(w.startVertexId)!, b = vertices.get(w.endVertexId)!;
          const hit = projectOnSegment(p, a, b);
          return { wall: w, distance: hit.distance, offset: hit.t * Math.hypot(b.x - a.x, b.y - a.y) };
        }).sort((a, b) => a.distance - b.distance)[0];
        if (nearest && nearest.distance < .65) state.onEdit([{ kind: 'createOpening', wallId: nearest.wall.id, openingKind: state.tool, offsetM: nearest.offset, widthM: state.tool === 'door' ? .9 : 1.2 }]);
      }
      clear(preview);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') r.cancel(); };
    renderer.domElement.addEventListener('pointerdown', onDown); renderer.domElement.addEventListener('pointermove', onMove); renderer.domElement.addEventListener('pointerup', onUp);
    const context = (e: Event) => e.preventDefault(); renderer.domElement.addEventListener('contextmenu', context); window.addEventListener('keydown', escape);
    const resize = new ResizeObserver(() => {
      renderer.setSize(node.clientWidth, node.clientHeight);
      const half = camera.top, aspect = node.clientWidth / Math.max(1, node.clientHeight);
      camera.left = -half * aspect; camera.right = half * aspect; camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    }); resize.observe(node);
    let raf = 0, lastFade = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (transition) {
        const t = Math.min(1, (now - transition.start) / 650), eased = t * t * (3 - 2 * t);
        camera.position.lerpVectors(transition.from, transition.to, eased); controls.target.lerpVectors(transition.targetFrom, transition.targetTo, eased);
        if (t === 1) transition = null;
      }
      controls.target.y = 0; controls.update(); camera.position.y = Math.max(.3, camera.position.y);
      if (cube.current) {
        const dir = camera.position.clone().sub(controls.target).normalize();
        cube.current.style.transform = `rotateX(${-Math.asin(dir.y) * 180 / Math.PI}deg) rotateZ(${Math.atan2(dir.x, dir.z) * 180 / Math.PI}deg)`;
      }
      if (now - lastFade > 160) {
        lastFade = now;
        const fade = new Set<string>();
        if (!latest.current.editing && latest.current.doc) {
          const direction = camera.getWorldDirection(new THREE.Vector3());
          for (const room of deriveLayout(latest.current.doc).topology.rooms) {
            const center = room.polygon.reduce((a, p) => ({ x: a.x + p.x / room.polygon.length, y: a.y + p.y / room.polygon.length }), { x: 0, y: 0 });
            const samples = [center, ...room.polygon.slice(0, 8).map(p => ({ x: (p.x + center.x) / 2, y: (p.y + center.y) / 2 }))];
            for (const p of samples) {
              const target = new THREE.Vector3(p.x, .03, -p.y);
              ray.set(target.clone().addScaledVector(direction, -100), direction); ray.far = 99.9;
              for (const hit of ray.intersectObjects(walls.children, true)) if (hit.object.userData.wallId) fade.add(hit.object.userData.wallId);
            }
          }
        }
        walls.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          const m = object.material as THREE.MeshStandardMaterial;
          m.opacity = (object.userData.baseOpacity ?? 1) * (fade.has(object.userData.wallId) ? .22 : 1);
          object.castShadow = !latest.current.editing && !fade.has(object.userData.wallId) && m.opacity > .8;
        });
      }
      const actors = latest.current.playback?.actorsNow(); people.count = actors?.actorFlags.length ?? 0;
      if (actors) {
        for (let i = 0; i < people.count; i++) {
          matrix.makeScale(actors.actorFlags[i] === 3 ? 0 : 1, actors.actorFlags[i] === 3 ? 0 : 1, actors.actorFlags[i] === 3 ? 0 : 1);
          matrix.setPosition(actors.actorXY[i * 2], .22, -actors.actorXY[i * 2 + 1]); people.setMatrixAt(i, matrix);
          people.setColorAt(i, new THREE.Color(actors.actorFlags[i] === 1 ? '#f19c63' : '#f7e4ad'));
        }
        people.instanceMatrix.needsUpdate = true; if (people.instanceColor) people.instanceColor.needsUpdate = true;
      }
      renderer.render(scene, camera);
    }; raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf); resize.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown); renderer.domElement.removeEventListener('pointermove', onMove); renderer.domElement.removeEventListener('pointerup', onUp); renderer.domElement.removeEventListener('contextmenu', context); window.removeEventListener('keydown', escape);
      clear(walls); clear(floors); clear(preview); grid.geometry.dispose(); (grid.material as THREE.Material).dispose(); dots.geometry.dispose(); (dots.material as THREE.Material).dispose(); people.geometry.dispose(); (people.material as THREE.Material).dispose(); renderer.dispose(); renderer.domElement.remove(); runtime.current = null; framed.current = null;
    };
  }, []);

  useEffect(() => {
    const r = runtime.current; if (!r) return;
    r.cancel(); r.controls.enableRotate = !props.editing;
    r.controls.touches.ONE = props.editing ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    r.frame(props.editing ? 'top' : 'iso');
  }, [props.editing]);
  useEffect(() => {
    const r = runtime.current; if (!r) return;
    r.cancel(); r.controls.enablePan = !props.editing || props.tool === 'pan';
    r.controls.mouseButtons.LEFT = !props.editing || props.tool === 'pan' ? THREE.MOUSE.PAN : null;
  }, [props.tool, props.editing, props.material]);
  useEffect(() => {
    const r = runtime.current; if (!r) return;
    clear(r.walls); clear(r.floors);
    const doc = props.doc; if (!doc) return;
    const derived = deriveLayout(doc), byWall = new Map(doc.walls.map(w => [w.id, w]));
    const groups = new Map<string, THREE.Group>();
    const material = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: .8, alphaHash: true });
    const tag = (mesh: THREE.Mesh, wallId: string, openingId?: string, glass = false) => {
      mesh.userData = { wallId, openingId, baseOpacity: glass ? .42 : 1 };
      (mesh.material as THREE.MeshStandardMaterial).opacity = glass ? .42 : 1;
      if (wallId === props.selected) { const m = mesh.material as THREE.MeshStandardMaterial; m.emissive.set('#429e83'); m.emissiveIntensity = .32; }
      mesh.castShadow = !glass; mesh.receiveShadow = true; return mesh;
    };
    for (const wall of doc.walls) { const g = new THREE.Group(); groups.set(wall.id, g); r.walls.add(g); }
    for (const piece of derived.walls.pieces) {
      const wall = byWall.get(piece.wallId)!;
      groups.get(wall.id)!.add(tag(polygon(piece.polygon, wall.heightM, 0, material(COLORS[wall.material])), wall.id, undefined, wall.material === 'glass'));
    }
    for (const hub of derived.walls.hubs) {
      const wall = doc.walls.find(w => w.startVertexId === hub.vertexId || w.endVertexId === hub.vertexId);
      if (wall) groups.get(wall.id)!.add(tag(polygon(hub.polygon, wall.heightM, 0, material(COLORS[wall.material])), wall.id, undefined, wall.material === 'glass'));
    }
    const vertices = new Map(doc.vertices.map(v => [v.id, v.position]));
    for (const o of doc.openings) {
      const wall = byWall.get(o.wallId); if (!wall) continue;
      const a = vertices.get(wall.startVertexId)!, b = vertices.get(wall.endVertexId)!;
      const angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.hypot(b.x - a.x, b.y - a.y);
      const group = new THREE.Group(); group.position.set(a.x + (b.x - a.x) * o.offsetM / length, 0, -a.y - (b.y - a.y) * o.offsetM / length); group.rotation.y = angle;
      groups.get(wall.id)!.add(group);
      const box = (width: number, height: number, depth: number, x: number, y: number, color: string, glass = false) => {
        const mesh = tag(new THREE.Mesh(new THREE.BoxGeometry(width, Math.max(.005, height), depth), material(color)), wall.id, o.id, glass);
        mesh.position.set(x, y, 0); group.add(mesh); return mesh;
      };
      const top = o.sillHeightM + o.openingHeightM, frameColor = o.openingKind === 'exit' ? '#68b49a' : o.openingKind === 'door' ? '#c2a47b' : '#e4edf0';
      if (o.sillHeightM > 0) box(o.widthM, o.sillHeightM, wall.thicknessM, 0, o.sillHeightM / 2, COLORS[wall.material], wall.material === 'glass');
      if (wall.heightM > top) box(o.widthM, wall.heightM - top, wall.thicknessM, 0, (wall.heightM + top) / 2, COLORS[wall.material], wall.material === 'glass');
      for (const x of [-o.widthM / 2 + .025, o.widthM / 2 - .025]) box(.05, o.openingHeightM, wall.thicknessM + .03, x, o.sillHeightM + o.openingHeightM / 2, frameColor);
      box(o.widthM, .05, wall.thicknessM + .03, 0, top - .025, frameColor);
      if (o.openingKind === 'window') {
        box(o.widthM, .05, wall.thicknessM + .03, 0, o.sillHeightM + .025, frameColor);
        box(o.widthM - .1, o.openingHeightM - .1, .03, 0, o.sillHeightM + o.openingHeightM / 2, '#83bac9', true);
      } else {
        const leaf = box(o.widthM - .08, o.openingHeightM - .05, .055, 0, o.openingHeightM / 2, frameColor);
        if (o.state === 'open') { leaf.rotation.y = Math.PI * .43; leaf.position.x = -o.widthM / 2 + .04 + Math.cos(leaf.rotation.y) * (o.widthM - .08) / 2; leaf.position.z = -Math.sin(leaf.rotation.y) * (o.widthM - .08) / 2; }
      }
    }
    for (const room of derived.topology.rooms) r.floors.add(polygon(room.polygon, .12, -.12, material('#28556d')));
    if (framed.current !== doc.projectId) {
      framed.current = doc.projectId;
      const xs = doc.vertices.map(v => v.position.x), ys = doc.vertices.map(v => v.position.y);
      const minX = xs.length ? Math.min(...xs) : -8, maxX = xs.length ? Math.max(...xs) : 8;
      const minY = ys.length ? Math.min(...ys) : -6, maxY = ys.length ? Math.max(...ys) : 6;
      r.center.set((minX + maxX) / 2, 0, -(minY + maxY) / 2); r.extent = Math.max(maxX - minX, maxY - minY, 12); r.frame(latest.current.editing ? 'top' : 'iso', false);
    }
  }, [props.doc, props.selected]);

  return <div className={`egress-scene scene-tool-${props.tool}`} ref={host} aria-label="3D floor plan workspace">
    {error && <p className="scene-error" role="alert">{error}</p>}
    <div className="viewcube-panel" aria-label="Camera orientation">
      <span>{props.editing ? 'TOP-DOWN · EDIT LOCKED' : 'FREE VIEW'}</span>
      <div className="cube-stage"><div className="orientation-cube" ref={cube}>
        <button className="cube-face cube-top" aria-label="View cube top" onClick={() => runtime.current?.frame('top')}>TOP</button>
        <button className="cube-face cube-front" aria-label="View cube south" disabled={props.editing} onClick={() => runtime.current?.frame('front')}>SOUTH</button>
        <button className="cube-face cube-side" aria-label="View cube east" disabled={props.editing} onClick={() => runtime.current?.frame('right')}>EAST</button>
        <button className="cube-face cube-back" aria-label="View cube north" disabled={props.editing} onClick={() => runtime.current?.frame('back')}>NORTH</button>
        <button className="cube-face cube-west" aria-label="View cube west" disabled={props.editing} onClick={() => runtime.current?.frame('left')}>WEST</button>
      </div></div>
      <div><button onClick={() => runtime.current?.frame('top')} aria-label="Top view">Top</button><button disabled={props.editing} onClick={() => runtime.current?.frame('iso')} aria-label="Isometric view">Iso</button><button disabled={props.editing} onClick={() => runtime.current?.frame('front')} aria-label="Front view">Front</button></div>
    </div>
  </div>;
});
export default EgressScene;
