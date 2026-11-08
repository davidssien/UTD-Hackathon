'use client';

import { useEffect, useRef, useState } from 'react';
import { getFloorBounds, getWallBounds, type Building, type Wall } from '@/lib/floorplan';
import { polygonArea, roomAt } from '@/lib/rooms';
import { editBuilding, floorRectangle, nearestWall, openingAt, snapPoint, wallEnd, wallLength, type EditCommand, type Point, type Tool } from '@/lib/building-editor';

type Props = { building: Building; source: string; tool: Tool; cancelToken: number; layers?: { walls: boolean; openings: boolean }; onEdit: (command: EditCommand) => void; selectedWalls: string[]; onSelectionChange: (ids: string[]) => void };

function Openings({ wall }: { wall: Wall }) {
  const length = wallLength(wall);
  return <g transform={`translate(${wall.x1} ${wall.z1}) rotate(${Math.atan2(wall.z2 - wall.z1, wall.x2 - wall.x1) * 180 / Math.PI})`}>
    {(wall.openings ?? []).map(o => <g key={o.id} data-wall-id={wall.id} data-opening-id={o.id}>
      <path d={`M${o.offset - o.width / 2} 0h${o.width}`} stroke="#fff" strokeWidth={wall.thickness + .035} />
      {o.type === 'window' ? <path d={`M${o.offset - o.width / 2} 0h${o.width}`} stroke="#6196a5" strokeWidth=".09" /> : <>
        <path d={`M${o.offset - o.width / 2} 0v${-o.width}M${o.offset - o.width / 2} ${-o.width}a${o.width} ${o.width} 0 0 1 ${o.width} ${o.width}`} fill="none" stroke="#997451" strokeWidth=".045" />
      </>}
      <rect x={o.offset - o.width / 2} y={-.22} width={o.width} height={.44} fill="transparent" />
    </g>)}
    <title>{length.toFixed(2)} m wall</title>
  </g>;
}

