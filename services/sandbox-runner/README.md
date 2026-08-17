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
example pins the images that passed repository QA. Pull those exact references before the
service starts, then confirm rootless execution:

```bash
source ~/.config/atypica/sandbox-runner.env
podman pull "$SANDBOX_JAVASCRIPT_IMAGE"
podman pull "$SANDBOX_PYTHON_IMAGE"
podman info --format '{{.Host.Security.Rootless}}'
systemctl --user daemon-reload
systemctl --user enable --now atypica-sandbox-runner.service
curl --fail http://127.0.0.1:8787/health
```

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
pnpm verify:sandbox-deployment
```

The gate checks health, digest pinning, bad-token rejection, JavaScript and Python execution,
non-root/read-only/default-deny isolation, timeout and output limits. On the worker, add
`SANDBOX_VERIFY_CONTAINER_RUNTIME=podman` to also prove no execution containers remain.

Deploy image changes by digest, run the gate, then update the Skill version endpoint/grants
only if its contract changed. Roll back by restoring the previous environment file and
checkout, restarting the user unit, and rerunning the same gate. Rotate the shared token in
the Runner and Next.js secret stores in one maintenance window; overlapping tokens are not
accepted by design.
