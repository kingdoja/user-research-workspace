# atypica Sandbox Runner

This service implements `atypica.sandbox/v1` outside the Next.js process. It never
executes uploaded code on the host. Every request is written to a temporary read-only
workspace and executed in a new Docker or rootless Podman container.

## Runtime contract

- JavaScript entrypoints export `default(input)` or `main(input)`.
- Python entrypoints export `main(input)`.
- The return value must be JSON serializable.
- Source bundles cannot include `package.json` or `.atypica/*`; these paths are reserved.
- Runtime images are intentionally dependency-free. Skills cannot install packages at run time.

## Isolation controls

- non-root UID `65532`, read-only root filesystem and read-only source mount;
- all Linux capabilities dropped and `no-new-privileges` enabled;
- memory, CPU, PID, file descriptor, timeout and response-size limits;
- fresh `/tmp` tmpfs and forced container removal after every outcome;
- `--network none` by default;
- no application environment variables, tokens or database credentials enter the container.

Network-enabled Skills are rejected unless `SANDBOX_RUNNER_EGRESS_NETWORK` names an
operator-controlled container network. That network must enforce outbound policy outside
this service. Do not point it at a general application or database network.

## Local run

Pre-pull the two configured runtime images, then start the service:

```bash
SANDBOX_RUNNER_AUTH_TOKEN='replace-with-at-least-24-characters' pnpm sandbox:runner
```

## Operations contract

- `GET /live` returns `200` while the HTTP process is alive.
- `GET /ready` verifies the container engine and both pre-pulled images; it returns `503`
  while the runtime is unavailable or the process is draining.
- `GET /health` is a backward-compatible alias of `/ready`.
- `GET /metrics` emits Prometheus text and requires the metrics token through standard Bearer
  authorization or `x-sandbox-token`. Production requires `SANDBOX_RUNNER_METRICS_AUTH_TOKEN`
  to differ from execution access; local development falls back to the execution token when
  it is omitted. Labels are restricted to
  language, bounded error code and rejection reason; inputs, source, file paths, tokens and
  execution IDs are never metric labels.
- `POST /execute` returns `503 runner_unavailable` when runtime readiness is down,
  `503 runner_draining` after shutdown begins, or `429 runner_busy` at the concurrency limit.

Readiness is checked at startup and periodically. `SIGTERM` or `SIGINT` changes admission to
draining and lets active executions finish. At `SANDBOX_RUNNER_SHUTDOWN_GRACE_MS`, remaining
execution controllers are aborted, their containers are force-removed, and the service exits
non-zero so an unexpected forced drain is visible to the service manager. Keep systemd
`TimeoutStopSec` at least 10 seconds above the Runner grace period.

Production deployments must terminate HTTPS in front of the Runner, pin both images by
digest, and keep the service on a dedicated worker host. Rootless Podman or a hardened
container runtime such as gVisor is preferred. Mounting a rootful Docker socket into an
internet-facing container is not an acceptable deployment.

## Production deployment

Use a dedicated Linux account and host. The checked-in deployment unit is a systemd user
service, so the Runner and Podman both remain rootless:

```bash
# Run as root once. Choose UID ranges that are free on this host.
useradd --create-home --shell /bin/bash atypica-sandbox
usermod --add-subuids 100000-165535 --add-subgids 100000-165535 atypica-sandbox
loginctl enable-linger atypica-sandbox

# Then run as atypica-sandbox from a reviewed checkout at ~/atypica.
corepack enable
pnpm install --frozen-lockfile
mkdir -p ~/.config/atypica ~/.config/systemd/user
install -m 0600 deploy/sandbox-runner.env.example ~/.config/atypica/sandbox-runner.env
install -m 0644 deploy/atypica-sandbox-runner.service ~/.config/systemd/user/
```

Replace the token in the installed environment file with at least 32 random bytes. The
metrics token must be a different value with the same entropy. The example pins the images
that passed repository QA. Pull those exact references before the service starts, then confirm
rootless execution:

