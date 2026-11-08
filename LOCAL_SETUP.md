# Updating the Egress server

How to bring the server that hosts https://dontrepeatyourself.dev (currently on `STABLE-V1.1`) up to **`STABLE-V3`**, and how to check it worked. First-time setup of a new machine (Cloudflare Tunnel, services at boot) is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Database | Maincloud, `egress-dev` | The **only** database: production and development share it. There is no separate production database. |
| Website | The server, `127.0.0.1:3100` (service `EgressWeb`) | Published through the Cloudflare Tunnel. |
| Runner (simulation, Nemotron) | The server (service `EgressRunner`) | Must be the **only** runner connected to `egress-dev`. |
| Cloudflare Tunnel | The server (service `cloudflared`) | Unchanged by this update. |

## 1. Database (already done)

`egress-dev` was published with the `STABLE-V3` module on 2026-11-08, so there is nothing to publish for this update. The changes since `STABLE-V1.1` only add tables, views, reducers and edit commands, so a site still on the old tag keeps working until it is updated.

Future module changes are published by whoever holds `SPACETIME_TOKEN` (Cody), **before** restarting the server's services:

```powershell
npm run db:publish
```

## 2. Make sure only the server's runner serves `egress-dev`

Runners race to claim each run, so an old runner anywhere (a laptop, a dev checkout) will take some runs. Old runners can't run multi-floor buildings or grade runs, so those runs come back without a Nemotron grade. Stop every runner except the server's. On a dev machine, close the terminal running `npm start -w @egress/runner` (or stop that `node` process).

Owners can list live runners (needs `SPACETIME_TOKEN`):

```powershell
npm run db:sql -- "SELECT version, last_seen FROM runner_heartbeats"
```

After the update, every row with a recent `last_seen` must say `egress-runner 0.3`.

## 3. Update the code on the server

From PowerShell (as Administrator, for `nssm`):

```powershell
cd C:\Egress
git fetch --tags
git checkout STABLE-V3
npm ci                    # the runner gained a dependency; always reinstall
npm run build             # also fails the build if a secret ends up in the browser bundle
```

`.env` needs no new keys; it stays as in SELF_HOSTING.md §3 (`NVIDIA_API_KEY`, `NEMOTRON_MODEL`, `EGRESS_SERVICE_SECRET`, `SPACETIME_URL`, `SPACETIME_DB=egress-dev`).

**Phone upload needs one service setting.** "Import plan image → Use your phone" makes a QR code that phones open over the internet. Behind the tunnel, the website must know its public address, or it refuses the upload. This value is read from the service's environment, not from `.env`:

```powershell
nssm set EgressWeb AppEnvironmentExtra IMPORT_PUBLIC_ORIGIN=https://dontrepeatyourself.dev
```

Then restart both services:

```powershell
nssm restart EgressRunner
nssm restart EgressWeb
```

## 4. Check it

1. **Runner:** `C:\EgressData\logs\EgressRunner.log` ends with `ready; agent mode: Nemotron (...)`, and the heartbeat query in step 2 shows `egress-runner 0.3`.
2. **Site:** https://dontrepeatyourself.dev opens the saves page. Choose **Example → Two-Story Clinic** and open it.
3. **Furniture:** in Edit, choose **+ → Table** and click the plan. The table appears, and R rotates it. (An error saying the database runs an older module means step 1 was skipped.)
4. **Run and grade:** in Simulate, run an evacuation. When it ends, the readout shows a grade such as *Great - Tests Passed* followed by *graded by Nemotron*. Without that suffix, an old runner served the run (step 2) or `NVIDIA_API_KEY` is missing.
5. **Floors:** with the floor switcher at the bottom left, follow people down the stair to the ground floor.
6. **Airflow:** Layers → Airflow shows flow, and dragging the compass marker changes the wind.
7. **Phone upload:** Import plan image → Use your phone; scan the QR code on a phone using mobile data, and the upload page opens.

## 5. Roll back

```powershell
cd C:\Egress
git checkout STABLE-V1.1
npm ci
npm run build
nssm restart EgressRunner; nssm restart EgressWeb
```

The database needs no rollback: the older site works against the newer module.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Sim server offline" chip | `nssm status EgressRunner`; read its log; check `EGRESS_SERVICE_SECRET` in `.env`. |
| Runs finish with a grade but no "graded by Nemotron" | Another runner served the run (step 2), or `NVIDIA_API_KEY` is missing; restart `EgressRunner`. |
| "This database runs an older Egress module" | Publish the module (step 1). |
| Phone upload says to use the editor, or asks for `IMPORT_PUBLIC_ORIGIN` | Set it on `EgressWeb` (step 3) and restart the service. |
| Site loads but projects never open | `SPACETIME_URL` / `SPACETIME_DB` were wrong at build time; fix `.env`, run `npm run build`, restart `EgressWeb`. |
| 502 from Cloudflare | The website is down: `nssm status EgressWeb`. |
