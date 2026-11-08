Real-world recognition benchmarks

Sources (retrieved 2026-11-07):
- farmhouse.png: first page of https://commons.wikimedia.org/wiki/File:Farmhouse_Drawing_Set_V-001.pdf — architectural construction sheet, rasterized to 1000px, matching the current importer resolution limit.
- nps.png: first page of https://npgallery.nps.gov/GetAsset/15622016-eff7-4635-b66a-2cc327f933a9 — historic architectural drawing, rasterized to 1000px. The endpoint serves PDF despite the image-oriented search result.

Run from repository root:
`node --experimental-strip-types frontend/scripts/benchmark-real-plans.ts`

Baseline: farmhouse 55 wall segments, 0 floors, 0 openings; NPS 38 segments, 0 floors, 0 openings. Both FAIL usable automatic reconstruction. Counts are not semantic accuracy measurements. Construction sheets contain multiple views and annotations; region selection, double-line wall interpretation, and reliable symbol recognition are still missing. Do not turn these counts into success assertions.

Correction: the initial benchmarks above used cover/form pages and must NOT be interpreted as floor-plan accuracy tests. The active benchmark now uses manually inspected floor-plan crops from pages 6 (A1.2) and 7 (A1.3) of the farmhouse construction set. Crops: x402,y294,870x443 from a 1800px-wide page raster. Source attribution: Virginia's Farmhouse, original design Jay Osborne, 2014; CC BY-SA as printed on the source. Derived crops retain that license.

Current A1.2: 42 segments, one continuous exterior floor; A1.3: 40 segments, three closed regions. These are still partial reconstructions. Automatic openings remain zero on these drawings; interior accuracy and second-floor floor coverage are not established. Review is required. The large-floor regression checks measured coverage, not merely floor count.
