# Continuous deployment on Windows hosts (Docker Desktop + WSL2)

How to set up automatic deploys to a **staging** machine (and manual ones to **production**)
when every host is Windows running Docker Desktop and WSL2. The pipeline itself already exists:
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys `main` to staging after
CI is green, once a staging runner is online and the repository variable
`AUTO_DEPLOY_STAGING=true` is set. What is left is setting up the host and GitHub.

`deploy.yml` needs a Linux runner, so the runner lives **inside WSL2 Ubuntu** and drives Docker
Desktop's engine. It runs [`deploy/scripts/deploy.sh`](../deploy/scripts/deploy.sh) on the host:
build → Postgres + SeaweedFS → buckets → migrate → api/worker/app → smoke test. For the security
rules behind self-hosted runners see [runners.md](runners.md).

The steps are for one machine. For production, repeat them on the production machine with the
label `deploy-production` and the file `/etc/ingestion-harness/production.env`.

## 1. Prepare Windows

1. **Docker Desktop** → Settings:
   - General: turn on **Start Docker Desktop when you sign in**.
   - Resources → WSL integration: turn on **Ubuntu**.
2. **Install Ubuntu** if it isn't there yet:
   ```powershell
   wsl --install -d Ubuntu
   ```
3. **Stop the machine sleeping:** power settings, Sleep = Never on AC.
4. **Someone must be signed in.** Docker Desktop is not a Windows service: it only runs while a
   user is signed in. Leave the account signed in (locking the screen is fine), or set up
   auto-logon on a dedicated box.
5. **Give the VM enough memory (optional).** Image builds are heavy. In
   `%UserProfile%\.wslconfig`:
   ```ini
   [wsl2]
   memory=12GB
   ```
6. **Docker Desktop updates restart the engine.** An update during a deploy kills it. Turn off
   automatic updates on staging and production, and update by hand.

## 2. Turn on systemd in Ubuntu

The runner runs as a systemd service. In Ubuntu:

```bash
printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
```

Restart WSL from PowerShell, then reopen Ubuntu:

```powershell
wsl --shutdown
```

Check from Ubuntu that Docker works:

```bash
docker version && docker compose version
```

## 3. Install the runner (inside Ubuntu, as your normal user)

No separate `gh-runner` user is needed: your WSL user already reaches Docker Desktop's socket.

1. In GitHub: **Settings → Actions → Runners → New self-hosted runner → Linux x64**.
2. Run its download and verify commands **in your Ubuntu home directory** (`~/actions-runner`),
   not under `/mnt/c`: builds on the WSL filesystem are much faster, and you avoid Windows
   line-ending and permission problems.
3. Register it (use `--labels deploy-production` on the production machine):
   ```bash
   ./config.sh --url https://github.com/kenhayward/ingestion-harness --token <TOKEN> --name "$(hostname)-wsl" --labels deploy-staging --unattended
   ```
   (`self-hosted`, `linux` and `x64` are added automatically.)
4. Install it as a service and start it:
   ```bash
   sudo ./svc.sh install "$USER" && sudo ./svc.sh start
   ```

The runner must be v2.327.1 or newer (the `@v7` actions run on Node 24); a freshly downloaded
runner is, and it updates itself.

## 4. Keep WSL running

WSL shuts Ubuntu down soon after its last terminal closes, which takes the runner offline. Add a
log-on task from an admin PowerShell:

```powershell
$a = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d Ubuntu --exec sleep infinity"
$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName "Keep WSL alive" -Action $a -Trigger $t -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0)
```

Sign out and back in, then check that GitHub shows the runner as **Idle**.

## 5. Create the env file (inside Ubuntu)

Secrets stay on the host, never in the repo or GitHub.

```bash
sudo mkdir -p /etc/ingestion-harness
sudo install -m 600 -o "$USER" /dev/null /etc/ingestion-harness/staging.env
```

