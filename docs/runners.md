# Self-hosted GitHub Actions runners

This is a private repository and all workflows run on self-hosted runners. GitHub-hosted runners
are not used.

## Runner roles and labels

| Role | Labels | Host requirements |
| --- | --- | --- |
| CI | `self-hosted, linux, x64, ingestion-ci` | Docker Engine + compose plugin, git, curl. Node/uv are installed per job by `setup-node` / `setup-uv`. |
| Staging deploy | `self-hosted, linux, deploy-staging` | Runs **on** the staging host; Docker access; `/etc/ingestion-harness/staging.env` |
| Production deploy | `self-hosted, linux, deploy-production` | Runs **on** the production host; Docker access; `/etc/ingestion-harness/production.env` |

One CI runner is enough to start; add more with the same labels for parallelism (each CI
compose run uses a unique project name and ephemeral ports, so they don't collide).

## Registering a runner (Linux)

Once the GitHub repo exists: **Settings → Actions → Runners → New self-hosted runner** shows a
one-time registration token. On the host:

```bash
sudo useradd -m -s /bin/bash gh-runner && sudo usermod -aG docker gh-runner
sudo -iu gh-runner
mkdir actions-runner && cd actions-runner
# download + verify the runner tarball exactly as shown on the GitHub page, then:
./config.sh --url https://github.com/<org>/<repo> --token <TOKEN> \
  --name ci-01 --labels ingestion-ci --unattended
exit
cd /home/gh-runner/actions-runner && sudo ./svc.sh install gh-runner && sudo ./svc.sh start
```

For deploy runners use `--labels deploy-staging` (or `deploy-production`) and create the env file:

```bash
sudo mkdir -p /etc/ingestion-harness
sudo install -m 600 -o gh-runner /dev/null /etc/ingestion-harness/staging.env
sudo -e /etc/ingestion-harness/staging.env   # start from deploy/.env.example
```

## Security notes

- Keep the repo **private**; never enable workflows from forks on self-hosted runners.
- Use GitHub **Environments** (`staging`, `production`) with required reviewers on production
  (Settings → Environments). Deploy jobs reference them via `environment:`.
- Deploy secrets stay on the deploy hosts (`ENV_FILE`), not in GitHub secrets, so a CI runner
  compromise doesn't expose production credentials.
- Runners are long-lived: CI tears down its compose project and images in an `always()` step.
  Prune periodically (`docker system prune --filter until=168h`) via cron.
- Consider ephemeral runners (`./config.sh --ephemeral`) with an autoscaler if job volume grows.

## Local CI runner on a Windows dev machine (WSL2)

The workflows need a Linux runner, so on Windows run the Linux runner inside WSL2 and let it use
Docker Desktop's engine.

1. **Enable Actions** for the repo: Settings → Actions → General → "Allow all actions" (or
   allow `actions/*` and `astral-sh/setup-uv`). With Actions disabled no workflow runs at all.
2. **WSL + Docker:** `wsl --install -d Ubuntu`, then Docker Desktop → Settings → Resources →
   WSL integration → enable Ubuntu. Check from Ubuntu: `docker version` and `docker compose version`.
3. **Enable systemd** so the runner can run as a service: add `[boot]` / `systemd=true` to
   `/etc/wsl.conf` in Ubuntu, then `wsl --shutdown` from Windows and reopen Ubuntu.
4. **Register** (inside Ubuntu, as your normal user, which already has Docker Desktop's socket):
   Settings → Actions → Runners → New self-hosted runner → Linux x64, run the download/verify
   commands it shows, then
   ```bash
   ./config.sh --url https://github.com/<org>/<repo> --token <TOKEN> \
     --name "$(hostname)-wsl" --labels ingestion-ci --unattended
   sudo ./svc.sh install "$USER" && sudo ./svc.sh start
   ```
   (`self-hosted`, `linux`, `x64` labels are added automatically.)
5. **Keep WSL running:** WSL stops a distro shortly after its last terminal closes, which takes
   the runner offline. Add a Task Scheduler task at log-on that runs
   `wsl.exe -d Ubuntu --exec sleep infinity`.

The runner must be v2.327.1 or newer (the `@v7` actions run on Node 24); a freshly downloaded
runner is, and it updates itself. To also run `deploy.yml` against this machine, register with
`--labels ingestion-ci,deploy-staging` and create `/etc/ingestion-harness/staging.env` as above.

## Windows runners

The workflows assume Linux runners (bash, Docker Linux containers). The deploy scripts have
PowerShell equivalents (`deploy/scripts/*.ps1`) if a Windows deploy host is ever required; a
`windows` variant of `deploy.yml` would call `deploy.ps1 -EnvFile ...`.
