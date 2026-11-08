# People-flow model: `egress-pedestrian` v0.2

This file records every modelling and math decision behind the people-flow simulation, so the numbers can be defended, tuned, and rebuilt. The code lives in `packages/sim/src/` (`compile.ts`, `nav.ts`, `model.ts`, `fields.ts`, `structural.ts`, `paint.ts`). The constants come from `PARAMS` in `model.ts` and the named constants in those files.

> **Scope and honesty.** This is an exploratory crowd-flow model meant to compare layouts against each other ("modeled change"). It is not calibrated evacuation-certification software. Results are authoritative within the model, not about the real building.

---

## 0. Conventions

- Distances are in meters, time in seconds, and plan coordinates `(x, y)` with +y pointing north.
- The tick is fixed at **Δt = 0.1 s (10 Hz)**. Physics never skips ticks; playback speed only changes how fast frames are shown.
- **Determinism:** randomness comes only from a seeded `sfc32` PRNG, and actors update in stable index order. There is no `Math.random` and no wall-clock time. Identical inputs give identical frames, which a test verifies with a hash.

## 1. Geometry → simulation grid (`compile.ts`)

**Grid**
- Cell size `h = 0.25 m`.
- The grid covers the bounding box of every solid polygon plus a 1 m margin, with its origin snapped to multiples of `h`.

**Solids**
- `wallGeometry(doc, cut = passable)` produces the solid polygons. Passable openings, meaning open doors and exits, are cut out as holes.
- Closed doors and windows stay solid, so they act as walls.
- Corners use mitered joins with a miter limit of 4 half-thicknesses. Past that limit, outer corners are bevelled and the gap is filled by a hub polygon. There are no corner sprites.

**Walkable fraction**
- Each cell is sampled with a 4×4 grid of sub-points: `w_i = 1 − (solid samples / 16)`.
- This keeps partial coverage, so a 0.9 m door that doesn't line up with the grid is never lost.

**Rooms**
- Rooms are the bounded faces of the planar wall graph, treating openings as closed.
- A cell belongs to room `k` if its center lies in room `k`'s polygon.
- Doors are room boundaries for painting and density smoothing, but not for movement.

