# Egress studio (UI v2)

Branch `backend-passes`. Design source: ARCHITECTURE.md §8 "UI direction v2" and the sketches in `docs/reference/gui/sketches/layout-v2-*.png`.

## Open it

`npm install`, copy `.env.example` to `.env` at the repo root and fill it in, then `npm run dev` and open http://localhost:3000/.

| URL | Backend |
|---|---|
| `/` | The server in the repo `.env` (`SPACETIME_PUBLIC_URL` or `SPACETIME_URL`, plus `SPACETIME_DB`), inlined at build time. Without a `.env`: Maincloud `egress-dev`. Projects live on the server; the browser keeps only its SpacetimeDB token. |
| `/?backend=maincloud` | Maincloud `egress-dev`, whatever the `.env` says. |
| `/?backend=local` | A local SpacetimeDB at `ws://127.0.0.1:3010`, database `egress-local`. Add `&db=egress-backend` (or `&uri=`) to point elsewhere. Start a runner for the same database. |
| `/?backend=mock` | In-memory development backend (real simulation and agent in the browser). Nothing is stored. |
| `?project=<id>` | Opens that project if you are a member. The URL always tracks the open project. |
| `?join=<code>` | Joins through a share link (viewer access), then opens the project. |

The old `/dev` harness and the ExitCraft-era editor/viewer components were removed on 2026-11-08; the partner's scan importer keeps its components.

## Layout

- **Top left:** project name with sync dot (green saved, amber saving, red disconnected); click for Projects. The viewcube sits below it.
- **Top center:** `Edit | Simulate | Analysis` (keys 1 / 2 / 3).
- **Top right:** "Sim server offline" chip when no runner heartbeat; **Layers**.
- **Left edge:** pull tab. Open it for Projects, Share, Import plan image, Export (JSON / PNG) and Frame (F).
- **Right:** the context pane, only when there is something to show. Its dashed bottom box holds the primary action.
- **Bottom:** the context toolbar.

## Modes

**Edit** (top-down, locked)
- Select (V), Wall (W), Room (R), Door (D), Window (N), Exit (E), Erase (X), Undo / Redo (Ctrl+Z / Ctrl+Shift+Z).
- **Right-click the Wall button** for the wall type (Normal / Reinforced / Glass). Right-click a wall on the canvas to change its type or delete it.
- Walls chain click-to-click; Esc or right-click ends the chain; clicking the start point closes it. Drag draws one segment. Axis-locked by default; hold Shift for any angle. Snaps to existing vertices (0.3 m), otherwise to the 0.25 m dots. A live dimension follows the cursor.
- Doors, windows and exits preview on the nearest wall before you click.
- Middle-drag or Space+drag pans; wheel zooms. Delete removes the selection.
- Selecting a wall or opening opens the inspector (type, thickness, height / kind, width, open/closed).

**Simulate**
- Pane: people, distribution (Uniform; Painted comes later), seed, then live readout: end state, evacuation time, how far the server has computed, evacuated, still inside, max queue, and people who cannot reach an exit.
- Toolbar: « 10 s, play/pause, » 10 s (also ←, Space, →), timeline up to the LIVE edge, `LIVE` / `END` badge, playback 1× / 2× / 4×.
- The server always computes at 4× and runs ahead; pause and scrub are client-side. A run ends only when everyone reachable is out, the flow stops changing for 10 s, or a 15-minute safety cap.

**Analysis**
- Toolbar: chat bar. An empty message asks for the worst bottleneck and a measured fix.
- Pane: the question, each measured agent step with its number, the agent's answer, the suggestion (reasons, Δ evacuation time, Δ max queue, crowds tested, mean across crowds, before → after), a difference-map toggle, and Accept / Reject.
- Suggested edits glow blue on the model, with a bubble giving the short reason next to each edit.

**Layers**: People (Discrete dots, or Heatmap of density or congestion as Current / Average / Peak, with a legend). Airflow is listed and disabled.

## Scene

- Blueprint floor with a white dot grid (0.25 m dots, brighter every 1 m and 5 m; small dots fade out when zoomed out). No grid lines.
- Walls hiding the floor are cross-hatched (never in top-down views).
- Viewcube: drag to orbit; click a face, edge or corner. Locked to Top in Edit.
- Wall looks come from `frontend/public/assets/walls/manifest.json` (Blender textures; see the README there).

## Verified (2026-11-08)

- `?backend=mock`: drew a reinforced wall with snapping and dimensions; inspector edits; right-click type menu; 150-person run to "Everyone is out" at 114.4 s with END; heatmap Average; viewcube edge click and drag-orbit; agent proposal (exit 1.2 → 1.8 m, −40.8 s, mean −35.8 s over 3 crowds) shown blue with its bubble; Accept applied it.
- `?backend=local&db=egress-backend` with a runner: project created server-side, runner online, a run streamed from the server (playhead behind the LIVE edge), and the server agent's proposal (−40.1 s; mean −35.6 s over 3 crowds) rendered the same way.
- Not yet checked against Maincloud from this UI.

## Not done yet

- Presence (person icon + count, hover for tokens), permanent share links and role management need the collaboration backend ([PLAN.md](../PLAN.md) §3 C). Share currently creates a 14-day viewer invite.
- Population painting in Simulate; fire / elements.
- Compliance-based and multi-edit suggestions (backend follow-ups).
