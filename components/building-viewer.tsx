'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { getFloorBounds, type Building } from '@/lib/floorplan';
import { wallGeometries } from '@/lib/wall-geometry';
import { polygonArea, roomAt } from '@/lib/rooms';
import { floorRectangle, nearestWall, openingAt, snapPoint, wallEnd, wallLength, type EditCommand, type Point, type Tool } from '@/lib/building-editor';

export type ViewerHandle = { view: (preset: 'perspective' | 'top' | 'front' | 'fit') => void; export: () => Promise<void>; cancelBuild: () => void };
type Props = { active: boolean; building: Building | null; sceneKey: string; tool: Tool; selectedWalls: string[]; onSelectionChange: (ids: string[]) => void; onEdit: (command: EditCommand) => void };
type Runtime = { camera: THREE.PerspectiveCamera; controls: OrbitControls; model: THREE.Group; ghost: THREE.Group; center: THREE.Vector3; extent: number; active: boolean; cancel: () => void; cancelGesture: () => void; refreshSelection: () => void };

function disposeGroup(group: THREE.Object3D) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
      }
    });
  }
}

function floorMesh(points: Point[], preview = false) {
  const shape = new THREE.Shape();
  points.forEach((p, i) => { if (!i) shape.moveTo(p.x, -p.z); else shape.lineTo(p.x, -p.z); });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: .12, bevelEnabled: false });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: preview ? '#91b36c' : '#c5aa80', roughness: .92, transparent: preview, opacity: preview ? .5 : 1, depthWrite: !preview }));
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = preview ? -.075 : -.1; mesh.receiveShadow = true;
  return mesh;
}

function frame(r: Runtime, preset: 'perspective' | 'top' | 'front' | 'fit') {
  r.cancelGesture();
  const d = r.extent, fit = Math.max(1, 1 / r.camera.aspect) * 1.12;
  const offset = preset === 'top' ? new THREE.Vector3(0, d * 1.6 * fit, .001)
    : preset === 'front' ? new THREE.Vector3(0, 0, d * 1.5 * fit)
    : new THREE.Vector3(d * .85 * fit, d * .85 * fit, d * .95 * fit);
  r.controls.target.copy(r.center);
  r.camera.position.copy(r.center).add(offset);
  r.camera.lookAt(r.center); r.controls.update();
}

