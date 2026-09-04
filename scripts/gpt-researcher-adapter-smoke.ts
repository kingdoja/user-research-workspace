import assert from "node:assert/strict";
import { createServer } from "node:http";

async function main() {
  let cancelled = false;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/research/runs") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ run_id: "idle-smoke", events_url: "/v1/research/runs/idle-smoke/events" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/research/runs/idle-smoke/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      return;
    }
    if (request.method === "DELETE" && request.url === "/v1/research/runs/idle-smoke") {
      cancelled = true;
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SMOKE_SERVER_ADDRESS_MISSING");
    process.env.RESEARCH_ENGINE = "gpt-researcher";
    process.env.GPT_RESEARCHER_URL = `http://127.0.0.1:${address.port}`;
    process.env.GPT_RESEARCHER_BRIDGE_TOKEN = "smoke-token";
    process.env.GPT_RESEARCHER_BRIDGE_RUN_TIMEOUT_SECONDS = "30";
    process.env.GPT_RESEARCHER_IDLE_TIMEOUT_SECONDS = "15";

    const { runGptResearcher } = await import("../src/lib/gpt-researcher-adapter");
    await assert.rejects(runGptResearcher({
      brief: "Verify bridge idle cancellation",
      framework: "smoke",
      userPublicId: "usr_smoke",
      studyPublicId: "std_smoke",
    }), /GPT_RESEARCHER_IDLE_TIMEOUT/u);

    const cancellationDeadline = Date.now() + 1_000;
    while (!cancelled && Date.now() < cancellationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cancelled, true, "idle timeout must cancel the external bridge run");
    console.log(JSON.stringify({ idleTimeoutSeconds: 15, externalRunCancelled: true }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
