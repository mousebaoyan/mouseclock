import { createHash, randomBytes } from "node:crypto";

// Sessions and crawler tokens: random enough that the database only needs their SHA-256.
export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest();
}
