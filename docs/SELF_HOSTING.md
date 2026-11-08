# Hosting Egress on the home desktop at `dontrepeatyourself.dev`

One Windows desktop runs everything: the database, the simulation runner, the website, and a Cloudflare Tunnel that publishes it at https://dontrepeatyourself.dev. The tunnel only makes outbound connections, so there is no port forwarding, the home IP stays hidden, and Cloudflare provides HTTPS (required, because `.dev` is HTTPS-only).

| Piece | Local address | Public address |
|---|---|---|
| SpacetimeDB (projects, runs, agent jobs) | `127.0.0.1:3010` | `wss://db.dontrepeatyourself.dev` (browser routes only) |
| Runner (simulation + Nemotron agent) | outbound to SpacetimeDB | — |
| Website (Next.js production build) | `127.0.0.1:3100` | `https://dontrepeatyourself.dev` |
| Cloudflare Tunnel | outbound to Cloudflare | — |

Steps marked **(Pass 7)** depend on code landing in Pass 7: env-driven endpoints and `npm run deploy:module`. Until then, use the manual commands shown next to them.

---

## 1. Put the domain on Cloudflare (once)

1. Create a free Cloudflare account and choose **Add a site** → `dontrepeatyourself.dev` → the Free plan.
2. At the registrar, replace the nameservers with the two Cloudflare shows you. Wait until the site shows **Active** (minutes to a few hours).
3. Under **SSL/TLS**, choose **Full**. Under **Network**, leave **WebSockets** on.

## 2. Prepare the desktop (once)

1. **Power:** Settings → System → Power → Screen and sleep: **Never** when plugged in. Use wired ethernet. Set Windows Update **active hours** around demos.
2. Install the tools from PowerShell:
   ```powershell
   winget install --id OpenJS.NodeJS.LTS    # Node 22.18 or newer
   winget install --id Git.Git
   winget install --id Cloudflare.cloudflared
   winget install --id NSSM.NSSM            # runs programs as Windows services
   iwr https://windows.spacetimedb.com -useb | iex   # SpacetimeDB CLI (2.14.1 or newer)
   ```
   Open a new terminal afterwards so the tools are on `PATH`, then run `node --version`.

## 3. Get the code

```powershell
git clone https://github.com/davidssien/UTD-Hackathon.git C:\Egress
cd C:\Egress
git checkout STABLE-V2      # or main until STABLE-V2 exists
npm ci
```

## 4. Database and the publisher token (no `spacetime login` needed)

1. Start SpacetimeDB once in a terminal to check it works (Ctrl+C stops it):
   ```powershell
   spacetime --root-dir C:\EgressData\stdb start --listen-addr 127.0.0.1:3010
   ```
2. In a second terminal, create the **publisher identity**. Its token lets anyone on the team publish the module without a spacetimedb.com account:
   ```powershell
   (Invoke-RestMethod -Method Post http://127.0.0.1:3010/v1/identity).token
   ```
   Save the token in a password manager. **The identity that first publishes `egress` owns it; without this token the module can't be updated.**
3. `Copy-Item .env.deploy.example .env.deploy` and fill it in:
   ```ini
   SPACETIME_SERVER_URL=http://127.0.0.1:3010
   SPACETIME_DB=egress
   SPACETIME_PUBLISH_TOKEN=<the token>
   ```
4. Publish the module. This uses a CLI config inside the repo (`.spacetime/`, gitignored), so nobody's personal `spacetime login` is touched.
   - **(Pass 7)** `npm run deploy:module`
   - Until then:
     ```powershell
     $cfg = "C:\Egress\.spacetime\cli.toml"
     spacetime --config-path $cfg server add --url http://127.0.0.1:3010 --no-fingerprint --default home
     spacetime --config-path $cfg login --token <SPACETIME_PUBLISH_TOKEN>
     spacetime --config-path $cfg publish egress --server home --module-path spacetimedb --delete-data=never --yes
     ```
   This flow was verified on 2026-11-08: a server-issued token published a test database to a local server.

## 5. Runner

1. `Copy-Item services\runner\.env.example services\runner\.env` and fill it in:
   ```ini
   EGRESS_SERVICE_SECRET=<the team's runner secret; its sha256 is built into the module>
   NVIDIA_API_KEY=<your key; it never leaves this machine>
   NEMOTRON_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
   SPACETIME_URI=ws://127.0.0.1:3010
   SPACETIME_DB=egress
   ```
2. Test it: `npm start -w @egress/runner`. It should log that it connected and registered. On first connect it saves its own token next to `.env`. Stop it with Ctrl+C.

## 6. Website

1. Point the site at the public database:
   - **(Pass 7)** `Copy-Item frontend\.env.example frontend\.env.local`, then set:
     ```ini
     NEXT_PUBLIC_EGRESS_SPACETIME_URI=wss://db.dontrepeatyourself.dev
     NEXT_PUBLIC_EGRESS_SPACETIME_DB=egress
     ```
   - Until then, use `https://dontrepeatyourself.dev/?backend=local&uri=wss://db.dontrepeatyourself.dev&db=egress`.
2. Build and test:
   ```powershell
   npm run build
   node C:\Egress\node_modules\next\dist\bin\next start C:\Egress\frontend -p 3100
   ```
   Open http://127.0.0.1:3100, then stop it with Ctrl+C.