**Navigable cells**
- A cell is navigable when `w_i ≥ 0.3`, its center is not inside a solid, and it is inside a room — or it lies in an exit gap (the opening's width × wall thickness, plus 1.5 cells outward).

**Thin walls**
- A 0.2 m wall is thinner than a cell, so cells alone cannot separate two rooms.
- Every step between two cell centers that crosses a wall edge is blocked by a per-cell, per-direction bitmask `blockedEdges[i] & (1 << k)`.
- Diagonal steps also require both orthogonal neighbours to be navigable, so paths never cut corners.

**Clearance**
- `c_i` is the distance from a cell's center to the nearest wall edge, capped at 1 m.

## 2. Navigation fields (`nav.ts`)

There is one distance field `D_e` per exit `e`.

**Seeds**
- The seeds are the navigable cells on the outer half of the exit gap, where `(p − center) · n̂_out ≥ 0`.
- So the distance is measured to beyond the opening, and paths run through the gap.

**Dijkstra**
- 8-connected, with step lengths `h` for orthogonal moves and `√2·h` for diagonal ones.
- Each step costs:
  ```
  cost(step into j) = len · (1 + P · max(0, (C − c_j) / C))      with C = 0.35 m, P = 6
  ```
  This clearance penalty makes routes prefer the middle of corridors and doorways. Without it, routes hug wall faces closer than a body radius, and people wedge against door jambs.
- The search runs in float64. Comparing float64 heap keys against float32 stored distances caused valid nodes to be skipped, which was bug D26.

**Direction field**
- At cell `i` with value `D_i`, sum over the passable lower neighbours `j`:
  ```
  v = Σ_j (D_i − D_j)/len_j · û_j,      direction = v / |v|
  ```
  This weighted descent is smoother than "step to the lowest neighbour". If `i` itself is not navigable, for example a person pushed against a wall, the direction points to the lowest neighbour.

**Unreachable people**
- A person whose cell has `D_e = ∞` for every allowed exit is counted `unreachable` at tick 0.
- They stay in place and are reported separately, never silently dropped.

## 3. Population (`model.ts::initialize`, `paint.ts`)

**Head count**
- N is fixed by the scenario. Painting never changes it.

**Spawn weights**
- Spawnable cells are navigable, inside a room, and have `w_i ≥ 0.5`.
- Each spawnable cell gets weight `W_i = w_i · ρ_i`, where `ρ_i` is the painted relative density: 1 by default, within [0, 4].
- The probability of starting in cell `i` is `p_i = W_i / Σ_j W_j`, sampled through a cumulative table with binary search.
- The position is uniform within the chosen cell.

**Rejection rules**
- A candidate is rejected if it is within `r + 0.02 m` of a wall edge, inside a solid, or within `r_a + r_b + 0.02 m` of an already placed person.
- Each person gets 250 attempts. If anyone still can't be placed, the run fails with `POPULATION_INFEASIBLE` and reports how many were placed.
- Random sequential placement jams at roughly 55% coverage. That works out to about 2.6 persons/m² for these radii; beyond that the error is the honest answer.

**People**
- Radius `r ~ U(0.22, 0.25)` m: half shoulder width.
- Preferred speed `v₀ ~ N(1.34, 0.26)`, clamped to [0.8, 1.8] m/s. This is the commonly cited free walking speed distribution for adults (Weidmann).

**Painting** (`paintWeights`)
- Weights start at `ρ = 1` on spawnable cells.
- Each stroke is a polyline with radius `R`. For every cell whose center is within `d ≤ R` of the polyline, the falloff is:
  ```
  f = 1 (flat)    or    f = 1 − d/R (linear)
  ```
- Each mode updates the weight as follows:

  | Mode | Update |
  |---|---|
  | set | ρ ← ρ + (W − ρ)·f |
  | increase | ρ ← ρ + |W|·f |
  | decrease | ρ ← ρ − |W|·f |
  | erase | ρ ← ρ + (1 − ρ)·f |

  Then clamp to [0, 4].
- Strokes apply per cell, with no smoothing. A brush crossing a wall therefore makes independent patches on each side and never blurs through the wall.

**Controlled comparisons**
- `initialActors` reuses the exact positions, radii and speeds of a baseline run.
- Anyone whose spot is now blocked is respawned and counted as `respawned`. A comparison is "controlled" only when `respawned = 0`.

## 4. Movement step (`model.ts::step`)

Each tick:

1. **Refill flow tokens** at every portal `p`. Blocked exits get `cap = 0`.
   ```
   T_p ← min(max(1, 0.5·cap_p), T_p + cap_p·Δt),    cap_p = 1.3 · width_p   (persons/s)
   ```
   1.3 persons/m/s is the usual planning value for door flow capacity. The bucket holds at most half a second of flow (at least 1 token), so short bursts are allowed but sustained flow is capped.

2. **Exit choice (v0.2, PLAN.md D79).** People know the whole layout and can reach any exit. The per-exit distance fields `D_e` are exact shortest paths, so A* would add nothing.

   *Why v0.1 failed:* everyone re-chose on the same tick every 2 s, using the queue standing at each door. When one door queued, everyone saw the other as empty and switched together, then switched back once the queue moved: a crowd shimmying between doors.

   **Per-person traits.** These are drawn once from the run seed on a separate random stream from spawning, so positions are unchanged and the same person keeps the same traits in before/after comparisons:
   - Attention span `τ_i`: lognormal, median 6 s, σ = 0.5, clamped to [2, 15] s.
   - Waiting weight `κ_i`: uniform [1.2, 1.8]. Waiting feels longer than walking.
   - Patience `P_i`: `6·τ_i` plus noise (±5 s), clamped to [20, 90] s.

   **Expected wait counts the people ahead, not the crowd at the door.** Once per second, each exit's assigned people are sorted by their distance to it. Then
   ```
   W_e(i) = |{ j ≠ i : exit_j = e, D_e(x_j) < D_e(x_i) }| / cap_e
   ```
   is a binary search. Demand that has committed to a door is visible before it arrives.

   **Perceived cost:**
   ```
   C_e(i) = D_e(x_i)/v_i + κ_i · W_e(i) · (1 + min(1, w_i/P_i) if e is i's current exit, else 1)
   ```
   `w_i` is how long `i` has waited: seconds spent slower than 0.3 m/s in the same room as their chosen exit, since their last switch. Being held at an inner door doesn't count, because changing exits wouldn't help. The current queue feels worse the longer you stand in it.

   **When people re-decide.** Each person re-evaluates every `τ_i` seconds, with a random first phase. They switch to the cheapest exit only if:
   ```
   C_cur − C_best > max(3 s, 0.15·C_cur) · (1 − min(1, w_i/P_i))
   ```
   - They never switch within 4 m of their current exit.
   - They don't switch again for `2τ_i` after a switch.
   - At `w_i ≥ P_i` they re-evaluate at once with half the margin, then `w_i` resets, so another switch needs fresh patience.
   - Going back to the exit they just left always needs the full margin `max(3 s, 0.15·C_cur)`, impatient or not. After going back once, a person commits to that exit for good, so nobody cycles.

   **Start:** first the nearest exit by `D_e/v_i`, then one round of the full rule without thresholds, so the opening split already accounts for everyone else.

   **Reported:** `exitSwitches` (total switches) and `exitReversals` (A→B→A). Flip-flopping shows up in the numbers.

   *Calibration:* these are plausible modelling choices from the evacuation-behaviour literature's qualitative findings: people commit to a route, waiting feels long, and patience runs out. They are not yet calibrated against drill data. Section 10 lists them as tuning knobs.

3. **Desired direction**, in priority order:
   - Inside the exit gap: the outward normal `n̂_out`.
   - Within 1.5 m of the chosen exit and still inside: aim at `center + 0.4·n̂_out`. This "funnel" pulls people into the opening.
   - Otherwise: the direction field of `D_e`.

4. **Driving force** (social-force model, simplified):
   ```
   a = (v₀·ê − v)/τ                                τ = 0.5 s
     + Σ_b A·exp((r_a + r_b − d_ab)/B)·n̂_ab·φ_ab    A = 3.0 m/s², B = 0.25 m, for d_ab ≤ 1.2 m
     + A_w·exp((r_a − d_w)/B_w)·n̂_w                 A_w = 4.0 m/s², B_w = 0.12 m, for d_w ≤ 0.6 m
   ```
   - **Anisotropy** `φ_ab = λ + (1 − λ)·(1 + cos θ)/2`, with `λ = 0.35`. θ is the angle between your heading and the direction to the neighbour, so people behind you push less.
   - **Walls repel from the single closest point** across all nearby edges. Summing over edges double-counts at corners, where two polygon edges share a point. That created force equilibria at door jambs, where people stalled forever (D27).
   - **Neighbours** come from a spatial hash with 1.25 m buckets, searching 3×3 buckets.
   - **Caps:** `|a| ≤ 6 m/s²`, and after `v ← v + a·Δt`, `|v| ≤ 1.4·v₀`.

5. **Portal gating.** If the move `x → x + v·Δt` crosses a portal line (a door or exit segment):
   - With a token: `T_p ← T_p − 1` and the move goes ahead.
   - Without one: the person stays put, `v = 0`, and is flagged `queued`.

   This token bucket is what makes queues form at narrow openings, independent of the force model.

6. **No pass-through.** A move is refused if its endpoint is inside a solid polygon or the segment crosses a wall edge. The person then tries axis-only slides, x then y, and otherwise stays. After the move, any overlap with a wall edge (`d < r`) is pushed out along the normal, unless that push would itself enter a solid or cross a portal.

7. **Body overlaps.** One deterministic pass over pairs `a < b`: if `d < r_a + r_b`, each moves half the overlap apart. A push is skipped if it would enter a wall or cross a door/exit line, so separation can never bypass flow capacity.

8. **Exit sweep.** After all movement, anyone past an exit line counts as exited, however they got there. The test is `0 < (x − c)·n̂_out < 2 m` and `|(x − c)·â| ≤ width/2 + r`. Exited people freeze in place and are hidden.

9. **Jam breaking**, which models people adjusting their stance:
   - **stuck**: counts ticks with speed below 0.3 m/s while not token-blocked.
   - **Yield:** if stuck for more than 10 ticks, repulsion from higher-index neighbours is scaled by 0.2. This deterministically breaks symmetric two-person jams.
   - **Squeeze:** if stuck for more than 20 ticks within 3 m of a portal, the person "turns sideways" for 60 ticks. Their contact radius becomes `min(r, 0.13 m)` for neighbour forces, wall push-out and overlap separation. Their center still can never enter a wall.
   - Together these took every seed of every fixture from occasional permanent jams to complete evacuation (D27). Note: they shave roughly 5–10% off clearance times in tight doors compared with a stricter body model. Comparisons between layouts stay valid because both sides use the same rules.

**Completion (D38: Live ends when the flow has stabilized).** The run ends at the first of these, and the reason is reported in `metrics.endReason`:

| Reason | Condition |
|---|---|
| `all-out` | `exited + unreachable = N` |
| `stabilized` | no exits and mean speed of the people inside below 0.05 m/s for 100 consecutive ticks (10 s) |
| `timeout` | `t ≥ durationSeconds`, kept only as a safety cap |

Stabilization costs O(N) per tick: one running sum of speeds and a counter. It catches crowds that are trapped or stalled but were not unreachable at the start.

For future steady-state scenarios (Circulate), stabilization means the occupancy and the heatmap changing less than ε over the window. That would use the same mechanism with different progress signals.

## 5. Fields and heatmaps (`fields.ts`)

**Sampling**
- Fields are sampled at **2 Hz** (every 5 ticks) and once more at completion.

**Density**
- Each active person deposits into every cell of a 5×5 box (±2 cells, 1.25 m), but only cells in the same room as the person.
- Each deposit is normalized by how many same-room cells that receiving cell's own kernel covers:
  ```
  ρ_j = Σ_{a: cell(a) ∈ K(j), room = room(j)} 1 / (|K_room(j)| · h²)        persons/m²
  ```
  Nothing bleeds through walls or door thresholds, and density isn't diluted next to walls.

**Speed**
- Mean `|v|` of the people contributing to each cell. In the browser it is computed from displacement between consecutive frames.

**Congestion** (a heuristic index, not a physical quantity)
```
C_j = ρ_j · max(0, 1 − s̄_j / 1.34)
```
It is high where many people are moving much slower than free walking speed. Stationary crowds count only where they are slowed; there is no "visitor" state in evacuations.

**Aggregations**

| Aggregation | Meaning |
|---|---|
| `instant` | latest sample |
| `timeAverage` | Σ samples / number of samples over the whole run |
| `perCellPeak` | max over samples, plus the tick it peaked |

The default heatmap after a run is time-averaged congestion, because the final instant is an empty building.

**Hotspots / bottlenecks**
- Local maxima (8-neighbourhood) of time-averaged congestion above 0.02, at least 1.5 m apart, top 5.
- Each carries its peak tick and, if one is within 3 m, the nearest door or exit.

**Where they are computed**
- The runner stores the final aggregates in `sim_results` as `egress-fields-v1`.
- The browser recomputes live overlays from replay frames using the same `FieldAccumulator` (D15).

## 6. Metrics

| Metric | Definition |
|---|---|
| `evacuationTimeSeconds` | the tick the last reachable person exited ÷ 10; `null` on timeout |
| `effectiveTime` (agent ranking) | `evacuationTime`, or on a timeout `t_end + 10 s × people still inside`. A change that gets everyone out beats one that doesn't. |
| `maxQueueLength` | the maximum over ticks of `max_e Q_e` |
| `meanCongestion` | mean of time-averaged congestion over cells ever occupied |
| `peakCongestion` | max of per-cell peaks |
| `perExitThroughput` | people out through each exit; sums to the evacuated count |

## 7. Structural estimate for Edit mode (`structural.ts`)

No people are simulated.

**Exit distance**
```
min_e D_e(i)
```

**Route demand**
- Every spawnable cell `o` sends its floor area `w_o·h²` downhill along its nearest exit's field, using steepest-neighbour descent that respects wall edges.
- Each cell on the path accumulates that area, so `RD_i` = the m² of floor whose shortest route passes through cell `i`.
- Two same-room 3×3 box-blur passes turn the one-cell paths into bands.
- It is labelled a **potential bottleneck estimate**, never congestion.

## 8. Agent comparisons (`packages/agent`)

- Candidate edits are tested with the **same seed and the same initial people** (`initialActors`).
- The delta is always candidate minus baseline: `evacuationTimeSeconds`, `evacuationTimePercent`, `maxQueueLength`, `peakCongestion`, `meanCongestion`, `effectiveTimeSeconds`.
- A candidate is proposed only if `Δeffective + 0.1·ΔmaxQueue < −0.5 s`.
- **Robustness** (`confirm_candidate`, spec P1 "three random-seed comparison"):
  - The winner is re-tested on seeds `s+1` and `s+2`. Each seed gets a fresh crowd, and the candidate reuses that seed's baseline people.
  - The tool reports the `Δeffective` for each seed, the mean, the worst seed, and whether every seed improved.
  - The proposal is refused if the mean across the three seeds is `≥ −0.5 s`.
  - Each proposal's evidence carries `seedsTested`, `robustMeanSeconds` and `robustWorstSeconds`.
- **Before/after maps** (`compareRuns` in `@egress/client`, `fieldDifference` in core):
  - The map is candidate − baseline time-averaged congestion. Candidate values are sampled at each baseline cell's center, so slightly different grids still line up.
  - Negative cells are where the change relieved crowding.
- The suggestions it tests are geometric and validated:
  - widen the nearest door or exit by +0.6 m (or +0.3 m), within its wall's free span;
  - add a 1.2 m exit at the middle of the best free outside wall.

## 9. Validation status and performance

**Tests** (`packages/sim/test/sim.test.ts`):
- never inside a wall (3 seeds, every tick)
- queues form at 0.9 m doors
- deterministic frames
- a blocked exit reroutes and is slower
- sealed rooms are counted as unreachable
- infeasible populations error
- the heatmap survives the run
- structural demand peaks at the exit
- painting respects N and zero areas

**Benchmarks** (laptop, single thread):

| Scenario | Result |
|---|---|
| Hall, 500 people | ≈ 1.5 ms/tick; everyone out in about 141–144 s simulated across seeds |
| One-room, 80 people through 0.9 m | 73–77 s, against 68 s at the theoretical 1.17 persons/s capacity |

**Not modelled yet:** stairs and multi-floor transitions, fire, smoke and air, group behaviour, pre-movement time, disability profiles, counter-flow at doors (both directions share one bucket).

## 10. Tuning knobs (and what they move)

| Knob | Effect |
|---|---|
| `FLOW_PER_METER` (1.3) | the main throughput limit at openings; directly sets clearance times |
| `socialA`, `socialB` | how tightly crowds pack, and how early people slow behind others |
| `tau` | how quickly people recover their speed |
| `CLEARANCE_M`, `CLEARANCE_PENALTY` | how strongly routes centre in corridors and doorways |
| `squeezeAfter`, `squeezeTicks`, `squeezeRadius` | how fast jams clear (lower = faster, less physical) |
| `fieldEvery`, `KERNEL` | heatmap temporal and spatial smoothness |