Fill it in starting from [`deploy/.env.example`](../deploy/.env.example), with
`nano /etc/ingestion-harness/staging.env` or from Windows at
`\\wsl$\Ubuntu\etc\ingestion-harness\` (that path may need admin rights; save with LF line
endings, see below). At least: new
passwords (`POSTGRES_PASSWORD`, the S3 keys, `RDF_*_PASSWORD` with the `rdf` profile),
`LLM_SECRETS_KEY` and the LLM endpoints.

**Keep Linux line endings.** An editor on the Windows side (Notepad, VS Code with CRLF, a copy
of `.env.example` saved on Windows) may end every line with a carriage return. Docker Compose
ignores it, so the stack starts, but anything else reading the file sees `8081\r` instead of
`8081`: before `deploy.sh` stripped it, the smoke test failed with
`curl: (3) URL rejected: Malformed input to a URL function` and `FAIL /healthz`. Check, in
Ubuntu (prints a count, no secrets):

```bash
grep -c $'\r$' /etc/ingestion-harness/staging.env
```

Anything above 0: strip them with

```bash
sudo sed -i 's/\r$//' /etc/ingestion-harness/staging.env
```

Also check the values themselves: a typo such as `APP_BIND=00.0.0.0` stops the deploy at once
with `invalid IP address`.

**If this machine also runs the dev stack** or another copy of the stack, they share one Docker
Desktop engine, so staging needs its own:

- `COMPOSE_PROJECT_NAME=ingestion-staging`, so it doesn't take over the other stack's containers
  and volumes;
- `APP_PORT`, `S3_PUBLIC_PORT`, `SEAWEEDFS_MASTER_PORT` and `FUSEKI_PUBLIC_PORT`, so they don't
  clash (dev-infra uses 5433, 8335, 9334 and 3010).

**LLM endpoints:** if LM Studio runs on the same Windows machine, containers reach it at
`http://host.docker.internal:1234/v1`; otherwise use the other machine's LAN IP.

## 6. Open the app port to the LAN

Docker Desktop publishes container ports on Windows itself. If other machines or NGINX Proxy
Manager need to reach staging, open the port in Windows Firewall (admin PowerShell, with your
`APP_PORT`):

```powershell
New-NetFirewallRule -DisplayName "CT Studio staging" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow -Profile Private
```

Keep the S3 and SeaweedFS master ports on `127.0.0.1`, as the defaults do. Proxy host settings
are in [deploy/README.md](../deploy/README.md#remote-access-nginx-proxy-manager).

## 7. GitHub settings

- **Settings → Environments:** create `staging` (limit it to the `main` branch if you like) and
  `production` with required reviewers.
- **Settings → Actions → Runner groups:** limit the runners to this repository.
- **Settings → Actions → General:** keep "Require approval for first-time contributors" (or
  stricter) and read-only workflow permissions.

## 8. Test it, then turn on auto-deploy

1. **Actions → Deploy → Run workflow**, environment `staging`, ref `main`.
2. Check that the smoke test passes.
3. Get the admin token from Ubuntu (the deploy log masks it). The runner's checkout is under its
   work folder:
   ```bash
   cd ~/actions-runner/_work/ingestion-harness/ingestion-harness && deploy/scripts/admin-token.sh --env-file /etc/ingestion-harness/staging.env -f deploy/docker-compose.yml
   ```
   Sign in as `admin` with it and add users under Administration > Users.
4. **Settings → Secrets and variables → Actions → Variables:** add `AUTO_DEPLOY_STAGING` =
   `true`. From then on every green CI run on a push to `main` deploys to staging. Fork pull
   requests never reach the runner.

Production stays manual: **Run workflow** with environment `production`.

## Rollback

Run the workflow manually with an older `ref` and **no_build** ticked: it redeploys images
already built on that host.

## Upkeep

- **Docker cleanup:** with systemd on, cron works in Ubuntu. `crontab -e` and add
  ```
  0 3 * * 0 docker system prune -f --filter until=168h
  ```
  Images build up quickly in Docker Desktop's disk image; reclaim space under Docker Desktop →
  Troubleshoot if it grows.
- **Fuseki backup and compaction:** the cron lines in
  [deploy/README.md](../deploy/README.md#triple-store-fuseki) work the same here, with the
  runner's checkout path instead of `/opt/ingestion-harness`.
- **After a reboot:** Docker Desktop, the keep-alive task and the runner service all start once
  the user signs in; allow a minute. A deploy queued meanwhile waits for the runner.
- **Licensing:** Docker Desktop needs a paid subscription for organisations with more than 250
  staff or more than $10M revenue. The alternative is Docker Engine installed inside the WSL
  Ubuntu instead of Docker Desktop; the runner steps stay the same.
