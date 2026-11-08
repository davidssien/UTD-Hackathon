# Egress final sprint · November 8

The release baseline is the tested studio at `dd55d3f`. Tag that revision `Stable-V2` and merge it into `main`. Continue development on `stable-forward`. All times below are Central.

## Codex · now through about 7:30 a.m.

| Target | Deliverable | Acceptance check |
| --- | --- | --- |
| First | Promote the baseline and record both remote refs. | GitHub main contains the tagged revision and the worktree remains on stable-forward. |
| By 7:05 | Simulate occupants on each supported floor and route them to a same-floor exit or a descending stair with a reachable exit below. Include the descent and remaining walking distance in the choice. | The two-story clinic evacuates upstairs occupants through its stair. Upstairs exits win where faster. A disconnected upper floor reports stranded occupants. |
| By 7:20 | Carry floor and height through shared replay. Render the descent, respect the floor selector and preserve playback of existing single-floor runs. | Pause and scrub a clinic replay. The count, floor and height agree before, during and after the descent. |
| By 7:30 | Run deterministic and real runner/codec tests, exercise the browser and record a handoff. | The team has a tested multi-floor milestone independent of hazard work. |

## Next slice · after multi-floor verification

Add an optional fire evacuation with one flame pin. Use the airflow vectors to transport smoke across accessible cells and report modeled fire and cumulative-smoke fatalities. Keep ignition, route choices and exposure on fixed simulation ticks. Begin this slice only with enough time to verify it independently.

## Proposed Claude handoff · next four hours

- Verify two-browser collaboration on the judging database. Open the same project, follow the same hazard run and compare the ignition point, playback and final counts.
- Exercise Nemotron against a completed fire scenario. Keep ignition, crowd seed and duration fixed across geometry candidates. Surface modeled fatalities and exposure before evacuation time. Verify a real provider job produces a proposal the user can accept.
- Rehearse one baseline and one changed layout with the same conditions. Record the serving runner version, project, seeds and measured outcomes. Use the Stable-V2 release for rehearsal if the new runner and client have not passed together.

Keep deployment and recording with the team coordinating the demo. Update the handoff below with the implementation and checks actually completed.

## Verified multi-floor handoff

GitHub `main` and the annotated `Stable-V2` tag point to `dd55d3f`. The following work is on `stable-forward`.

- Two-Story Clinic on local SpacetimeDB, 80 people, uniform distribution, seed 1. The authoritative runner placed 45 on the ground floor and 35 upstairs. All 35 descended and all 80 exited on the ground floor in 61.8 simulated seconds. The runner reported 1.23 ms per tick for this run.
- A separate viewer followed the run, selected the upper floor, and reloaded the saved replay. The upper-floor density field peaked at 3.2 people/m² at the sampled playhead. The decoded descent included intermediate elevations.
- Deterministic tests cover competing upper exits and stairs, a blocked onward exit, a disconnected floor, and two consecutive descents from a third floor. Multi-floor runs use version 2 frames. Earlier single-floor streams remain playable.
- For the judging database, publish the module and deploy the matching runner and frontend together. The scratch database used for this verification was `egress-stairs-sprint-1108a` on localhost.

## Airflow available for the hazard pass

`floorAirflow(document, floorId, windFrom)` in `@egress/sim` returns a scalar magnitude grid and two relative flow components aligned to its grid. It solves steady pressure within each connected floor, using open exterior apertures as wind-pressure boundaries. It treats closed doors and windows as sealed and models no exchange between floors. A smoke transport model will need a documented velocity scale, diffusion and an explicit stair-shaft exchange term.

The studio calculates this layer in a worker on demand. In Event Hall with a west wind, the browser uploaded 13,438 valid cells and a peak relative pressure gradient of 0.328/m. Switching wind and returning to People both worked. The test suite checks wind reversal, a closed partition, an open interior door and windows that pass air while remaining impassable to people.
