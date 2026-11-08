/**
 * CAD-style viewcube (PLAN.md D63): it mirrors the main camera, drags to orbit,
 * and clicking a face, edge or corner snaps the camera to that direction.
 * Plan axes: east = +x, north = +y (three.js -z), up = three.js +y.
 */
import * as THREE from 'three';

const SIZE = 104;
const EDGE = 0.2; // how close to a cube edge (in cube units) a hit counts as that edge/corner

function faceTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f6f9'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#9aa7b6'; g.lineWidth = 4; g.strokeRect(2, 2, 124, 124);
  g.fillStyle = '#3b4656'; g.font = '600 22px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class ViewCube {
  readonly element: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly cube: THREE.Mesh;
  private readonly hover: THREE.Mesh;
  private readonly ray = new THREE.Raycaster();
  private locked = false;
  private dirty = true;
  private readonly direction = new THREE.Vector3();
  private drag: { x: number; y: number; moved: boolean } | null = null;

  constructor(
    private readonly onOrbit: (dTheta: number, dPhi: number) => void,
    private readonly onView: (direction: THREE.Vector3) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(SIZE, SIZE);
    this.element = this.renderer.domElement;
    this.element.className = 'viewcube';
    // +x EAST, -x WEST, +y TOP, -y BOTTOM, +z SOUTH, -z NORTH (three.js BoxGeometry face order).
    const labels = ['EAST', 'WEST', 'TOP', 'BOTTOM', 'SOUTH', 'NORTH'];
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), labels.map(l => new THREE.MeshBasicMaterial({ map: faceTexture(l) })));
    this.scene.add(this.cube);
    this.cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: '#6b7a8c' })));
    this.hover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#2f80ed', transparent: true, opacity: 0.45, depthTest: false }));
    this.hover.visible = false;
    this.scene.add(this.hover);
    this.element.addEventListener('pointerdown', this.down);
    this.element.addEventListener('pointermove', this.move);
    this.element.addEventListener('pointerup', this.up);
    this.element.addEventListener('pointerleave', this.leave);
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.element.classList.toggle('locked', locked);
  }

  /** Mirror the main camera: same direction from the target, same up vector. */
  sync(camera: THREE.Camera, target: THREE.Vector3): void {
    const position = this.direction.copy(camera.position).sub(target).normalize().multiplyScalar(4);
    if (!this.dirty && this.camera.position.distanceToSquared(position) < 1e-12 && this.camera.up.equals(camera.up)) return;
    this.dirty = false;
    this.camera.position.copy(position);
    this.camera.up.copy(camera.up);
    this.camera.lookAt(0, 0, 0);
    this.camera.zoom = 1.15;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.down);
    this.element.removeEventListener('pointermove', this.move);
    this.element.removeEventListener('pointerup', this.up);
    this.element.removeEventListener('pointerleave', this.leave);
    this.cube.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) { (m as THREE.MeshBasicMaterial).map?.dispose(); m.dispose(); }
      }
    });
    this.hover.geometry.dispose(); (this.hover.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.element.remove();
  }

  /** Face, edge or corner under the pointer, as a direction with components in {-1, 0, 1}. */
  private region(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.element.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hit = this.ray.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const snap = (v: number) => (Math.abs(v) > 0.5 - EDGE ? Math.sign(v) : 0);
    return new THREE.Vector3(snap(p.x), snap(p.y), snap(p.z));
  }

  private readonly down = (e: PointerEvent) => {
    this.drag = { x: e.clientX, y: e.clientY, moved: false };
    this.element.setPointerCapture(e.pointerId);
  };

  private readonly move = (e: PointerEvent) => {
    this.dirty = true;
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 3) return;
      this.drag.moved = true;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      this.hover.visible = false;
      if (!this.locked) this.onOrbit(-dx * 0.012, -dy * 0.012);
      return;
    }
    const r = this.locked ? null : this.region(e);
    this.hover.visible = !!r;
    if (r) {
      const size = (v: number) => (v === 0 ? 1 - EDGE * 2 + 0.02 : 0.06);
      this.hover.scale.set(size(r.x), size(r.y), size(r.z));
      this.hover.position.set(r.x * 0.5, r.y * 0.5, r.z * 0.5);
    }
    this.element.style.cursor = this.locked ? 'default' : r ? 'pointer' : 'grab';
  };

  private readonly up = (e: PointerEvent) => {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.moved) return;
    if (this.locked) { this.onView(new THREE.Vector3(0, 1, 0)); return; }
    const r = this.region(e);
    if (r && r.lengthSq() > 0) this.onView(r);
  };

  private readonly leave = () => { if (!this.drag) { this.hover.visible = false; this.dirty = true; } };
}
