import { createHonoServer } from "react-router-hono-server/node";
import { app } from "./app.ts";
import { clearExpiredSessions, refreshUsers } from "./modules/accounts/service.ts";
import { log } from "./platform/log.ts";
import { migrate } from "./platform/migrate.ts";
import { every } from "./platform/schedule.ts";

await migrate();
every(10 * 60_000, "Refreshing users from mousehole", refreshUsers);
every(24 * 3600_000, "Clearing expired sessions", clearExpiredSessions);

export default await createHonoServer({
  defaultLogger: false,
  listeningListener: ({ port }) => log("info", "Listening", { port }),
  configure(server) {
    server.route("/", app);
  },
});
