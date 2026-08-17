# Sandbox Runner monitoring

This directory contains a vendor-neutral Prometheus scrape job and alert rules for the
dedicated Sandbox Runner. Replace `sandbox.example.com` with the production hostname before
installation. Keep the endpoint on HTTPS; the Runner accepts the metrics credential through
standard Bearer authorization.

Create the credentials file from `SANDBOX_RUNNER_METRICS_AUTH_TOKEN`. It must contain only the
raw token and must be readable by the Prometheus service account, not by other users:

```bash
sudo install -d -o prometheus -g prometheus -m 0700 /etc/prometheus/secrets
sudo install -o prometheus -g prometheus -m 0600 /dev/null \
  /etc/prometheus/secrets/atypica-sandbox-runner-metrics-token
printf '%s\n' "$SANDBOX_RUNNER_METRICS_AUTH_TOKEN" | sudo tee \
  /etc/prometheus/secrets/atypica-sandbox-runner-metrics-token >/dev/null
```

Add `sandbox-runner-scrape.yml` under the Prometheus `scrape_configs` list and load
`sandbox-runner-alerts.yml` through `rule_files`. Validate the resulting files before reload:

```bash
promtool check config /etc/prometheus/prometheus.yml
promtool check rules /etc/prometheus/rules/sandbox-runner-alerts.yml
```

Route `critical` alerts to the production incident channel and `warning` alerts to the owning
team. Alertmanager routing is environment-specific and is intentionally not hard-coded here.
After reload, require the target to be `UP`, query `atypica_sandbox_runner_ready == 1`, and run
the documented drain drill before declaring monitoring live.
