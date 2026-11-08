/**
 * Quick benchmark + sanity print for the pedestrian model on the fixtures.
 *
 *   node packages/sim/scripts/bench.ts [people=300] [seed=1]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, type SimulationScenario } from '@egress/core';
import { runSimulation } from '@egress/sim';

const people = Number(process.argv[2] ?? 300);
const seed = Number(process.argv[3] ?? 1);
const scenes = join(import.meta.dirname, '..', '..', '..', 'content', 'scenes');

for (const file of (process.argv[4] ?? 'one-room.json,two-rooms-corridor.json,hall.json').split(',')) {
  const document = parseDocument(JSON.parse(readFileSync(join(scenes, file), 'utf8')));
  const scenario: SimulationScenario = {
    scenarioVersion: 1, id: 'bench', projectId: document.projectId, name: 'Evacuate', durationSeconds: 600,
    population: { count: people, distribution: 'uniform', strokes: [], seed }, goal: { kind: 'evacuate', blockedExitIds: [] },
  };
  const result = runSimulation({ runId: 'bench', document, scenario }, { keepChunks: false });
  const m = result.metrics;
  console.log(`${file}: ${people} people → evacuated ${m.evacuatedPeople}, unreachable ${m.unreachablePeople}, ` +
    `time ${m.evacuationTimeSeconds ?? 'timeout'} s, ticks ${m.tick}, max queue ${m.maxQueueLength}, ` +
    `peak congestion ${m.peakCongestion}, ${(result.computeMs / Math.max(1, m.tick)).toFixed(2)} ms/tick (${result.computeMs} ms total)`);
  for (const b of m.bottlenecks.slice(0, 3)) console.log(`   hotspot ${b.description} at (${b.regionCenter.x}, ${b.regionCenter.y})`);
}
