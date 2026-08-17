import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { loadSandboxRunnerConfig } from "../services/sandbox-runner/config";

type ScrapeConfig = {
  job_name?: string;
  scheme?: string;
  metrics_path?: string;
  authorization?: { type?: string; credentials_file?: string };
  static_configs?: Array<{ targets?: string[] }>;
};

type AlertRule = {
  alert?: string;
  expr?: string;
  for?: string;
  labels?: { severity?: string };
};

async function main() {
  const [service, environment, scrapeSource, alertsSource] = await Promise.all([
    readFile("deploy/atypica-sandbox-runner.service", "utf8"),
    readFile("deploy/sandbox-runner.env.example", "utf8"),
    readFile("deploy/prometheus/sandbox-runner-scrape.yml", "utf8"),
    readFile("deploy/prometheus/sandbox-runner-alerts.yml", "utf8"),
  ]);
  const graceMs = Number(environment.match(/^SANDBOX_RUNNER_SHUTDOWN_GRACE_MS=(\d+)$/m)?.[1]);
  const stopSeconds = Number(service.match(/^TimeoutStopSec=(\d+)s$/m)?.[1]);
  assert.ok(Number.isInteger(graceMs));
  assert.ok(Number.isInteger(stopSeconds));
  assert.ok(stopSeconds * 1_000 >= graceMs + 10_000, "systemd stop timeout must include cleanup headroom");

  const config = loadSandboxRunnerConfig({
    NODE_ENV: "production",
    SANDBOX_RUNNER_AUTH_TOKEN: "execution-token-00000000000000000000",
    SANDBOX_RUNNER_METRICS_AUTH_TOKEN: "metrics-token-000000000000000000000",
    SANDBOX_JAVASCRIPT_IMAGE: "node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    SANDBOX_PYTHON_IMAGE: "python@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.notEqual(config.authToken, config.metricsAuthToken);
  assert.throws(() => loadSandboxRunnerConfig({
    NODE_ENV: "development",
    SANDBOX_RUNNER_AUTH_TOKEN: "execution-token-00000000000000000000",
    SANDBOX_RUNNER_METRICS_AUTH_TOKEN: "short",
  }), /METRICS_AUTH_TOKEN/);
  assert.throws(() => loadSandboxRunnerConfig({
    NODE_ENV: "production",
    SANDBOX_RUNNER_AUTH_TOKEN: "shared-token-0000000000000000000000",
    SANDBOX_RUNNER_METRICS_AUTH_TOKEN: "shared-token-0000000000000000000000",
    SANDBOX_JAVASCRIPT_IMAGE: "node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    SANDBOX_PYTHON_IMAGE: "python@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }), /distinct SANDBOX_RUNNER_METRICS_AUTH_TOKEN/);

  const scrape = parse(scrapeSource) as { scrape_configs?: ScrapeConfig[] };
  const scrapeConfig = scrape.scrape_configs?.find((candidate) => candidate.job_name === "atypica-sandbox-runner");
  assert.ok(scrapeConfig);
  assert.equal(scrapeConfig.scheme, "https");
  assert.equal(scrapeConfig.metrics_path, "/metrics");
  assert.deepEqual(scrapeConfig.authorization, {
    type: "Bearer",
    credentials_file: "/etc/prometheus/secrets/atypica-sandbox-runner-metrics-token",
  });
  assert.deepEqual(scrapeConfig.static_configs?.[0]?.targets, ["sandbox.example.com"]);
  assert.doesNotMatch(scrapeSource, /CHANGE_ME|SANDBOX_RUNNER_AUTH_TOKEN/);

  const alerts = parse(alertsSource) as { groups?: Array<{ name?: string; rules?: AlertRule[] }> };
  const rules = alerts.groups?.find((group) => group.name === "atypica-sandbox-runner")?.rules ?? [];
  const expectedAlerts = [
    "AtypicaSandboxRunnerDown",
    "AtypicaSandboxRunnerNotReady",
    "AtypicaSandboxReadinessProbeFailures",
    "AtypicaSandboxUnavailableRejections",
    "AtypicaSandboxSustainedCapacityRejections",
    "AtypicaSandboxHighExecutionFailureRatio",
  ];
  assert.deepEqual(rules.map((rule) => rule.alert), expectedAlerts);
  for (const rule of rules) {
    assert.ok(rule.expr && rule.for && ["warning", "critical"].includes(rule.labels?.severity ?? ""));
  }
  assert.doesNotMatch(alertsSource, /executionId|execution_id|token|file_path|source_code/);

  console.log(JSON.stringify({
    distinctCredentials: true,
    systemdCleanupHeadroomMs: stopSeconds * 1_000 - graceMs,
    prometheusHttpsBearerCredentialsFile: true,
    alertRules: expectedAlerts,
    highCardinalityLabelsRejected: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
