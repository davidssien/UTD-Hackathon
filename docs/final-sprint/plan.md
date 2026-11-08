# Egress final sprint · November 8

The release baseline is the tested studio at `dd55d3f`, tagged `Stable-V2` and merged into `main`. Development continues on `stable-forward`. All times below are Central.

## Delivered

| Area | What works | How it was checked |
| --- | --- | --- |
| Multi-floor evacuation | Occupants on every floor route to a same-floor exit or down a stair with a reachable exit below; the descent and the remaining walk count in the choice. Floor and height travel through shared replay (frame codec v2); single-floor runs still play. | Deterministic tests for competing upper exits and stairs, a blocked onward exit, a disconnected floor and two consecutive descents. Two-Story Clinic, 80 people, seed 1: all 35 upstairs occupants descended and all 80 exited in 61.8 simulated seconds; a second viewer followed the run and reloaded the replay. |
| Airflow | `floorAirflow(document, floorId, windFrom)` solves steady relative pressure within each connected floor. Open exterior doors and windows take the wind pressure; closed openings are sealed. The wind bearing is set on a compass in Layers → Airflow (any of 360°). | Tests for wind reversal, a closed partition, an open interior door and windows that pass air but not people. Event Hall in the browser and through the agent's `inspect_airflow` with Nemotron. |
| HVAC and furniture | The Edit toolbar's + places tables, desks, chairs, counters and ceiling HVAC vents; R rotates the selection. Furniture (0–0.5 m) blocks people but not air. Vents hold their area at supply pressure and push air toward open outlets; a sealed room stays still. | Tests: a table removes walkable cells but not air cells, a vent drives flow toward the exit, a furnished room still evacuates fully. |
| Examples | Five example saves of different sizes, furnished, including a two-storey clinic. | Each example evacuates its suggested crowd with nobody unreachable. |
| Run verdicts | A finished run reads Great - Tests Passed, Good - Tests Passed, Poor - Tests Mixed or Bad - Tests Failed. Nemotron chooses from building facts (rooms, hallways, exits, stairs, area) and the measured outcome, anchored on a rule grade that is shown at once and used when no model is available; a failed run always stays Bad. | Rule grades are unit tested; a live Nemotron call graded the Two-Story Clinic in about 0.6 s. |

## Deploying

Publish the module and deploy the matching runner and frontend together: the new edit commands (floors, stairs, placeables) and views need the current module on the serving database.
