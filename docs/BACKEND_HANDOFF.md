# Egress backend handoff

Verified 2026-11-07 on `implement-backend`. Scope: finish hosted NVIDIA verification, deploy `egress-dev`, and record frontend decisions for later implementation. No shared domain, client, reducer, or storage schema expansion was needed.

## Recap

`@egress/core` owns the wall graph and deterministic edits. `@egress/sim` runs the real pedestrian model; its math and limitations remain documented in [PEOPLE_FLOW_MODEL.md](PEOPLE_FLOW_MODEL.md). SpacetimeDB owns saved projects, edits, frozen run inputs, replay/results and agent jobs. The outbound Node runner performs simulations and hosted-model tool calls. The frontend accesses it only through `@egress/client`.

The existing `/dev?backend=local` harness drives the real local database and runner. `/dev` without that parameter uses the in-browser mock. It does not currently select Maincloud. The production ExitCraft UI still needs the real client integration.

## NVIDIA configuration and result

| Setting | Verified value |
|---|---|
| Secret variable | `NVIDIA_API_KEY`, accessible in the runner process environment |
| Base URL | `NEMOTRON_BASE_URL`, default `https://integrate.api.nvidia.com/v1` |
| Request endpoint | `https://integrate.api.nvidia.com/v1/chat/completions` |
| Preferred model/default | `NEMOTRON_MODEL`, default `nvidia/nemotron-3-super-120b-a12b` |
| Model fallback | `NEMOTRON_FALLBACK_MODEL`, default `nvidia/nemotron-3.5-lightning-30b-a3b` |
| Working verification model | `nvidia/nemotron-3.5-lightning-30b-a3b`, pinned through the runner process environment on the final local job |

