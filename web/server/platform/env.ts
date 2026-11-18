import { z } from "zod";

export const env = z
  .object({
    DATABASE_URL: z.url(),
    // A bare origin, e.g. http://localhost:5173, so it compares with Origin headers.
    PUBLIC_URL: z.url().transform((url) => new URL(url).origin),
    // Mousehole's site, which is also its OAuth issuer: without a trailing slash.
    MOUSEHOLE_URL: z.url().transform((url) => url.replace(/\/$/, "")),
    MOUSEHOLE_CLIENT_ID: z.string().min(1),
    MOUSEHOLE_CLIENT_SECRET: z.string().min(1),
    // The AES-256 key for the mailboxes' passwords, used as is: 32 random bytes in base64.
    APP_SECRET: z
      .base64()
      .transform((s) => Buffer.from(s, "base64"))
      .refine((key) => key.length === 32, "应为 32 字节的 base64，用 openssl rand -base64 32 生成"),
  })
  .parse(process.env);
