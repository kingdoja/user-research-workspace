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

## Run

Pre-pull the two configured runtime images, then start the service:

```bash
SANDBOX_RUNNER_AUTH_TOKEN='replace-with-at-least-24-characters' pnpm sandbox:runner
```

Production deployments must terminate HTTPS in front of the Runner, pin both images by
digest, and keep the service on a dedicated worker host. Rootless Podman or a hardened
container runtime such as gVisor is preferred. Mounting a rootful Docker socket into an
internet-facing container is not an acceptable deployment.

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
