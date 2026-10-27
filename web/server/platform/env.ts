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
  })
  .parse(process.env);
