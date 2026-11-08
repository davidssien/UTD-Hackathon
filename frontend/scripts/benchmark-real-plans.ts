import sharp from 'sharp';
import { recognizeSketch } from '../lib/sketch-import.ts';
// Diagnostic benchmark: counts are observations, not accuracy or passing grades.
for (const name of ['farmhouse-first-floor','farmhouse-second-floor']) {
  const input = new URL(`../tests/fixtures/real-plans/${name}.png`, import.meta.url);
  const {data,info} = await sharp(input.pathname).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const start = performance.now();
  const result = recognizeSketch({data,width:info.width,height:info.height} as unknown as ImageData);
  console.log(JSON.stringify({name,walls:result.building.walls.length,floors:result.building.floors?.length,openings:result.building.walls.flatMap(w=>w.openings??[]).length,excluded:result.ignored.length,ms:Math.round(performance.now()-start)}));
}