```bash
source ~/.config/atypica/sandbox-runner.env
podman pull "$SANDBOX_JAVASCRIPT_IMAGE"
podman pull "$SANDBOX_PYTHON_IMAGE"
podman info --format '{{.Host.Security.Rootless}}'
systemctl --user daemon-reload
systemctl --user enable --now atypica-sandbox-runner.service
curl --fail http://127.0.0.1:8787/live
curl --fail http://127.0.0.1:8787/ready
curl --fail -H "Authorization: Bearer $SANDBOX_RUNNER_METRICS_AUTH_TOKEN" http://127.0.0.1:8787/metrics
```

After the unit is active, verify host-specific invariants from the dedicated Runner account:

```bash
pnpm verify:sandbox-worker
```

This command intentionally fails outside Linux or when the environment file is not private,
Podman is not rootless, an image is missing, the systemd user unit is inactive, credentials are
shared/placeholders, or local liveness/readiness/metrics fail. It never prints either token.

Install `deploy/Caddyfile.sandbox.example` on the same worker, replace the hostname, and
expose only ports 80/443. Keep `127.0.0.1:8787` private. Caddy manages TLS and proxies to the
Runner; the token is still checked by the Runner using a timing-safe comparison.

The platform-side Skill should use:

```json
{
  "endpoint": "https://sandbox.example.com/execute",
  "headersFromEnv": {
    "x-sandbox-token": "SKILL_SECRET_SANDBOX_RUNNER_TOKEN"
  }
}
```

Set `SKILL_EXECUTOR_ALLOWED_ORIGINS=https://sandbox.example.com` in the Next.js service.
Set `SKILL_SECRET_SANDBOX_RUNNER_TOKEN` there to exactly the Runner token. Do not add any
Runner-only `SANDBOX_*` variables to the web service.

After TLS is live, run the deployment gate from a trusted operator machine:

```bash
SANDBOX_VERIFY_URL=https://sandbox.example.com \
SANDBOX_VERIFY_TOKEN="$SKILL_SECRET_SANDBOX_RUNNER_TOKEN" \
SANDBOX_VERIFY_METRICS_TOKEN="$SANDBOX_RUNNER_METRICS_AUTH_TOKEN" \
pnpm verify:sandbox-deployment
```

The gate checks liveness, runtime/image readiness, authenticated metrics, digest pinning,
bad-token rejection, JavaScript and Python execution, non-root/read-only/default-deny
isolation, timeout and output limits. On the worker, add
`SANDBOX_VERIFY_CONTAINER_RUNTIME=podman` to also prove no execution containers remain.
Install the Prometheus scrape and alert files from `deploy/prometheus/`, validate them with
`promtool`, and route their `critical` and `warning` severities in the environment's existing
Alertmanager. Do not place either token directly in Prometheus YAML.

## Release, fault drill and rollback

Before a release, pull the new image digests, start the unit, require `/ready` to return `200`,
and run `verify:sandbox-deployment`. Do not update the platform Skill endpoint or grants unless
the contract changed. Watch these conditions during rollout:

- `/ready` non-200 for two probe intervals;
- `atypica_sandbox_runner_readiness_probe_failures_total` increasing;
- busy/draining/unavailable rejection counters increasing unexpectedly;
- failed execution rate or duration rising against the previous deployment;
- `sandbox_runner_drain_deadline` or a non-zero service exit.

Run a drain drill on the worker with one bounded test execution in flight, then execute
`systemctl --user restart atypica-sandbox-runner.service`. Confirm the request either completes
within the grace window or returns `SANDBOX_SHUTDOWN`, the journal records `drained` or `forced`,
`podman ps -aq --filter label=ai.atypica.sandbox=true` is empty, and `/ready` recovers after the
restart. `pnpm smoke:sandbox-runner` performs the same normal and forced-drain checks locally.

Roll back by restoring the last reviewed checkout and environment file, ensuring the previous
digests are present, restarting the user unit, waiting for `/ready`, and rerunning the remote
gate. If readiness stays down, keep the Runner out of traffic and inspect `journalctl --user -u
atypica-sandbox-runner.service`; do not bypass readiness or enable host execution. Rotate the
execution token in the Runner and Next.js secret stores in one maintenance window because
overlapping values are not accepted. Rotate the independent metrics token in the Runner and
Prometheus credentials file together.