The initial browser job found Super unavailable and switched to hosted Lightning. This was a model fallback, not the fixed-step heuristic fallback. Lightning accepted OpenAI-style tools and `chat_template_kwargs: { enable_thinking: false }`. The configured endpoint/model format matches [NVIDIA's hosted API reference](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer).

The key was never printed or committed. The session could access it as an inherited process/machine variable; a per-user variable was not visible under the execution account. No new credential copy was needed. `services/runner/.env` is gitignored, and process environment takes precedence when its optional values are loaded. Keep all credentials in the runner environment; browser code receives only SpacetimeDB connection settings and user-scoped data.

Final browser verification:

- Project fixture: two rooms plus corridor, 150 people, seed 1.
- Job: `job-5ac83abb-9c4d-4deb-88ed-43b966c95e3b`.
- Model chose real tools: inspect, baseline, hotspots, three candidate tests, two comparisons, proposal submission.
- Runner outcome: **`llm`, 9 tool calls, 1 proposal**. No `llm+heuristic-fallback` occurred on this job.
- Best candidate: widen the exit from 1.2 m to 1.8 m. Evacuation **113.8 → 73.7 s**, delta **−40.1 s (−35.24%)**; max queue **17 → 6**. Same people and seed; no respawn.
- Proposal `job-5ac83abb-9c4d-4deb-88ed-43b966c95e3b.proposal0` reached the subscribed browser client with its ghost/notes, measured deltas and Accept/Reject controls. It was left awaiting human review; layout revision stayed 0.

An earlier live job saved a worse candidate because `submit_proposal` only checked that the candidate had been tested. The tool now checks its original baseline and enforces the existing ranking threshold: `ΔeffectiveTime + 0.1 × ΔmaxQueue < −0.5`. The prompt tells the model to test another suggestion after an unsuccessful candidate and to call `submit_proposal` before claiming an improving edit was saved. Those earlier experimental proposals remain in a separate local test project and were not accepted.

Validation after the fix: all **8 targeted agent/runner tests passed**, including the regression for a non-improving candidate and mismatched baseline; agent, runner and SpacetimeDB TypeScript checks passed, as did targeted lint, the production `npm run build`, and the diff whitespace check. No simulation parameters/formulas changed. All 13 supplied reference files were checked as byte-identical copies.

## Maincloud deployment

Maincloud login was already complete. Published the existing module using:

```powershell
spacetime publish egress-dev --server maincloud --module-path spacetimedb --delete-data=never --yes=remote,skip-login
```

- Database: `egress-dev`.
- Host: `wss://maincloud.spacetimedb.com`.
- Dashboard: [egress-dev](https://spacetimedb.com/egress-dev).
- Database identity: `c2002e8cc2fbee298e07d262464a3d67f0307fba9ea5edbeedeb929a4e562542`.
- No data reset or forced breaking change. The CLI reported a successful build/publication. It warned that its own typecheck could not locate `tsc`; separate project TypeScript verification is recorded below.

The existing client E2E was run against Maincloud with Lightning selected:

```powershell
$env:NEMOTRON_MODEL='nvidia/nemotron-3.5-lightning-30b-a3b'
node packages/client/scripts/e2e-client.ts wss://maincloud.spacetimedb.com egress-dev
```

It passed project creation, a confirmed optimistic edit, local rejection of an invalid edit, undo, **462 replay ticks / 50 of 50 evacuated**, heatmap delivery, a completed agent job with **11 client-visible steps and a proposal ghost**, then proposal acceptance. Output ended `CLIENT E2E OK`. The test uses a temporary runner and stops it when complete. This cloud test verifies the deployed client path; the explicit no-heuristic proof is the local browser job above, whose runner mode was observed.

The user explicitly approved leaving the Maincloud runner active for future simulation and NVIDIA jobs. **A background runner is now connected, registered and ready on `egress-dev`**, using `nvidia/nemotron-3.5-lightning-30b-a3b`. The local `/dev?backend=local` worker remains active separately. These processes run on this machine; they are not auto-start services and must be restarted after reboot or process exit.

Startup initially failed with 401 because the legacy saved token had been issued by the local server. The runner now stores a separate token per URI/database in gitignored `.env.runner-token-<target hash>` files; the legacy file remains untouched and is no longer loaded. The cloud worker successfully registered with a new cloud-issued token. A separate reconnect using that saved token retained the same identity. Runner typecheck and targeted lint passed after this fix; no shared contract changed.

The active Maincloud process ID is recorded in gitignored `services/runner/.env.maincloud-runner.pid`; output/error logs are in `.env.maincloud-runner.log` / `.env.maincloud-runner.err`. Current PID at verification: **564**. Verify the process identity before using a saved PID to stop it. No credentials appear in those notes.

**Since Pass 6 (2026-11-08)** the runner reads the team `.env` at the repo root (copy `.env.example`), so restarting is just:

```powershell
npm start -w @egress/runner
```

Precedence is shell variables, then the optional `services/runner/.env` override, then the root `.env`. Setting `SPACETIME_URI`/`SPACETIME_DB` in the shell (for example `ws://127.0.0.1:3010` / `egress-local`) still points one runner at another database. Publish with `npm run db:publish`; nobody needs `spacetime login`. The runner must be active for new simulations/agent jobs; stored projects, results and replay remain in SpacetimeDB when it stops. See the [Maincloud deployment guide](https://spacetimedb.com/docs/how-to/deploy/maincloud/) for the hosted database lifecycle.

## Deferred frontend and demo work

The later branch demo is now implemented in `frontend/`: see [DEMO_UI.md](DEMO_UI.md). It supports local layout slots and the same UI against Maincloud, where a browser edit/undo and 50-person run passed. The historical handoff details above describe the earlier backend verification; web publication, richer replay controls, furniture and Blender asset integration remain deferred.

[UI_REFERENCE.md](UI_REFERENCE.md) preserves the supplied working reference and reconciles its layout with current decisions. [3D_ASSET_PLAN.md](3D_ASSET_PLAN.md) covers the single 3D scene, locked overhead editing, isometric/freecam transition, viewcube, wall-only dithering, Blender assets and future furniture placement.

Next integration work remains multi-browser checks, venue scene, web hosting, error polish and submission. `egress-dev` is the development database; no production `egress` database or website was deployed in these passes. The demo commits stay on `implement-backend` without a push.
