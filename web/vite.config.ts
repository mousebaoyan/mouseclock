import { getRequestListener } from "@hono/node-server";
import { reactRouter } from "@react-router/dev/vite";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { reactRouterHonoServer } from "react-router-hono-server/dev";
import { defineConfig, loadEnv, type Plugin } from "vite";

// Login works without the real mousehole: when MOUSEHOLE_URL points into the dev server, as in
// .env.example, the fake one answers there. Loaded once the server starts, after .env is.
const serveFakeMousehole: Plugin = {
  name: "fake-mousehole",
  async configureServer(server) {
    const { env } = await import("./server/platform/env.ts");
    if (!env.MOUSEHOLE_URL.startsWith(`${env.PUBLIC_URL}/`)) return;
    const { fakeMousehole } = await import("./test/fake-mousehole.ts");
    const listener = getRequestListener(
      fakeMousehole({
        url: env.MOUSEHOLE_URL,
        clientId: env.MOUSEHOLE_CLIENT_ID,
        clientSecret: env.MOUSEHOLE_CLIENT_SECRET,
        redirectUri: `${env.PUBLIC_URL}/login/callback`,
      }).fetch,
    );
    const base = `${new URL(env.MOUSEHOLE_URL).pathname}/`;
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith(base)) void listener(req, res);
      else next();
    });
  },
};

export default defineConfig(({ mode }) => {
  // Server code reads process.env, but Vite only loads .env into import.meta.env.
  Object.assign(process.env, loadEnv(mode, import.meta.dirname, ""));

  return {
    plugins: [
      serveFakeMousehole,
      reactRouterHonoServer({
        serverEntryPoint: "server/main.ts",
        // Pages import constants shared with the server, such as the site's name; in development
        // the browser loads them as modules, which otherwise only files under app/ may be.
        dev: { exclude: [/^\/server\/.+\.ts(\?.*)?$/] },
      }),
      tailwindcss(),
      reactRouter(),
      babel({ include: /\/app\/.+\.tsx?$/, plugins: ["babel-plugin-react-compiler"] }),
    ],
    resolve: { tsconfigPaths: true },
    // The oldest browsers we support, as mousehole does: QQ's built-in browser on older phones
    // (design §10). Vite's default starts at iOS 16.4.
    environments: {
      client: { build: { target: ["ios15.4", "safari15.4", "chrome100", "firefox128"] } },
    },
  };
});
