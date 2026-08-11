import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;

  return {
    hash: derivedKey.toString("hex"),
    salt,
  };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const expected = Buffer.from(expectedHash, "hex");

  return expected.length === derivedKey.length && timingSafeEqual(expected, derivedKey);
}
