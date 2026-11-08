/**
 * Runs every example save at its suggested crowd and prints the outcome and airflow, for checking
 * the examples after regenerating them.
 *
 *   node content/examples/evaluate.mts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '@egress/core';
import { floorAirflow, runSimulation } from '@egress/sim';

const here = dirname(fileURLToPath(import.meta.url));
for (const e of JSON.parse(readFileSync(join(here, 'index.json'), 'utf8')) as { name: string; file: string; people: number }[]) {
  const doc = parseDocument(JSON.parse(readFileSync(join(here, e.file), 'utf8')));
  const m = runSimulation({ runId: 'x', document: doc, scenario: {
    scenarioVersion: 1, id: 'x', projectId: doc.projectId, name: 'Evacuate', durationSeconds: 600,
    population: { count: e.people, distribution: 'uniform', strokes: [], seed: 3 }, goal: { kind: 'evacuate', blockedExitIds: [] },
  } }, { keepChunks: false }).metrics;
  const ground = doc.floors.find(f => f.level === 0)!.id;
  const air = floorAirflow(doc, ground, 'west');
  console.log(`${e.name.padEnd(18)} ${String(doc.placeables.length).padStart(3)} placeables | ${m.evacuatedPeople}/${e.people} out in ${m.evacuationTimeSeconds} s, unreachable ${m.unreachablePeople}, max queue ${m.maxQueueLength} | ground airflow peak ${air.peak.toFixed(3)}`);
}
