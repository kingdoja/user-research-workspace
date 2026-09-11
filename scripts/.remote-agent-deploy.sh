#!/usr/bin/env bash
set -euo pipefail

timestamp="$(date +%Y%m%d%H%M%S)"
web_image="cognara-ai:20260902-agent-delete-origin"
worker_image="atypica-rebuild:20260902-universal-search-worker-final"
web_rollback="cognara-ai:rollback-before-agent-fix-${timestamp}"
worker_rollback="atypica-rebuild:rollback-before-agent-fix-${timestamp}"

docker tag "$web_image" "$web_rollback"
docker tag "$worker_image" "$worker_rollback"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' atypica-web > /tmp/atypica-web.env
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' atypica-worker > /tmp/atypica-worker.env

docker rm -f agent-web-build >/dev/null 2>&1 || true
docker create --name agent-web-build --network atypica-net "$web_image" >/dev/null
docker cp /tmp/cognara-agent-fix.tgz agent-web-build:/tmp/cognara-agent-fix.tgz
docker start agent-web-build >/dev/null
docker exec agent-web-build sh -lc 'tar -xzf /tmp/cognara-agent-fix.tgz -C /app && node_modules/.bin/next build --webpack'
docker commit agent-web-build cognara-ai:20260911-agent-fix >/dev/null
docker rm -f agent-web-build >/dev/null

docker rm -f agent-worker-build >/dev/null 2>&1 || true
docker create --name agent-worker-build --network atypica-net "$worker_image" >/dev/null
docker cp /tmp/cognara-agent-fix.tgz agent-worker-build:/tmp/cognara-agent-fix.tgz
docker start agent-worker-build >/dev/null
docker exec agent-worker-build sh -lc 'tar -xzf /tmp/cognara-agent-fix.tgz -C /app'
docker commit agent-worker-build atypica-rebuild:20260911-agent-fix >/dev/null
docker rm -f agent-worker-build >/dev/null

docker stop atypica-web >/dev/null
docker rm atypica-web >/dev/null
docker run -d --name atypica-web --restart unless-stopped --network atypica-net -p 80:3000 --env-file /tmp/atypica-web.env cognara-ai:20260911-agent-fix >/dev/null

docker stop atypica-worker >/dev/null
docker rm atypica-worker >/dev/null
docker run -d --name atypica-worker --restart unless-stopped --network atypica-net --env-file /tmp/atypica-worker.env atypica-rebuild:20260911-agent-fix >/dev/null

rm -f /tmp/cognara-agent-fix.tgz /tmp/atypica-web.env /tmp/atypica-worker.env
echo "DEPLOY_OK timestamp=${timestamp} webRollback=${web_rollback} workerRollback=${worker_rollback}"
