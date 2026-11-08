# Egress final sprint · November 8

The release baseline is the tested studio at `dd55d3f`. Tag that revision `Stable-V2` and merge it into `main`. Continue development on `stable-forward`. All times below are Central.

## Codex · now through about 7:30 a.m.

| Target | Deliverable | Acceptance check |
| --- | --- | --- |
| First | Promote the baseline and record both remote refs. | GitHub main contains the tagged revision and the worktree remains on stable-forward. |
| By 7:00 | Add an opt-in ground-floor fire evacuation to the deterministic model. Use one ignition point, a ventilation field driven by exterior openings, smoke transport, fire spread and explicit casualty accounting. | A sealed partition blocks spread. Identical inputs reproduce identical results. Ordinary evacuations retain their existing behavior. |
| By 7:15 | Connect the scenario to the existing runner, SpacetimeDB run/replay data and studio. Place the origin with a flame pin and inspect airflow, smoke and fire during playback. | The replay follows the playhead when paused or scrubbed. Exited, remaining and modeled fatalities account for the starting population. |
| By 7:30 | Exercise one preset in the browser, run regression tests and document reproducible settings and deployment dependencies. | A teammate can run the demo and distinguish a measured result from an untested integration. |

The model uses simplified ground-floor ventilation and spread. Thresholds represent illustrative simulation outcomes. Reserve multi-floor smoke, HVAC equipment, structural failure and calibrated human exposure for a later model.

## Proposed Claude handoff · next four hours

- Verify two-browser collaboration on the judging database. Open the same project, follow the same hazard run and compare the ignition point, playback and final counts.
- Exercise Nemotron against a completed fire scenario. Keep ignition, crowd seed and duration fixed across geometry candidates. Surface modeled fatalities and exposure before evacuation time. Verify a real provider job produces a proposal the user can accept.
- Rehearse one baseline and one changed layout with the same conditions. Record the serving runner version, project, seeds and measured outcomes. Use the Stable-V2 release for rehearsal if the new runner and client have not passed together.

Keep deployment and recording with the team coordinating the demo. Update the handoff below with the implementation and checks actually completed.
