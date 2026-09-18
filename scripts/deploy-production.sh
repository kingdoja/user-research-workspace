#!/usr/bin/env bash
set -euo pipefail

# Deploy one already-built image to the production Web and Worker containers.
# Secrets stay on the server in env files and are never passed as CLI arguments.
# Example:
#   DEPLOY_HOST=121.40.126.48 \
#   DEPLOY_IMAGE=cognara-ai:20260918-provider-yundu \
#   ./scripts/deploy-production.sh

: "${DEPLOY_HOST:?Set DEPLOY_HOST to the production host}"
: "${DEPLOY_IMAGE:?Set DEPLOY_IMAGE to an explicit, immutable image tag}"

deploy_user="${DEPLOY_USER:-root}"
deploy_port="${DEPLOY_PORT:-22}"
web_container="${DEPLOY_WEB_CONTAINER:-atypica-web}"
worker_container="${DEPLOY_WORKER_CONTAINER:-atypica-worker}"
network_name="${DEPLOY_NETWORK:-atypica-net}"
web_port="${DEPLOY_WEB_PORT:-80}"
health_base_url="${DEPLOY_HEALTH_BASE_URL:-http://127.0.0.1}"
web_env_file="${DEPLOY_WEB_ENV_FILE:-/root/cognara-web.env}"
worker_env_file="${DEPLOY_WORKER_ENV_FILE:-/root/cognara-worker.env}"

if [[ "$DEPLOY_IMAGE" != *:* || "$DEPLOY_IMAGE" =~ [[:space:]] ]]; then
  echo "DEPLOY_IMAGE must include an explicit non-whitespace tag (for example cognara-ai:20260918-provider-yundu)" >&2
  exit 2
fi

ssh_args=(-o BatchMode=yes -o ConnectTimeout=15 -p "$deploy_port")
remote=(ssh "${ssh_args[@]}" "${deploy_user}@${DEPLOY_HOST}")

"${remote[@]}" bash -s -- \
  "$DEPLOY_IMAGE" \
  "$web_container" \
  "$worker_container" \
  "$network_name" \
  "$web_port" \
  "$health_base_url" \
  "$web_env_file" \
  "$worker_env_file" <<'REMOTE'
set -euo pipefail

image="$1"
web_container="$2"
worker_container="$3"
network_name="$4"
web_port="$5"
health_base_url="${6%/}"
web_env_file="$7"
worker_env_file="$8"

for required in "$web_env_file" "$worker_env_file"; do
  if [[ ! -s "$required" ]]; then
    echo "Missing production env file: $required" >&2
    exit 1
  fi
  if [[ "$(stat -c '%a' "$required")" != "600" ]]; then
    echo "Production env file must have mode 600: $required" >&2
    exit 1
  fi
done

docker image inspect "$image" >/dev/null
docker network inspect "$network_name" >/dev/null
docker inspect "$web_container" >/dev/null
docker inspect "$worker_container" >/dev/null

old_web_image="$(docker inspect -f '{{.Config.Image}}' "$web_container")"
old_worker_image="$(docker inspect -f '{{.Config.Image}}' "$worker_container")"
web_repo="${image%%:*}"
timestamp="$(date +%Y%m%d%H%M%S)"
web_rollback="${web_repo}:rollback-web-${timestamp}"
worker_rollback="${web_repo}:rollback-worker-${timestamp}"

docker tag "$old_web_image" "$web_rollback"
docker tag "$old_worker_image" "$worker_rollback"

rollback_done=0
rollback() {
  [[ "$rollback_done" == 1 ]] && return 0
  echo "Deployment failed; restoring rollback images" >&2
  set +e
  docker rm -f "$web_container" "$worker_container" >/dev/null 2>&1 || true
  docker run -d --name "$worker_container" --restart unless-stopped \
    --network "$network_name" --env-file "$worker_env_file" "$worker_rollback" \
    node node_modules/tsx/dist/cli.mjs scripts/research-worker.mjs >/dev/null
  docker run -d --name "$web_container" --restart unless-stopped \
    --network "$network_name" -p "${web_port}:3000" \
    --env-file "$web_env_file" "$web_rollback" \
    node node_modules/next/dist/bin/next start >/dev/null
  for endpoint in /api/health /api/health/ready; do
    curl --fail --silent --show-error --max-time 10 "${health_base_url}${endpoint}" >/dev/null || true
  done
  set -e
}
on_exit() {
  local exit_code=$?
  if [[ "$rollback_done" != 1 ]]; then
    rollback
  fi
  trap - EXIT
  exit "$exit_code"
}
trap on_exit EXIT

# Replace the background worker first so new web requests never enqueue work
# that the old worker cannot understand.
docker rm -f "$worker_container" >/dev/null
docker run -d --name "$worker_container" --restart unless-stopped \
  --network "$network_name" --env-file "$worker_env_file" "$image" \
  node node_modules/tsx/dist/cli.mjs scripts/research-worker.mjs >/dev/null

sleep 2
[[ "$(docker inspect -f '{{.State.Running}}' "$worker_container")" == "true" ]]

docker rm -f "$web_container" >/dev/null
docker run -d --name "$web_container" --restart unless-stopped \
  --network "$network_name" -p "${web_port}:3000" \
  --env-file "$web_env_file" "$image" \
  node node_modules/next/dist/bin/next start >/dev/null

for endpoint in /api/health /api/health/ready; do
  for attempt in {1..18}; do
    if curl --fail --silent --show-error --max-time 10 "${health_base_url}${endpoint}" >/dev/null; then
      break
    fi
    [[ "$attempt" == 18 ]] && { echo "Health check failed: ${health_base_url}${endpoint}" >&2; exit 1; }
    sleep 2
  done
done

rollback_done=1
trap - EXIT
echo "DEPLOY_OK image=$image webRollback=$web_rollback workerRollback=$worker_rollback"
REMOTE
