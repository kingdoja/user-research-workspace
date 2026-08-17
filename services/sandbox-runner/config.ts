import { z } from "zod";

const runtimeNameSchema = z.enum(["docker", "podman"]);
const imageSchema = z.string().trim().min(1).max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]+$/, "Runtime image contains invalid characters");
const networkSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

export type SandboxRunnerConfig = {
  host: string;
  port: number;
  authToken: string;
  metricsAuthToken: string;
  maxConcurrency: number;
  maxRequestBytes: number;
  containerRuntime: "docker" | "podman";
  javascriptImage: string;
  pythonImage: string;
  egressNetwork: string | null;
  cpuLimit: number;
  pidsLimit: number;
  tmpfsMb: number;
  shutdownGraceMs: number;
  readinessProbeIntervalMs: number;
  readinessProbeTimeoutMs: number;
};

function integerFromEnv(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function numberFromEnv(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected a number between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function loadSandboxRunnerConfig(environment: NodeJS.ProcessEnv = process.env): SandboxRunnerConfig {
  const production = environment.NODE_ENV === "production";
  const authToken = environment.SANDBOX_RUNNER_AUTH_TOKEN ?? "";
  if (authToken.length < 24) {
    throw new Error("SANDBOX_RUNNER_AUTH_TOKEN must contain at least 24 characters");
  }
  const metricsAuthToken = environment.SANDBOX_RUNNER_METRICS_AUTH_TOKEN ?? authToken;
  if (metricsAuthToken.length < 24) {
    throw new Error("SANDBOX_RUNNER_METRICS_AUTH_TOKEN must contain at least 24 characters");
  }
  if (production && (!environment.SANDBOX_RUNNER_METRICS_AUTH_TOKEN || metricsAuthToken === authToken)) {
    throw new Error("Production requires a distinct SANDBOX_RUNNER_METRICS_AUTH_TOKEN");
  }
  const javascriptImage = imageSchema.parse(environment.SANDBOX_JAVASCRIPT_IMAGE ?? "node:24-alpine");
  const pythonImage = imageSchema.parse(environment.SANDBOX_PYTHON_IMAGE ?? "python:3.13-alpine");
  const requireDigest = environment.SANDBOX_RUNNER_REQUIRE_IMAGE_DIGEST === "1" || production;
  if (requireDigest && (![javascriptImage, pythonImage].every((image) => image.includes("@sha256:")))) {
    throw new Error("Production sandbox images must be pinned by sha256 digest");
  }
  const egressNetworkValue = environment.SANDBOX_RUNNER_EGRESS_NETWORK?.trim();
  return {
    host: environment.SANDBOX_RUNNER_HOST?.trim() || "127.0.0.1",
    port: integerFromEnv(environment.SANDBOX_RUNNER_PORT, 8787, 1, 65_535),
    authToken,
    metricsAuthToken,
    maxConcurrency: integerFromEnv(environment.SANDBOX_RUNNER_MAX_CONCURRENCY, 4, 1, 64),
    maxRequestBytes: integerFromEnv(environment.SANDBOX_RUNNER_MAX_REQUEST_BYTES, 524_288, 262_144, 2_097_152),
    containerRuntime: runtimeNameSchema.parse(environment.SANDBOX_CONTAINER_RUNTIME ?? "docker"),
    javascriptImage,
    pythonImage,
    egressNetwork: egressNetworkValue ? networkSchema.parse(egressNetworkValue) : null,
    cpuLimit: numberFromEnv(environment.SANDBOX_RUNNER_CPU_LIMIT, 1, 0.1, 4),
    pidsLimit: integerFromEnv(environment.SANDBOX_RUNNER_PIDS_LIMIT, 64, 16, 256),
    tmpfsMb: integerFromEnv(environment.SANDBOX_RUNNER_TMPFS_MB, 16, 4, 64),
    shutdownGraceMs: integerFromEnv(environment.SANDBOX_RUNNER_SHUTDOWN_GRACE_MS, 125_000, 1_000, 300_000),
    readinessProbeIntervalMs: integerFromEnv(environment.SANDBOX_RUNNER_READINESS_PROBE_INTERVAL_MS, 30_000, 1_000, 300_000),
    readinessProbeTimeoutMs: integerFromEnv(environment.SANDBOX_RUNNER_READINESS_PROBE_TIMEOUT_MS, 5_000, 500, 30_000),
  };
}
