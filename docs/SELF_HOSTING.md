# Hosting Egress at `dontrepeatyourself.dev`

**The database stays on Maincloud** (`egress-dev`, on Cody's account). **The home desktop runs only the website and the runner.** A Cloudflare Tunnel publishes the site at https://dontrepeatyourself.dev. The tunnel only makes outbound connections, so there is no port forwarding, the home IP stays hidden, and Cloudflare provides HTTPS (required, because `.dev` is HTTPS-only). See PLAN.md D84–D85.

| Piece | Where | Public address |
|---|---|---|
| SpacetimeDB: projects, runs, agent jobs | Maincloud | `wss://maincloud.spacetimedb.com`; browsers connect directly |
| Runner: simulation + Nemotron agent | Desktop, outbound to Maincloud | — |
| Website: Next.js production build | Desktop, `127.0.0.1:3100` | `https://dontrepeatyourself.dev` |
| Cloudflare Tunnel | Desktop, outbound to Cloudflare | — |

---

## 1. Put the domain on Cloudflare (once)

1. Create a free Cloudflare account and choose **Add a site** → `dontrepeatyourself.dev` → the Free plan.
2. At the registrar, replace the nameservers with the two Cloudflare shows you. Wait until the site shows **Active** (minutes to a few hours).
3. Under **SSL/TLS**, choose **Full**.

## 2. Prepare the desktop (once)

1. **Power:** Settings → System → Power → Screen and sleep: **Never** when plugged in. Use wired ethernet. Set Windows Update **active hours** around demos.
2. Install the tools from PowerShell, then open a new terminal so they are on `PATH`:
   ```powershell
   winget install --id OpenJS.NodeJS.LTS    # Node 22.18 or newer
   winget install --id Git.Git
   winget install --id Cloudflare.cloudflared
   winget install --id NSSM.NSSM            # runs programs as Windows services
   ```
   The SpacetimeDB CLI is only needed if you publish the module from this machine: `iwr https://windows.spacetimedb.com -useb | iex`.

## 3. Get the code and the `.env`

```powershell
git clone https://github.com/davidssien/UTD-Hackathon.git C:\Egress
cd C:\Egress
git checkout STABLE-V2      # or main until STABLE-V2 exists
npm ci
Copy-Item .env.example .env
```

Fill in `C:\Egress\.env`:

```ini
NVIDIA_API_KEY=<your key; it never leaves this machine>
NEMOTRON_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
EGRESS_SERVICE_SECRET=<the team's runner secret; its sha256 is built into the module>
SPACETIME_URL=https://maincloud.spacetimedb.com
SPACETIME_DB=egress-dev
SPACETIME_DB_IDENTITY=<optional; the database identity>
SPACETIME_TOKEN=<leave blank unless you publish from this machine>
```

The website and runner don't need `SPACETIME_TOKEN`. It is only for `npm run db:publish`, `db:logs` and owner `db:sql`.

## 4. Runner

Test it in a terminal:

```powershell
npm start -w @egress/runner
```

It should log that it connected to Maincloud and registered. It saves its own token in `services\runner\` (gitignored) on first connect. Stop it with Ctrl+C.

**Only one runner should serve `egress-dev` in production.** Once the desktop's runner is a service (step 7), stop any runner left running on a dev machine.

## 5. Website

```powershell
npm run build
node C:\Egress\node_modules\next\dist\bin\next start C:\Egress\frontend -p 3100
```

- The build reads `SPACETIME_URL` and `SPACETIME_DB` from `.env`; only those two values reach the browser.
- The build fails if a secret value shows up in the bundle.

Open http://127.0.0.1:3100 and check that a project opens, then stop the server with Ctrl+C.

## 6. Cloudflare Tunnel

```powershell
cloudflared tunnel login                  # browser opens; pick dontrepeatyourself.dev
cloudflared tunnel create egress          # prints a tunnel ID and writes <ID>.json
cloudflared tunnel route dns egress dontrepeatyourself.dev
cloudflared tunnel route dns egress www.dontrepeatyourself.dev
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
  - service: http_status:404
```

Test it: while the website is running, run `cloudflared tunnel run egress` and open https://dontrepeatyourself.dev on your phone over cellular data.

## 7. Start everything at boot

Run as Administrator. Replace `<you>` with your Windows user name.

```powershell
$node = (Get-Command node).Source
New-Item -ItemType Directory -Force C:\EgressData\logs | Out-Null

nssm install EgressRunner $node "src\main.ts"
nssm set EgressRunner AppDirectory C:\Egress\services\runner

nssm install EgressWeb $node "C:\Egress\node_modules\next\dist\bin\next start C:\Egress\frontend -p 3100"
nssm set EgressWeb AppDirectory C:\Egress

foreach ($s in 'EgressRunner','EgressWeb') {
  nssm set $s AppStdout "C:\EgressData\logs\$s.log"; nssm set $s AppStderr "C:\EgressData\logs\$s.log"
  nssm set $s AppRotateFiles 1; nssm set $s AppRotateBytes 10485760
  nssm start $s
}
```

For the tunnel:
1. Copy `config.yml` and `<TUNNEL-ID>.json` into `C:\Windows\System32\config\systemprofile\.cloudflared\`.
2. In the copied `config.yml`, change `credentials-file` to the new path.
3. Run `cloudflared service install`.

Reboot the desktop and confirm the site comes back without logging in.

## 8. Updating to a new version

```powershell
cd C:\Egress
git fetch --tags; git checkout STABLE-V2      # or the new tag
npm ci
npm run build
nssm restart EgressRunner; nssm restart EgressWeb
```

Module changes are published separately by whoever holds `SPACETIME_TOKEN`. That is Cody, from his own machine: `npm run db:publish`, which never deletes data. Publish the module **before** restarting services that depend on new reducers.

## 9. Backups

The database lives on Maincloud. For extra safety, owners can download any project as JSON from the saves page (Pass 7).

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| "Sim server offline" chip | `nssm status EgressRunner`; read `C:\EgressData\logs\EgressRunner.log`. Is `EGRESS_SERVICE_SECRET` set in `.env`? |
| Site loads but projects never open | `SPACETIME_URL`/`SPACETIME_DB` in `.env` were wrong at build time; fix them and rebuild. |
| Agent never uses Nemotron | `NVIDIA_API_KEY` is in `.env`; restart EgressRunner. |
| 502 from Cloudflare | The website is down: `nssm status EgressWeb`. |
| Runs or agent jobs handled by a dev machine instead of the desktop | Another runner is still serving `egress-dev`; stop it (step 4). |
