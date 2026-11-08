/** Stair geometry for the scene (PLAN.md D75). Pure, so it can be unit tested. */
import type { Stair, Vec2 } from '@egress/core';

/** Riser height the step count aims for (m). */
export const RISER_M = 0.18;

/** Steps of a straight stair as plan rectangles with their top heights above the lower floor, bottom step first. */
export function stairSteps(stair: Pick<Stair, 'min' | 'max' | 'upEdge'>, rise: number): { min: Vec2; max: Vec2; top: number }[] {
  const vertical = stair.upEdge === 'n' || stair.upEdge === 's';
  const run = vertical ? stair.max.y - stair.min.y : stair.max.x - stair.min.x;
  const n = Math.max(3, Math.round(rise / RISER_M));
  // Keep a level landing within the footprint, including on short legacy stairs.
  const landing = Math.min(1, Math.max(0.6, run / n), run * 0.75);
  const tread = (run - landing) / (n - 1);
  const steps: { min: Vec2; max: Vec2; top: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = tread * i, b = i === n - 1 ? run : tread * (i + 1), top = rise * (i + 1) / n;
    if (stair.upEdge === 'n') steps.push({ min: { x: stair.min.x, y: stair.min.y + a }, max: { x: stair.max.x, y: stair.min.y + b }, top });
    else if (stair.upEdge === 's') steps.push({ min: { x: stair.min.x, y: stair.max.y - b }, max: { x: stair.max.x, y: stair.max.y - a }, top });
    else if (stair.upEdge === 'e') steps.push({ min: { x: stair.min.x + a, y: stair.min.y }, max: { x: stair.min.x + b, y: stair.max.y }, top });
    else steps.push({ min: { x: stair.max.x - b, y: stair.min.y }, max: { x: stair.max.x - a, y: stair.max.y }, top });
  }
  return steps;
}

/** The side of a dragged rectangle that rises: the drag direction along its longer axis. */
export function upEdgeOf(from: Vec2, to: Vec2): Stair['upEdge'] {
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? 'n' : 's') : (dx >= 0 ? 'e' : 'w');
}
