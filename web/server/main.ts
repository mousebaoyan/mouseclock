import { RouterContextProvider } from "react-router";
import { createMiddleware } from "hono/factory";
import { createHonoServer } from "react-router-hono-server/node";
import { apiContext, createApi } from "../app/api.server.ts";
import { app } from "./app.ts";
import { clearExpiredSessions, refreshUsers } from "./modules/accounts/service.ts";
import { sendEmails } from "./modules/reminders/email.ts";
import { sendDeadlineMessages } from "./modules/reminders/subscriptions.ts";
import { compressResponses } from "./platform/compress.ts";
import type { AppEnv } from "./platform/http.ts";
import { log } from "./platform/log.ts";
import { migrate } from "./platform/migrate.ts";
import { atPublicOrigin } from "./platform/public-origin.ts";
import { every } from "./platform/schedule.ts";

await migrate();
every(10 * 60_000, "Refreshing users from mousehole", refreshUsers);
every(24 * 3600_000, "Clearing expired sessions", clearExpiredSessions);
every(60_000, "Sending deadline messages", sendDeadlineMessages);
every(60_000, "Sending emails", sendEmails);

// Built files carry a hash of their content in their names, so a browser keeps them without asking
// again, even on a reload. Each comes plain or compressed by what the browser takes, which a cache
// on the way must be told for the plain ones too.
const keepForever = createMiddleware(async (c, next) => {
  await next();
  if (!c.res.ok) return;
  c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
  if (!c.res.headers.has("vary")) c.res.headers.set("vary", "accept-encoding");
});

// The app's middleware runs for pages too, so they know their visitor.
export default await createHonoServer<AppEnv>({
  defaultLogger: false,
  listeningListener: ({ port }) => log("info", "Listening", { port }),
  beforeAll(server) {
    server.use("/assets/*", keepForever);
  },
  // Built files have Brotli and gzip copies beside them; see scripts/compress-assets.ts.
  serveStaticOptions: {
    clientAssets: { precompressed: true },
    publicAssets: { precompressed: true },
  },
  configure(server) {
    server.use(compressResponses);
    server.route("/", app);
    // Only the pages, which React Router serves after these routes.
    server.use(atPublicOrigin);
  },
  getLoadContext(c) {
    const context = new RouterContextProvider();
    context.set(
      apiContext,
      createApi(c.req.raw, {
        viewer: c.var.viewer,
        sessionId: c.var.sessionId,
        token: c.var.token,
      }),
    );
    return context;
  },
});
