import * as THREE from 'three';
import { wallSections, wallLength } from './building-editor.ts';
import type { Wall } from './floorplan';

type Solid = { wallId: string; planes: THREE.Plane[]; faces: THREE.Vector3[][] };
const EPS = 1e-7;

// Partition a surface polygon at a plane, retaining both sides for solid subtraction.
function split(points: THREE.Vector3[], plane: THREE.Plane) {
  const inside: THREE.Vector3[] = [], outside: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
    (da <= EPS ? inside : outside).push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const p = a.clone().lerp(b, da / (da - db)); inside.push(p); outside.push(p);
    } else if (Math.abs(da) <= EPS) outside.push(a);
  }
  return { inside, outside: points.some(p => plane.distanceToPoint(p) > EPS) ? outside : [] };
}

// Render only the exterior of intersecting wall solids. Each surface keeps its
// wall identity for selection/deletion, without overlapping coplanar triangles.
export function wallGeometries(walls: Wall[], height = 2.8) {
  const solids: Solid[] = [];
  for (const wall of walls) {
    const angle = -Math.atan2(wall.z2 - wall.z1, wall.x2 - wall.x1);
    const matrix = new THREE.Matrix4().makeRotationY(angle);
    matrix.setPosition((wall.x1 + wall.x2) / 2, 0, (wall.z1 + wall.z2) / 2);
    if (wallLength(wall) < EPS) continue;
    const length = wallLength(wall);
    // Intersect the offset edges at a two-wall corner. Both walls share the
    // same diagonal seam, rather than ending in overlapping square caps.
    const endShift = (atStart: boolean, side: number) => {
      const px = atStart ? wall.x1 : wall.x2, pz = atStart ? wall.z1 : wall.z2;
      const neighbors = walls.filter(w => w.id !== wall.id &&
        (Math.hypot(w.x1-px,w.z1-pz)<.001 || Math.hypot(w.x2-px,w.z2-pz)<.001));
      if (neighbors.length !== 1) return 0;
      const other = neighbors[0], otherLength = wallLength(other);
      if (otherLength < EPS) return 0;
      const dx = (wall.x2-wall.x1)/length, dz = (wall.z2-wall.z1)/length;
      const starts = Math.hypot(other.x1-px,other.z1-pz)<.001;
      const ox = (starts ? other.x2-other.x1 : other.x1-other.x2)/otherLength;
      const oz = (starts ? other.z2-other.z1 : other.z1-other.z2)/otherLength;
      const cross = dx*oz-dz*ox;
      if (Math.abs(cross)<.01) return 0;
      const sign = atStart ? 1 : -1;
      const otherSide = -side*sign;
      const ax = -dz*side*wall.thickness/2, az = dx*side*wall.thickness/2;
      const bx = -oz*otherSide*other.thickness/2, bz = ox*otherSide*other.thickness/2;
      const shift = ((bx-ax)*oz-(bz-az)*ox)/cross;
      return Math.abs(shift) <= Math.min(length/3, otherLength/3, Math.max(wall.thickness,other.thickness)*4) ? shift : 0;
    };
    for (const piece of wallSections(wall, height)) {
      const x = piece.center, y = piece.bottom, w = piece.width / 2, d = wall.thickness / 2, h = piece.height;
      const vertices = [[x-w,y,-d],[x+w,y,-d],[x+w,y+h,-d],[x-w,y+h,-d],[x-w,y,d],[x+w,y,d],[x+w,y+h,d],[x-w,y+h,d]].map(p => new THREE.Vector3(
        p[0] + (Math.abs(p[0]+length/2)<EPS ? endShift(true, Math.sign(p[2])) : Math.abs(p[0]-length/2)<EPS ? endShift(false, Math.sign(p[2])) : 0), p[1], p[2]
      ).applyMatrix4(matrix));
      const faces = [[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[0,1,5,4],[3,7,6,2]].map(f => f.map(i => vertices[i]));
      solids.push({ wallId: wall.id, faces, planes: faces.map(f => new THREE.Plane().setFromCoplanarPoints(f[0], f[1], f[2])) });
    }
  }
  const buffers = new Map(walls.map(w => [w.id, [] as number[]]));
  const bounds = solids.map(s => new THREE.Box3().setFromPoints(s.faces.flat()));
  solids.forEach((solid, index) => {
    solid.faces.forEach((face, faceIndex) => {
      let polygons = [face];
      solids.forEach((cutter, other) => {
        if (other === index || !bounds[index].intersectsBox(bounds[other])) return;
        // The earlier solid owns a coincident exterior face.
        if (other > index && cutter.planes.some(p => p.normal.dot(solid.planes[faceIndex].normal) > 1-EPS && Math.abs(p.constant-solid.planes[faceIndex].constant) < EPS)) return;
        polygons = polygons.flatMap(polygon => {
          let remainder = polygon;
          const exterior: THREE.Vector3[][] = [];
          for (const plane of cutter.planes) {
            if (remainder.length < 3) break;
            const parts = split(remainder, plane);
            if (parts.outside.length >= 3) exterior.push(parts.outside);
            remainder = parts.inside;
          }
          return exterior;
        });
      });
      const data = buffers.get(solid.wallId)!;
      for (const polygon of polygons) for (let i = 1; i < polygon.length-1; i++) {
        const a = polygon[0], b = polygon[i], c = polygon[i+1];
        if (b.clone().sub(a).cross(c.clone().sub(a)).lengthSq() > EPS*EPS) data.push(...a.toArray(), ...b.toArray(), ...c.toArray());
      }
    });
  });
  return new Map([...buffers].map(([id, data]) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data, 3)); geometry.computeVertexNormals();
    return [id, geometry];
  }));
}
