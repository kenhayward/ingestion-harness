# GitHub Actions runners

This is a public repository. **CI (`ci.yml`) runs on GitHub-hosted runners** (`ubuntu-24.04`),
so pull requests from forks never execute on our own machines. Only **deploys (`deploy.yml`)**
use self-hosted runners, installed on the deploy hosts. Those jobs run only for pushes to `main`
in this repository or for manual dispatches by a maintainer.

## Runner roles and labels

| Role | Labels | Host requirements |
| --- | --- | --- |
| Staging deploy | `self-hosted, linux, deploy-staging` | Runs **on** the staging host; Docker access; `/etc/ingestion-harness/staging.env` |
| Production deploy | `self-hosted, linux, deploy-production` | Runs **on** the production host; Docker access; `/etc/ingestion-harness/production.env` |

Automatic staging deploys after green CI on `main` are off until you set the repository
variable `AUTO_DEPLOY_STAGING=true` (Settings → Secrets and variables → Actions → Variables).
Set it once a `deploy-staging` runner is online, so deploy jobs don't sit queued with no runner.

## Registering a runner (Linux)

Once the GitHub repo exists: **Settings → Actions → Runners → New self-hosted runner** shows a
one-time registration token. On the host:

```bash
sudo useradd -m -s /bin/bash gh-runner && sudo usermod -aG docker gh-runner
sudo -iu gh-runner
mkdir actions-runner && cd actions-runner
# download + verify the runner tarball exactly as shown on the GitHub page, then:
./config.sh --url https://github.com/<org>/<repo> --token <TOKEN> \
  --name staging-01 --labels deploy-staging --unattended
exit
cd /home/gh-runner/actions-runner && sudo ./svc.sh install gh-runner && sudo ./svc.sh start
```

For production use `--labels deploy-production`. Create the env file:

```bash
sudo mkdir -p /etc/ingestion-harness
sudo install -m 600 -o gh-runner /dev/null /etc/ingestion-harness/staging.env
sudo -e /etc/ingestion-harness/staging.env   # start from deploy/.env.example
```

## Security notes

- **Never point `ci.yml` or any `pull_request` workflow at a self-hosted runner.** The repo is
  public, so a fork PR could run arbitrary code on that machine. Self-hosted runners serve only
  `deploy.yml`, which is gated to `workflow_dispatch` and to CI runs on pushes to `main` from
  this repository.
- Settings → Actions → General: keep "Require approval for first-time contributors" (or
  stricter), and keep workflow permissions read-only by default.
- Restrict deploy runners to this repository (runner groups) and give the runner user only the
  Docker access it needs.
- Use GitHub **Environments** (`staging`, `production`) with required reviewers on production
  (Settings → Environments). Deploy jobs reference them via `environment:`.
- Deploy secrets stay on the deploy hosts (`ENV_FILE`), not in GitHub secrets, so a CI runner
  compromise doesn't expose production credentials.
- Deploy runners are long-lived: prune Docker periodically (`docker system prune --filter until=168h`) via cron.
- Consider ephemeral runners (`./config.sh --ephemeral`) with an autoscaler if job volume grows.

## Local deploy runner on a Windows dev machine (WSL2)

`deploy.yml` needs a Linux runner, so on Windows run the Linux runner inside WSL2 and let it use
Docker Desktop's engine. (CI needs no local runner; it runs on GitHub-hosted runners.)

1. **Actions must be enabled** for the repo (Settings → Actions → General).
2. **WSL + Docker:** `wsl --install -d Ubuntu`, then Docker Desktop → Settings → Resources →
   WSL integration → enable Ubuntu. Check from Ubuntu: `docker version` and `docker compose version`.
3. **Enable systemd** so the runner can run as a service: add `[boot]` / `systemd=true` to
   `/etc/wsl.conf` in Ubuntu, then `wsl --shutdown` from Windows and reopen Ubuntu.
4. **Register** (inside Ubuntu, as your normal user, which already has Docker Desktop's socket):
   Settings → Actions → Runners → New self-hosted runner → Linux x64, run the download/verify
   commands it shows, then
   ```bash
   ./config.sh --url https://github.com/<org>/<repo> --token <TOKEN> \
     --name "$(hostname)-wsl" --labels deploy-staging --unattended
   sudo ./svc.sh install "$USER" && sudo ./svc.sh start
   ```
   (`self-hosted`, `linux`, `x64` labels are added automatically.)
5. **Keep WSL running:** WSL stops a distro shortly after its last terminal closes, which takes
   the runner offline. Add a Task Scheduler task at log-on that runs
   `wsl.exe -d Ubuntu --exec sleep infinity`.

The runner must be v2.327.1 or newer (the `@v7` actions run on Node 24); a freshly downloaded
runner is, and it updates itself. Create `/etc/ingestion-harness/staging.env` as above, then set
`AUTO_DEPLOY_STAGING=true` to deploy every green `main` here.

## Windows runners

The workflows assume Linux runners (bash, Docker Linux containers). The deploy scripts have
PowerShell equivalents (`deploy/scripts/*.ps1`) if a Windows deploy host is ever required; a
`windows` variant of `deploy.yml` would call `deploy.ps1 -EnvFile ...`.
