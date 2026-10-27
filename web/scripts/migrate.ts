import { db } from "../server/platform/db.ts";
import { migrate } from "../server/platform/migrate.ts";

await migrate();
await db.destroy();
