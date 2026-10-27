import { RouterContextProvider } from "react-router";
import { createHonoServer } from "react-router-hono-server/node";
import { apiContext, createApi } from "../app/api.server.ts";
import { app } from "./app.ts";
import { clearExpiredSessions, refreshUsers } from "./modules/accounts/service.ts";
import type { AppEnv } from "./platform/http.ts";
import { log } from "./platform/log.ts";
import { migrate } from "./platform/migrate.ts";
import { every } from "./platform/schedule.ts";

await migrate();
every(10 * 60_000, "Refreshing users from mousehole", refreshUsers);
every(24 * 3600_000, "Clearing expired sessions", clearExpiredSessions);

// The app's middleware runs for pages too, so they know their visitor.
export default await createHonoServer<AppEnv>({
  defaultLogger: false,
  listeningListener: ({ port }) => log("info", "Listening", { port }),
  configure(server) {
    server.route("/", app);
  },
  getLoadContext(c) {
    const context = new RouterContextProvider();
    context.set(
      apiContext,
      createApi(c.req.raw, { viewer: c.var.viewer, sessionId: c.var.sessionId }),
    );
    return context;
  },
});
