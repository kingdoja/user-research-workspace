import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const DEFAULT_SOURCE_RAW_INLINE_LIMIT_BYTES = 64 * 1024;

export type SourceRawStorageLocator = {
  provider: "s3";
  bucket: string;
  key: string;
  versionId: string | null;
  etag: string | null;
  byteLength: number;
};

export type SourceRawStorageWrite = SourceRawStorageLocator & {
  created: boolean;
};

export type SourceRawStorage = {
  healthCheck(): Promise<void>;
  putImmutable(input: {
    key: string;
    body: string;
    contentType: string;
    contentHash: string;
  }): Promise<SourceRawStorageWrite>;
  get(locator: SourceRawStorageLocator): Promise<string>;
  delete(locator: SourceRawStorageLocator): Promise<void>;
};

function optionalCredentials() {
  const accessKeyId = process.env.SOURCE_OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.SOURCE_OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId && !secretAccessKey) return undefined;
  if (!accessKeyId || !secretAccessKey) throw new Error("SOURCE_OBJECT_STORAGE_CREDENTIALS_INCOMPLETE");
  return { accessKeyId, secretAccessKey };
}

function booleanEnvironment(value: string | undefined, fallback: boolean) {
  if (value == null || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

export function getSourceRawInlineLimitBytes() {
  const configured = Number(process.env.SOURCE_RAW_INLINE_LIMIT_BYTES ?? DEFAULT_SOURCE_RAW_INLINE_LIMIT_BYTES);
  if (!Number.isFinite(configured)) return DEFAULT_SOURCE_RAW_INLINE_LIMIT_BYTES;
  return Math.max(0, Math.min(Math.floor(configured), 512 * 1024));
}

export function createSourceRawObjectKey(workspaceId: string, contentHash: string) {
  const safeWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("SOURCE_CONTENT_HASH_INVALID");
  return `source-snapshots/v1/${safeWorkspaceId}/${contentHash}.raw`;
}

export function getSourceRawStorageStatus() {
  return {
    configured: Boolean(process.env.SOURCE_OBJECT_STORAGE_BUCKET?.trim()),
    provider: "s3",
    inlineLimitBytes: getSourceRawInlineLimitBytes(),
  } as const;
}

export async function assertConfiguredSourceRawStorageReady() {
  const storage = createConfiguredSourceRawStorage();
  if (!storage) return { configured: false as const };
  await storage.healthCheck();
  return { configured: true as const };
}

export function createConfiguredSourceRawStorage(): SourceRawStorage | null {
  const bucket = process.env.SOURCE_OBJECT_STORAGE_BUCKET?.trim();
  if (!bucket) return null;
  const endpoint = process.env.SOURCE_OBJECT_STORAGE_ENDPOINT?.trim();
  const client = new S3Client({
    region: process.env.SOURCE_OBJECT_STORAGE_REGION?.trim() || "us-east-1",
    endpoint: endpoint || undefined,
    forcePathStyle: booleanEnvironment(process.env.SOURCE_OBJECT_STORAGE_FORCE_PATH_STYLE, Boolean(endpoint)),
    credentials: optionalCredentials(),
    maxAttempts: 4,
  });

  return {
    async healthCheck() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        const wrapped = new Error("SOURCE_OBJECT_STORAGE_UNAVAILABLE", { cause: error });
        wrapped.name = "SourceObjectStorageUnavailableError";
        throw wrapped;
      }
    },
    async putImmutable(input) {
      const body = Buffer.from(input.body, "utf8");
      const byteLength = body.byteLength;
      let existing;
      try {
        existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: input.key }));
      } catch (error) {
        const statusCode = typeof error === "object" && error && "$metadata" in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
          : undefined;
        if (statusCode !== 404) {
          const wrapped = new Error("SOURCE_OBJECT_STORAGE_UNAVAILABLE", { cause: error });
          wrapped.name = "SourceObjectStorageUnavailableError";
          throw wrapped;
        }
      }
      if (existing) {
        if (existing.Metadata?.sha256 !== input.contentHash || existing.ContentLength !== byteLength) {
          throw new Error("SOURCE_OBJECT_STORAGE_INTEGRITY_MISMATCH");
        }
        return {
          provider: "s3",
          bucket,
          key: input.key,
          versionId: existing.VersionId ?? null,
          etag: existing.ETag ?? null,
          byteLength,
          created: false,
        };
      }
      let result;
      try {
        result = await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: input.key,
          Body: body,
          ContentType: input.contentType,
          Metadata: { sha256: input.contentHash },
        }));
      } catch (error) {
        const wrapped = new Error("SOURCE_OBJECT_STORAGE_UNAVAILABLE", { cause: error });
        wrapped.name = "SourceObjectStorageUnavailableError";
        throw wrapped;
      }
      return {
        provider: "s3",
        bucket,
        key: input.key,
        versionId: result.VersionId ?? null,
        etag: result.ETag ?? null,
        byteLength,
        created: true,
      };
    },
    async get(locator) {
      let result;
      try {
        result = await client.send(new GetObjectCommand({
          Bucket: locator.bucket,
          Key: locator.key,
          VersionId: locator.versionId ?? undefined,
        }));
      } catch (error) {
        const wrapped = new Error("SOURCE_OBJECT_STORAGE_UNAVAILABLE", { cause: error });
        wrapped.name = "SourceObjectStorageUnavailableError";
        throw wrapped;
      }
      if (!result.Body) throw new Error("SOURCE_OBJECT_STORAGE_BODY_MISSING");
      return result.Body.transformToString("utf8");
    },
    async delete(locator) {
      try {
        await client.send(new DeleteObjectCommand({
          Bucket: locator.bucket,
          Key: locator.key,
          VersionId: locator.versionId ?? undefined,
        }));
      } catch (error) {
        const wrapped = new Error("SOURCE_OBJECT_STORAGE_UNAVAILABLE", { cause: error });
        wrapped.name = "SourceObjectStorageUnavailableError";
        throw wrapped;
      }
    },
  };
}
