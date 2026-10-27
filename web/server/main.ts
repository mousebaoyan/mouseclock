import { createHonoServer } from "react-router-hono-server/node";
import { app } from "./app.ts";
import { log } from "./platform/log.ts";
import { migrate } from "./platform/migrate.ts";

await migrate();

export default await createHonoServer({
  defaultLogger: false,
  listeningListener: ({ port }) => log("info", "Listening", { port }),
  configure(server) {
    server.route("/", app);
  },
});
