import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  createConfiguredSourceRawStorage,
  createSourceRawObjectKey,
  type SourceRawStorageLocator,
} from "../src/lib/source-raw-storage";

loadEnvConfig(process.cwd());

if (process.env.SOURCE_OBJECT_STORAGE_SMOKE_CONFIRM !== "1") {
  throw new Error("Set SOURCE_OBJECT_STORAGE_SMOKE_CONFIRM=1 to run the local object-storage smoke test.");
}
const endpoint = new URL(process.env.SOURCE_OBJECT_STORAGE_ENDPOINT ?? "");
if (!["localhost", "127.0.0.1"].includes(endpoint.hostname)) {
  throw new Error("Object-storage smoke test only runs against a local S3-compatible endpoint.");
}
const bucket = process.env.SOURCE_OBJECT_STORAGE_BUCKET?.trim();
if (!bucket) throw new Error("SOURCE_OBJECT_STORAGE_BUCKET is required");

const client = new S3Client({
  endpoint: endpoint.toString(),
  region: process.env.SOURCE_OBJECT_STORAGE_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.SOURCE_OBJECT_STORAGE_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.SOURCE_OBJECT_STORAGE_SECRET_ACCESS_KEY || "",
  },
});

async function main() {
  let createdBucket = false;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    createdBucket = true;
  }
  const storage = createConfiguredSourceRawStorage();
  assert(storage);
  const body = "Large immutable source body. ".repeat(4_000);
  const contentHash = createHash("sha256").update(body).digest("hex");
  const key = createSourceRawObjectKey(randomUUID(), contentHash);
  let locator: SourceRawStorageLocator | undefined;
  try {
    const first = await storage.putImmutable({ key, body, contentType: "text/plain; charset=utf-8", contentHash });
    locator = first;
    const second = await storage.putImmutable({ key, body, contentType: "text/plain; charset=utf-8", contentHash });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(await storage.get(first), body);
    console.log(JSON.stringify({
      provider: first.provider,
      byteLength: first.byteLength,
      immutableCreate: true,
      duplicateReused: true,
      integrityReadback: true,
    }, null, 2));
  } finally {
    if (locator) await storage.delete(locator);
    if (createdBucket) await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