export default function PlanEditor({ building, source, tool, cancelToken, onEdit, selectedWalls, onSelectionChange, layers = { walls: true, openings: true } }: Props) {
  const selected = selectedWalls[0];
  const setSelected = (id: string | null) => onSelectionChange(id ? [id] : []);
  const resize = useRef<{ wallId: string; endpoint: 'start' | 'end' } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [free, setFree] = useState(false);
  const down = useRef<Point | null>(null);
  const dragged = useRef(false);
  useEffect(() => { setAnchor(null); setHover(null); down.current = null; resize.current = null; }, [tool, cancelToken]);
  const baseFloor = getFloorBounds(building);
  const bounds = getWallBounds(building.walls);
  const floorPoints = (building.floors ?? []).flatMap(f => f.points);
  const minX = Math.min(-building.width / 2, bounds?.minX ?? 0, ...floorPoints.map(p => p.x)) - 1;
  const minZ = Math.min(-building.depth / 2, bounds?.minZ ?? 0, ...floorPoints.map(p => p.z)) - 1;
  const width = Math.max(building.width / 2, bounds?.maxX ?? 0, ...floorPoints.map(p => p.x)) + 1 - minX;
  const depth = Math.max(building.depth / 2, bounds?.maxZ ?? 0, ...floorPoints.map(p => p.z)) + 1 - minZ;
  const position = (e: React.PointerEvent): Point | null => {
    const matrix = svg.current?.getScreenCTM(); if (!matrix || !svg.current) return null;
    const p = svg.current.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const local = p.matrixTransform(matrix.inverse()); return { x: local.x, z: local.y };
  };
  const end = anchor && hover ? tool === 'floor' ? snapPoint(hover, building.walls) : wallEnd(anchor, hover, building.walls, free) : null;
  const floorPreview = tool === 'floor' && anchor && end ? floorRectangle(anchor, end) : tool === 'fill-floor' && hover ? roomAt(building.walls, hover) : null;
  const hoveredWall = hover ? nearestWall(building.walls, hover) : undefined;
  const opening = hover && hoveredWall && (tool === 'door' || tool === 'window') ? openingAt(hoveredWall, tool, hover).opening : null;

  const invalidWall = anchor && end ? editBuilding(building, { type: 'wall', start: anchor, end }).error : undefined;
  const invalidFloor = anchor && end && tool === 'floor' ? editBuilding(building, { type: 'floor', start: anchor, end }).error : undefined;
  const selectedWall = building.walls.find(w => w.id === selected);

  return <svg
    ref={svg}
    className={`editable-plan tool-${tool}`}
    viewBox={`${minX} ${minZ} ${width} ${depth}`}
    aria-label="Editable floor plan"
    onPointerDown={e => { if (e.button !== 0) return; const p = position(e); if (p) { down.current = snapPoint(p, building.walls); dragged.current = false; e.currentTarget.setPointerCapture(e.pointerId); } }}
    onPointerMove={e => {
      const p = position(e); setHover(p); setFree(e.shiftKey);
      if (p && down.current && e.buttons === 1 && (tool === 'wall' || tool === 'floor') && Math.hypot(p.x - down.current.x, p.z - down.current.z) > .3) {
        dragged.current = true; if (!anchor) setAnchor(down.current);
      }
    }}
    onPointerUp={e => {
      const p = position(e); down.current = null;
      if (resize.current) { const handle = resize.current; resize.current = null; if (p) onEdit({ type: 'resize-wall', ...handle, point: p }); return; }
      if (e.button !== 0 || !p) return;
      if (tool === 'wall') {
        if (!anchor) { setAnchor(snapPoint(p, building.walls)); return; }
        const next = wallEnd(anchor, p, building.walls, e.shiftKey);
        { onEdit({ type: 'wall', start: anchor, end: next }); setAnchor(null); setHover(null); }
      } else if (tool === 'floor') {
        const next = snapPoint(p, building.walls);
        if (!anchor) { setAnchor(next); return; }
        { onEdit({ type: 'floor', start: anchor, end: next }); setAnchor(null); setHover(null); }
      } else if (tool === 'fill-floor') {
        onEdit({ type: 'fill-floor', point: p }); setHover(null);
      } else {
        const floorTarget = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-floor-id]') as SVGElement | null;
        if (tool === 'delete' && floorTarget?.dataset.floorId) { onEdit(floorTarget.dataset.floorId === '__base__' ? { type: 'delete-base-floor' } : { type: 'delete-floor', floorId: floorTarget.dataset.floorId }); return; }
        // Pointer capture retargets the event to the SVG. Find the real object
        // under the release position for accurate opening deletion.
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-wall-id]') as SVGElement | null;
        const wall = building.walls.find(w => w.id === target?.dataset.wallId) ?? nearestWall(building.walls, p);
        if (tool === 'select') setSelected(wall?.id ?? null);
        if (!wall || dragged.current) { if (!wall && (tool === 'door' || tool === 'window')) onEdit({ type: 'invalid', reason: 'Choose a wall to place a door or window.' }); return; }
        if (tool === 'door' || tool === 'window') onEdit({ type: 'opening', kind: tool, wallId: wall.id, point: p });
        if (tool === 'delete') onEdit({ type: 'delete', wallId: wall.id, openingId: target?.dataset.openingId });
      }
    }}
    onPointerLeave={() => { if (!down.current && !resize.current) setHover(null); }}
    onPointerCancel={() => { down.current = null; resize.current = null; setAnchor(null); }}
  >
    <defs><pattern id="plan-grid" width=".5" height=".5" patternUnits="userSpaceOnUse"><path d="M .5 0 H0 V.5" fill="none" stroke="#dce1e5" strokeWidth=".015" /></pattern></defs>
    <rect x={minX} y={minZ} width={width} height={depth} fill="url(#plan-grid)" />
    <image href={source} x={-building.width / 2} y={-building.depth / 2} width={building.width} height={building.depth} opacity=".32" pointerEvents="none" />
    {(building.references ?? []).map((reference,i) => <image key={i} href={reference.image} x={-reference.width/2} y={-reference.depth/2} width={reference.width} height={reference.depth} transform={`translate(${reference.x} ${reference.z}) rotate(${reference.rotation})`} opacity=".25" pointerEvents="none" />)}
    {baseFloor && <rect data-floor-id="__base__" x={baseFloor.minX} y={baseFloor.minZ} width={baseFloor.maxX-baseFloor.minX} height={baseFloor.maxZ-baseFloor.minZ} fill="#b7a78d" fillOpacity=".35" />}
    {(building.floors ?? []).map(f => <polygon key={f.id} data-floor-id={f.id} points={f.points.map(p => `${p.x},${p.z}`).join(' ')} fill="#c5aa80" fillOpacity=".7" stroke="#ae936b" strokeWidth=".025" />)}
    {building.walls.map(w => <g key={w.id}>
      <line visibility={layers.walls ? undefined : 'hidden'} data-wall-id={w.id} x1={w.x1} y1={w.z1} x2={w.x2} y2={w.z2} stroke={tool === 'delete' && hoveredWall?.id === w.id ? '#c65f4b' : selected === w.id ? '#8277c7' : '#4b5948'} strokeWidth={w.thickness} />
      <line visibility={layers.walls ? undefined : 'hidden'} data-wall-id={w.id} x1={w.x1} y1={w.z1} x2={w.x2} y2={w.z2} stroke="transparent" strokeWidth={Math.max(.3, w.thickness)} />
      <g visibility={layers.openings ? undefined : 'hidden'}><Openings wall={w} /></g>
    </g>)}
    {tool === 'select' && selectedWall && (['start', 'end'] as const).map(endpoint => <circle key={endpoint} cx={endpoint === 'start' ? selectedWall.x1 : selectedWall.x2} cy={endpoint === 'start' ? selectedWall.z1 : selectedWall.z2} r=".16" fill="#fff" stroke="#8277c7" strokeWidth=".05" style={{ cursor: 'move' }} onPointerDown={e => { e.stopPropagation(); resize.current = { wallId: selectedWall.id, endpoint }; e.currentTarget.setPointerCapture(e.pointerId); }}><title>Drag to resize connected walls</title></circle>)}
    {tool === 'wall' && hover && !anchor && <circle cx={snapPoint(hover, building.walls).x} cy={snapPoint(hover, building.walls).z} r=".1" fill="#779b57" pointerEvents="none" />}
    {tool === 'wall' && anchor && end && <g pointerEvents="none">
      <line x1={anchor.x} y1={anchor.z} x2={end.x} y2={end.z} stroke={invalidWall ? '#c65f4b' : '#8aaf66'} strokeWidth=".2" strokeOpacity=".7" />
      <circle cx={anchor.x} cy={anchor.z} r=".1" fill="#5d7f40" />
      <text x={(anchor.x + end.x) / 2} y={(anchor.z + end.z) / 2 - .3} textAnchor="middle" fontSize=".3" fill="#35512c">{Math.hypot(end.x - anchor.x, end.z - anchor.z).toFixed(2)} m</text>
    </g>}
    {floorPreview && <g pointerEvents="none"><polygon points={floorPreview.map(p => `${p.x},${p.z}`).join(' ')} fill={invalidFloor ? '#dc685f' : '#91b36c'} fillOpacity=".5" stroke="#72984f" strokeWidth=".04"/>{hover && <text x={hover.x + .2} y={hover.z - .2} fontSize=".3" fill="#35512c">{polygonArea(floorPreview).toFixed(2)} m²</text>}</g>}
    {tool === 'fill-floor' && hover && !floorPreview && <circle cx={hover.x} cy={hover.z} r=".3" fill="#dc685f" opacity=".65" pointerEvents="none" />}
    {(tool === 'door' || tool === 'window') && hover && !opening && <circle cx={hover.x} cy={hover.z} r=".25" fill="#dc685f" opacity=".65" pointerEvents="none" />}
    {opening && hoveredWall && <g pointerEvents="none" transform={`translate(${hoveredWall.x1} ${hoveredWall.z1}) rotate(${Math.atan2(hoveredWall.z2 - hoveredWall.z1, hoveredWall.x2 - hoveredWall.x1) * 180 / Math.PI})`}>
      <line x1={opening.offset - opening.width / 2} y1="0" x2={opening.offset + opening.width / 2} y2="0" stroke="#72b1c4" strokeWidth=".3" />
    </g>}
  </svg>;
}
