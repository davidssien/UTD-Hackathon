/** node packages/sim/scripts/stuck.ts scene people seed — print anyone left inside at the end. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from '@egress/core';
import { runSimulation } from '@egress/sim';
const [file = 'hall.json', people = '300', seed = '1'] = process.argv.slice(2);
const document = parseDocument(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'scenes', file), 'utf8')));
const { state, metrics } = runSimulation({ runId: 'r', document, scenario: { scenarioVersion: 1, id: 's', projectId: document.projectId, name: 'E', durationSeconds: 400, population: { count: Number(people), distribution: 'uniform', strokes: [], seed: Number(seed) }, goal: { kind: 'evacuate', blockedExitIds: [] } } }, { keepChunks: false });
console.log(`evacuated ${metrics.evacuatedPeople}/${metrics.initialPeople} in ${metrics.evacuationTimeSeconds ?? 'timeout'}`);
for (let a = 0; a < state.n; a++) if (state.flag[a] !== 3) {
  const e = state.exit[a];
  const dir = e >= 0 ? state.compiled.nav.direction(e, state.x[a], state.y[a]) : null;
  const ex = e >= 0 ? state.compiled.exits[e] : null;
  console.log(`#${a} (${state.x[a].toFixed(2)}, ${state.y[a].toFixed(2)}) r=${state.r[a].toFixed(2)} exit=${ex?.openingId} at (${ex?.center.x},${ex?.center.y}) dist=${e >= 0 ? state.compiled.nav.distanceAt(e, state.x[a], state.y[a]).toFixed(2) : '-'} dir=${dir ? `${dir.x.toFixed(2)},${dir.y.toFixed(2)}` : 'null'} stuck=${state.stuck[a]} flag=${state.flag[a]}`);
}