## 7. Cloudflare Tunnel

```powershell
cloudflared tunnel login                  # browser opens; pick dontrepeatyourself.dev
cloudflared tunnel create egress          # prints a tunnel ID and writes <ID>.json
cloudflared tunnel route dns egress dontrepeatyourself.dev
cloudflared tunnel route dns egress www.dontrepeatyourself.dev
cloudflared tunnel route dns egress db.dontrepeatyourself.dev
```

Create `C:\Users\<you>\.cloudflared\config.yml`:

```yaml
tunnel: egress
credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL-ID>.json
ingress:
  - hostname: dontrepeatyourself.dev
    service: http://127.0.0.1:3100
  - hostname: www.dontrepeatyourself.dev
    service: http://127.0.0.1:3100
  - hostname: db.dontrepeatyourself.dev
    service: http://127.0.0.1:3010
  - service: http_status:404
```

Test it with `cloudflared tunnel run egress` while the database and website are running, then open https://dontrepeatyourself.dev from your phone on cellular data.

## 8. Lock down the public database (required)

A standalone SpacetimeDB lets **any** identity publish new databases. Only the routes the browser needs may reach it from the internet.

1. Open the site with the browser's developer tools → Network, and note every request to `db.dontrepeatyourself.dev`. Expect:
   - `POST /v1/identity` (new visitors)
   - `POST /v1/identity/websocket-token`
   - the WebSocket `GET /v1/database/egress/subscribe`
2. In Cloudflare → Security → WAF → **Custom rules**, add a rule **Block** with this expression (adjust it to match step 1):
   ```
   (http.host eq "db.dontrepeatyourself.dev") and not (
     (http.request.method eq "POST" and http.request.uri.path in {"/v1/identity" "/v1/identity/websocket-token"}) or
     (http.request.method eq "GET" and http.request.uri.path eq "/v1/database/egress/subscribe")
   )
   ```
3. Check from outside: `curl -X POST https://db.dontrepeatyourself.dev/v1/database/test` must be blocked (403), and the site must still load and run.

Publishing still works locally (step 4 uses `127.0.0.1`).

## 9. Start everything at boot

Run as Administrator. Replace `<you>` with your Windows user name.

```powershell
$stdb = "C:\Users\<you>\AppData\Local\SpacetimeDB\bin\current\spacetimedb-cli.exe"
$node = (Get-Command node).Source

nssm install EgressDB $stdb "--root-dir C:\EgressData\stdb start --listen-addr 127.0.0.1:3010"

nssm install EgressRunner $node "src\main.ts"
nssm set EgressRunner AppDirectory C:\Egress\services\runner
nssm set EgressRunner DependOnService EgressDB

nssm install EgressWeb $node "C:\Egress\node_modules\next\dist\bin\next start C:\Egress\frontend -p 3100"
nssm set EgressWeb AppDirectory C:\Egress

foreach ($s in 'EgressDB','EgressRunner','EgressWeb') {
  nssm set $s AppStdout "C:\EgressData\logs\$s.log"; nssm set $s AppStderr "C:\EgressData\logs\$s.log"
  nssm set $s AppRotateFiles 1; nssm set $s AppRotateBytes 10485760
  nssm start $s
}
```

For the tunnel service, copy `config.yml` and `<TUNNEL-ID>.json` into `C:\Windows\System32\config\systemprofile\.cloudflared\`. Change `credentials-file` in that copy to the new path, then run `cloudflared service install`.

Reboot the desktop and confirm the site comes back without logging in.

## 10. Updating to a new version

```powershell
cd C:\Egress
git fetch --tags; git checkout STABLE-V2      # or the new tag
npm ci
npm run deploy:module                          # (Pass 7); or the step 4 commands. Additive changes only.
npm run build
nssm restart EgressRunner; nssm restart EgressWeb
```

## 11. Backups

- **Nightly database copy.** Use a scheduled task at 04:00 that runs:
  ```powershell
  nssm stop EgressRunner; nssm stop EgressDB
  robocopy C:\EgressData\stdb D:\EgressBackups\stdb-$(Get-Date -Format yyyyMMdd) /MIR
  nssm start EgressDB; nssm start EgressRunner
  ```
  Keep the last 7 copies.
- Owners can also download any project as JSON from the saves page (Pass 6).

## 12. Moving projects off Maincloud

Browser identities differ per server, so projects don't move by themselves.

1. Open the Maincloud site (`/?backend=maincloud` once the default changes) and download each project's JSON from the saves page.
2. On https://dontrepeatyourself.dev, use **Import JSON**.

Keep Maincloud running until `STABLE-V2` is tagged; it's the fallback if the home connection drops during a demo.

## 13. Troubleshooting

| Symptom | Check |
|---|---|
| "Sim server offline" chip | `nssm status EgressRunner`; read `C:\EgressData\logs\EgressRunner.log`. Is `SPACETIME_URI` reachable? |
| Site loads but never connects | The tunnel route for `db.` exists; the WAF rule isn't blocking the browser's routes (step 8.1). |
| Publish says unauthorized | It must use the publisher token that first created `egress` (step 4). |
| Agent never uses Nemotron | `NVIDIA_API_KEY` is in `services\runner\.env`; restart EgressRunner. |
| 502 from Cloudflare | That local service is down: `nssm status EgressWeb` or `EgressDB`. |
