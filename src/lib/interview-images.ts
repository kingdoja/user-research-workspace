const MAX_INTERVIEW_IMAGE_BYTES = 5 * 1024 * 1024;

const imageTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export const INTERVIEW_IMAGE_BUCKET = "interview-question-images";

function hasBytes(bytes: Uint8Array, expected: number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function detectImageType(bytes: Uint8Array) {
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg" as const;
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png" as const;
  if (hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp" as const;
  return null;
}

export async function validateInterviewImage(file: File) {
  if (file.size === 0 || file.size > MAX_INTERVIEW_IMAGE_BYTES) {
    return { error: "图片大小必须在 5 MB 以内" } as const;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = detectImageType(bytes);
  if (!contentType || !(contentType in imageTypes)) {
    return { error: "仅支持 JPEG、PNG 或 WebP 图片" } as const;
  }
  return { bytes, contentType, extension: imageTypes[contentType] } as const;
}

export function createInterviewImagePath(projectPublicId: string, questionPublicId: string, extension: string) {
  return `${projectPublicId}/${questionPublicId}/${crypto.randomUUID()}.${extension}`;
}

export function isInterviewImagePath(projectPublicId: string, questionPublicId: string, imagePath: string) {
  return imagePath.startsWith(`${projectPublicId}/${questionPublicId}/`) && !imagePath.includes("..");
}
