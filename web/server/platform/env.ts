import { z } from "zod";

export const env = z.object({ DATABASE_URL: z.url() }).parse(process.env);