const BuildingViewer = forwardRef<ViewerHandle, Props>(function BuildingViewer({ active, building, sceneKey, tool, onEdit, selectedWalls, onSelectionChange }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const editing = useRef({ building, tool, onEdit, selectedWalls, onSelectionChange });
  const framedSource = useRef<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { editing.current = { building, tool, onEdit, selectedWalls, onSelectionChange }; runtime.current?.refreshSelection(); }, [building, tool, onEdit, selectedWalls, onSelectionChange]);

  useImperativeHandle(ref, () => ({
    view(preset) { if (runtime.current) frame(runtime.current, preset); },
    cancelBuild() { runtime.current?.cancel(); },
    async export() {
      if (!runtime.current) return;
      const result = await new GLTFExporter().parseAsync(runtime.current.model, { binary: true });
      const url = URL.createObjectURL(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }));
      const a = document.createElement('a'); a.href = url; a.download = 'exitcraft-building.glb'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  }), []);

  useEffect(() => {
    const node = host.current; if (!node) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setError('Enable hardware acceleration to use the 3D workspace.'); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setClearColor('#f4f5f6');
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    node.appendChild(renderer.domElement);
    const cursor = document.createElement('div'); cursor.className = 'camera-cursor'; cursor.setAttribute('aria-hidden', 'true'); node.appendChild(cursor);
    const tip = document.createElement('div'); tip.className = 'placement-tip'; tip.setAttribute('role', 'tooltip'); node.appendChild(tip);
    const marquee = document.createElement('div'); marquee.className = 'selection-marquee'; marquee.setAttribute('aria-hidden', 'true'); node.appendChild(marquee);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, node.clientWidth / Math.max(node.clientHeight, 1), .03, 2000);
    camera.position.set(20, 20, 24);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false; controls.enablePan = false; controls.zoomToCursor = false;
    controls.rotateSpeed = .5; controls.zoomSpeed = .65; controls.minDistance = .4; controls.maxDistance = 250;
    controls.maxPolarAngle = Math.PI * .49;
    controls.mouseButtons = { LEFT: undefined, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: undefined };
    scene.add(new THREE.HemisphereLight('#e9f3ff', '#7c7974', 2.5));
    const sun = new THREE.DirectionalLight('#fff2df', 3.5); sun.position.set(-10, 25, 12); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45 }); sun.shadow.normalBias = .03; scene.add(sun);
    const grid = new THREE.GridHelper(160, 320, '#c7cdd2', '#e0e4e7'); grid.position.y = -.16; scene.add(grid);
    const model = new THREE.Group(), ghost = new THREE.Group(), selection = new THREE.Group(); scene.add(model, ghost, selection);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ray = new THREE.Raycaster();
    let anchor: Point | null = null, button: number | null = null, downPoint: Point | null = null;
    let startX = 0, startY = 0, lastX = 0, lastY = 0, moved = false;

    const tinted = new Map<THREE.MeshStandardMaterial, THREE.Color>();
    const clearGhost = () => {
      for (const [material, color] of tinted) material.color.copy(color);
      tinted.clear(); disposeGroup(ghost); tip.style.display = 'none';
    };
    const cancel = () => { anchor = null; clearGhost(); };
    const endRotation = () => {
      button = null; marquee.style.display = 'none'; cursor.classList.remove('visible'); node.classList.remove('rotating');
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
      controls.enabled = runtime.current?.active ?? false;
    };
    const blur = () => endRotation();
    const r: Runtime = { camera, controls, model, ghost, center: new THREE.Vector3(0, 1.4, 0), extent: 20, active: true, cancel, cancelGesture: blur, refreshSelection: () => {
      disposeGroup(selection);
      const ids = new Set(editing.current.selectedWalls);
      for (const group of model.children) {
        const selected = ids.has(group.userData.wallId);
        group.traverse(object => {
          if (object instanceof THREE.Mesh && object.userData.wallId) {
            const material = object.material as THREE.MeshStandardMaterial;
            material.emissive.set(selected ? '#6a67a8' : '#000000'); material.emissiveIntensity = selected ? .25 : 0;
          }
        });
        if (selected) selection.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(group), '#8277c7'));
      }
    } };
    runtime.current = r;
    const pick = (x: number, y: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1), camera);
      const ground = ray.ray.intersectPlane(plane, new THREE.Vector3());
      const hits = ray.intersectObjects(model.children, true).filter(hit => hit.object.userData.wallId || hit.object.userData.floorId);
      const hit = hits[0];
      const point = hit ? { x: hit.point.x, z: hit.point.z } : ground ? { x: ground.x, z: ground.z } : null;
      const wall = hit?.object.userData.wallId ? editing.current.building?.walls.find(w => w.id === hit.object.userData.wallId) : point ? nearestWall(editing.current.building?.walls ?? [], point) : undefined;
      return { ground: ground ? { x: ground.x, z: ground.z } : null, point, wall, hit };
    };
    const ghostBox = (start: Point, end: Point, color = '#8aaf66', height = 2.8, thickness = .2, bottom = 0) => {
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(length, .02), height, thickness), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: .45, depthWrite: false }));
      mesh.position.set((start.x + end.x) / 2, bottom + height / 2, (start.z + end.z) / 2);
      mesh.rotation.y = -Math.atan2(end.z - start.z, end.x - start.x); ghost.add(mesh);
    };
    const preview = (e: PointerEvent) => {
      clearGhost();
      const { building, tool } = editing.current;
      if (!building || !r.active || tool === 'select' || button === 2) return;
      const picked = pick(e.clientX, e.clientY);
      let text = '';
      if (tool === 'wall' && picked.ground) {
        const start = anchor ?? snapPoint(picked.ground, building.walls);
        const end = anchor ? wallEnd(anchor, picked.ground, building.walls, e.shiftKey) : start;
        ghostBox(start, anchor ? end : { x: start.x + .02, z: start.z }, '#8aaf66', anchor ? 2.8 : .12, anchor ? .2 : .18);
        text = anchor ? `${Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)} m · Click to build` : 'Click to start a wall';
      } else if (tool === 'floor' && picked.ground) {
        const current = snapPoint(picked.ground, building.walls);
        if (anchor) {
          const points = floorRectangle(anchor, current); if (polygonArea(points) > .001) ghost.add(floorMesh(points, true));
          text = `${polygonArea(points).toFixed(2)} m² · Click to finish floor`;
        } else text = 'Click the first floor corner';
      } else if (tool === 'fill-floor' && picked.ground) {
        const points = roomAt(building.walls, picked.ground);
        if (points) { ghost.add(floorMesh(points, true)); text = `Fill room · ${polygonArea(points).toFixed(2)} m²`; }
        else text = 'Close the surrounding wall gaps to fill this room';
      } else if (tool === 'delete' && picked.hit?.object.userData.floorId) {
        const floor = building.floors?.find(f => f.id === picked.hit!.object.userData.floorId);
        ghost.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(picked.hit.object), '#c65f4b'));
        text = `Floor · ${floor ? polygonArea(floor.points).toFixed(2) : ''} m² · Click to delete`;
      } else if ((tool === 'door' || tool === 'window') && picked.wall && picked.point) {
        const result = openingAt(picked.wall, tool, picked.point);
        text = result.error ?? `Place ${tool}`;
        if (result.opening) {
          const o = result.opening, wall = picked.wall, length = wallLength(wall);
          const dx = (wall.x2 - wall.x1) / length, dz = (wall.z2 - wall.z1) / length;
          ghostBox({ x: wall.x1 + dx * (o.offset - o.width / 2), z: wall.z1 + dz * (o.offset - o.width / 2) }, { x: wall.x1 + dx * (o.offset + o.width / 2), z: wall.z1 + dz * (o.offset + o.width / 2) }, '#78b8ca', o.height, wall.thickness + .08, o.sill);
        }
      } else if (tool === 'delete' && picked.hit && picked.wall) {
        const isOpening = picked.hit.object.userData.openingId;
        const selected = editing.current.selectedWalls;
        const bulk = !isOpening && selected.includes(picked.wall.id) && selected.length > 1;
        const targets = model.children.filter(g => bulk ? selected.includes(g.userData.wallId) : g.userData.wallId === picked.wall!.id);
        for (const group of targets) {
          const object = isOpening ? picked.hit.object : group;
          group.traverse(child => {
            if (!(child instanceof THREE.Mesh) || (isOpening && child.userData.openingId !== isOpening)) return;
            const material = child.material as THREE.MeshStandardMaterial;
            tinted.set(material, material.color.clone()); material.color.set('#ef3535');
          });
          ghost.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(object), '#c65f4b'));
        }
        const opening = picked.wall.openings?.find(o => o.id === isOpening);
        const name = `Wall ${building.walls.findIndex(w => w.id === picked.wall!.id) + 1}`;
        const attachments = picked.wall.openings?.length ?? 0;
        text = opening ? `${opening.type === 'door' ? 'Door' : 'Window'} · Click to delete`
          : bulk ? `${selected.length} walls · Click deletes walls and all attached objects`
          : `${name} · ${wallLength(picked.wall).toFixed(2)} m${attachments ? ` · ${attachments} attached object${attachments === 1 ? '' : 's'}` : ''} · Click to delete${attachments ? ' everything on this wall' : ''}`;
      }
      if (text) {
        tip.textContent = text; tip.style.display = 'block';
        const rect = node.getBoundingClientRect();
        tip.style.left = `${Math.max(12, Math.min(e.clientX - rect.left + 18, node.clientWidth - tip.offsetWidth - 12))}px`;
        tip.style.top = `${Math.max(12, Math.min(e.clientY - rect.top + 18, node.clientHeight - tip.offsetHeight - 12))}px`;
      }
    };
    const rotate = (dx: number, dy: number) => {
      const offset = camera.position.clone().sub(r.center);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      const sensitivity = Math.PI / Math.max(node.clientHeight, 1);
      spherical.theta -= dx * sensitivity;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * sensitivity, .01, controls.maxPolarAngle);
      camera.position.copy(r.center).add(offset.setFromSpherical(spherical));
      controls.target.copy(r.center); camera.lookAt(r.center);
    };
    const down = (e: PointerEvent) => {
      if (!r.active || e.button > 2) return;
      button = e.button; moved = false; startX = lastX = e.clientX; startY = lastY = e.clientY;
      downPoint = pick(e.clientX, e.clientY).ground;
      if (e.button === 0) {
        if ((editing.current.tool === 'wall' || editing.current.tool === 'floor') && downPoint && !anchor) downPoint = snapPoint(downPoint, editing.current.building?.walls ?? []);
        renderer.domElement.setPointerCapture(e.pointerId);
      }
      if (e.button !== 2 || e.pointerType !== 'mouse') return;
      e.preventDefault(); e.stopImmediatePropagation(); controls.enabled = false; clearGhost();
      const rect = node.getBoundingClientRect(); cursor.style.left = `${e.clientX - rect.left}px`; cursor.style.top = `${e.clientY - rect.top}px`;
      cursor.classList.add('visible'); node.classList.add('rotating');
      const fallback = () => { if (button === 2) try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* Pointer released. */ } };
      if (typeof renderer.domElement.requestPointerLock === 'function') {
        try { renderer.domElement.requestPointerLock()?.catch(fallback); } catch { fallback(); }
      } else fallback();
    };
    const move = (e: PointerEvent) => {
      const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) moved = true;
      if (button === 2) { if (document.pointerLockElement !== renderer.domElement) rotate(dx, dy); return; }
      if (button === 0 && moved && editing.current.tool === 'select') {
        const rect = node.getBoundingClientRect();
        marquee.style.display = 'block';
        marquee.style.left = `${Math.min(startX, e.clientX) - rect.left}px`;
        marquee.style.top = `${Math.min(startY, e.clientY) - rect.top}px`;
        marquee.style.width = `${Math.abs(e.clientX - startX)}px`;
        marquee.style.height = `${Math.abs(e.clientY - startY)}px`;
        return;
      }
      if (button === 0 && moved && !anchor && (editing.current.tool === 'wall' || editing.current.tool === 'floor') && downPoint) anchor = downPoint;
      preview(e);
    };
    const up = (e: PointerEvent) => {
      const previous = button;
      endRotation();
      if (previous !== 0 || !r.active) return;
      const { building, tool, onEdit, selectedWalls, onSelectionChange } = editing.current; if (!building) return;
      const picked = pick(e.clientX, e.clientY);
      if (tool === 'select') {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (moved) {
          const bounds = node.getBoundingClientRect();
          const left = Math.min(startX, e.clientX), right = Math.max(startX, e.clientX), top = Math.min(startY, e.clientY), bottom = Math.max(startY, e.clientY);
          const ids: string[] = [];
          camera.updateMatrixWorld(true); model.updateMatrixWorld(true);
          for (const group of model.children) {
            if (!group.userData.wallId) continue;
            const box = new THREE.Box3().setFromObject(group);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, visible = false;
            for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
              const p = new THREE.Vector3(x, y, z).project(camera);
              if (p.z < -1 || p.z > 1) continue;
              visible = true;
              const sx = bounds.left + (p.x + 1) / 2 * bounds.width, sy = bounds.top + (1 - p.y) / 2 * bounds.height;
              minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
            }
            if (visible && minX <= right && maxX >= left && minY <= bottom && maxY >= top) ids.push(group.userData.wallId);
          }
          onSelectionChange(additive ? [...new Set([...selectedWalls, ...ids])] : ids);
        } else {
          const id = picked.hit?.object.userData.wallId as string | undefined;
          onSelectionChange(id ? additive ? selectedWalls.includes(id) ? selectedWalls.filter(w => w !== id) : [...selectedWalls, id] : [id] : additive ? selectedWalls : []);
        }
        clearGhost(); return;
      }
      if (tool === 'wall' && picked.ground) {
        if (!anchor) { anchor = snapPoint(picked.ground, building.walls); preview(e); return; }
        const end = wallEnd(anchor, picked.ground, building.walls, e.shiftKey);
        if (Math.hypot(end.x - anchor.x, end.z - anchor.z) >= .5) { onEdit({ type: 'wall', start: anchor, end }); anchor = null; clearGhost(); }
      } else if (tool === 'floor' && picked.ground) {
        const end = snapPoint(picked.ground, building.walls);
        if (!anchor) { anchor = end; return; }
        if (polygonArea(floorRectangle(anchor, end)) >= .25) { onEdit({ type: 'floor', start: anchor, end }); anchor = null; clearGhost(); }
      } else if (!moved && tool === 'fill-floor' && picked.ground) {
        onEdit({ type: 'fill-floor', point: picked.ground }); clearGhost();
      } else if (!moved && (tool === 'door' || tool === 'window') && picked.wall && picked.point) {
        onEdit({ type: 'opening', wallId: picked.wall.id, kind: tool, point: picked.point }); clearGhost();
      } else if (!moved && tool === 'delete' && picked.hit?.object.userData.floorId) {
        onEdit({ type: 'delete-floor', floorId: picked.hit.object.userData.floorId }); clearGhost();
      } else if (!moved && tool === 'delete' && picked.hit) {
        const id = picked.hit.object.userData.wallId;
        if (!picked.hit.object.userData.openingId && selectedWalls.includes(id) && selectedWalls.length > 1) onEdit({ type: 'delete-walls', wallIds: selectedWalls });
        else onEdit({ type: 'delete', wallId: id, openingId: picked.hit.object.userData.openingId });
        clearGhost();
      }
    };
    const lockedMove = (e: MouseEvent) => { if (document.pointerLockElement === renderer.domElement && button === 2) rotate(e.movementX, e.movementY); };
    const lockedUp = (e: MouseEvent) => { if (e.button === 2) endRotation(); };
    const lockChange = () => { if (document.pointerLockElement !== renderer.domElement) endRotation(); else if (button !== 2) document.exitPointerLock(); };
    const contextMenu = (e: MouseEvent) => e.preventDefault();
    renderer.domElement.addEventListener('pointerleave', clearGhost);
    window.addEventListener('blur', blur);
    renderer.domElement.addEventListener('pointerdown', down, true); renderer.domElement.addEventListener('pointermove', move); renderer.domElement.addEventListener('pointerup', up);
    renderer.domElement.addEventListener('pointercancel', blur); renderer.domElement.addEventListener('lostpointercapture', endRotation); renderer.domElement.addEventListener('contextmenu', contextMenu);
    document.addEventListener('mousemove', lockedMove); document.addEventListener('mouseup', lockedUp); document.addEventListener('pointerlockchange', lockChange);
    const resize = new ResizeObserver(() => { renderer.setSize(node.clientWidth, node.clientHeight); camera.aspect = node.clientWidth / Math.max(1, node.clientHeight); camera.updateProjectionMatrix(); }); resize.observe(node);
    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.target.copy(r.center);
      controls.update(); renderer.render(scene, camera);
    }; frameId = requestAnimationFrame(animate);
    return () => {
      blur(); cancelAnimationFrame(frameId); resize.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerleave', clearGhost);
      window.removeEventListener('blur', blur);
      renderer.domElement.removeEventListener('pointerdown', down, true); renderer.domElement.removeEventListener('pointermove', move); renderer.domElement.removeEventListener('pointerup', up);
      renderer.domElement.removeEventListener('pointercancel', blur); renderer.domElement.removeEventListener('lostpointercapture', endRotation); renderer.domElement.removeEventListener('contextmenu', contextMenu);
      document.removeEventListener('mousemove', lockedMove); document.removeEventListener('mouseup', lockedUp); document.removeEventListener('pointerlockchange', lockChange);
      disposeGroup(model); disposeGroup(ghost); disposeGroup(selection); grid.geometry.dispose(); (grid.material as THREE.Material).dispose();
      renderer.dispose(); node.removeChild(renderer.domElement); node.removeChild(cursor); node.removeChild(tip); node.removeChild(marquee); runtime.current = null;
    };
  }, []);

  useEffect(() => { const r = runtime.current; if (r) { r.active = active; r.controls.enabled = active; if (!active) { r.cancelGesture(); r.cancel(); } } }, [active]);
  useEffect(() => {
    const r = runtime.current; if (!r) return;
    r.cancel();
    // A touch drag places geometry while a build tool is active.
    r.controls.enableRotate = tool === 'select';
  }, [tool]);

  useEffect(() => {
    const r = runtime.current; if (!r) return;
    r.cancel();
    disposeGroup(r.model);
    if (!building) return;
    const height = 2.8;
    const box = (parent: THREE.Group, width: number, tall: number, depth: number, x: number, y: number, color: string, wallId: string, openingId?: string, glass = false) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, tall, depth), new THREE.MeshStandardMaterial({ color, roughness: glass ? .18 : .82, transparent: glass, opacity: glass ? .38 : 1 }));
      mesh.position.set(x, y, 0); mesh.castShadow = !glass; mesh.receiveShadow = true; mesh.userData = { wallId, openingId }; parent.add(mesh); return mesh;
    };
    const geometries = wallGeometries(building.walls, height);
    for (const wall of building.walls) {
      const length = wallLength(wall), group = new THREE.Group(); group.userData.wallId = wall.id;
      group.position.set((wall.x1 + wall.x2) / 2, 0, (wall.z1 + wall.z2) / 2); group.rotation.y = -Math.atan2(wall.z2 - wall.z1, wall.x2 - wall.x1);
      group.updateMatrix();
      const geometry = geometries.get(wall.id)!; geometry.applyMatrix4(group.matrix.clone().invert());
      const surface = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#e7e3d9', roughness: .82 }));
      surface.userData.wallId = wall.id; surface.castShadow = true; surface.receiveShadow = true; group.add(surface);
      for (const opening of wall.openings ?? []) {
        const x = opening.offset - length / 2, bottom = opening.sill, top = bottom + opening.height, t = .055, depth = wall.thickness + .055;
        const color = opening.type === 'door' ? '#8a7154' : '#e7eef0';
        box(group, t, opening.height, depth, x - opening.width / 2 + t / 2, bottom + opening.height / 2, color, wall.id, opening.id);
        box(group, t, opening.height, depth, x + opening.width / 2 - t / 2, bottom + opening.height / 2, color, wall.id, opening.id);
        box(group, opening.width, t, depth, x, top - t / 2, color, wall.id, opening.id);
        if (opening.type === 'window') {
          box(group, opening.width, t, depth, x, bottom + t / 2, color, wall.id, opening.id);
          box(group, t, opening.height - t * 2, .06, x, bottom + opening.height / 2, color, wall.id, opening.id);
          box(group, opening.width - t * 2, opening.height - t * 2, .035, x, bottom + opening.height / 2, '#8ac3d4', wall.id, opening.id, true);
        } else {
          const door = box(group, opening.width - t * 2, opening.height - t, .055, x, opening.height / 2, '#ae9475', wall.id, opening.id);
          // An open leaf keeps the doorway visibly passable.
          door.rotation.y = Math.PI * .42; door.position.x = x - opening.width / 2 + t + Math.cos(door.rotation.y) * (opening.width - t * 2) / 2;
          door.position.z = -Math.sin(door.rotation.y) * (opening.width - t * 2) / 2;
        }
      }
      r.model.add(group);
    }
    for (const floor of building.floors ?? []) {
      const mesh = floorMesh(floor.points); mesh.userData.floorId = floor.id; mesh.name = 'Floor'; r.model.add(mesh);
    }
    const bounds = getFloorBounds(building);
    if (bounds) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(bounds.maxX - bounds.minX, .15, bounds.maxZ - bounds.minZ), new THREE.MeshStandardMaterial({ color: '#b7a78d', roughness: .96 }));
      slab.position.set((bounds.minX + bounds.maxX) / 2, -.08, (bounds.minZ + bounds.maxZ) / 2); slab.receiveShadow = true; r.model.add(slab);
      r.center.set((bounds.minX + bounds.maxX) / 2, height / 2, (bounds.minZ + bounds.maxZ) / 2);
      r.extent = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 5);
    }
    r.refreshSelection();
    // Reframe only for a newly imported source, never for ordinary edits.
    if (framedSource.current !== sceneKey) { frame(r, 'fit'); framedSource.current = sceneKey; }
  }, [building, sceneKey]);

  return <div className={`three-host orbit tool-${tool}`} ref={host} aria-label="Interactive 3D building viewport">{error && <div className="webgl-error">{error}</div>}</div>;
});
export default BuildingViewer;
