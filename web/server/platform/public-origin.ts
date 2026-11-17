import { createMiddleware } from "hono/factory";
import { env } from "./env.ts";

// TLS ends at OpenResty, so Node takes every request for http. React Router turns away a form
// post whose Origin header differs from the request's origin, so pages see the site's one
// address, PUBLIC_URL.
export const atPublicOrigin = createMiddleware(async (c, next) => {
  const url = new URL(c.req.url);
  if (url.origin !== env.PUBLIC_URL) {
    const raw = c.req.raw;
    c.req.raw = new Request(new URL(url.pathname + url.search, env.PUBLIC_URL), {
      method: raw.method,
      headers: raw.headers,
      // Page forms are small: the largest is an emblem of 16 KB.
      body: raw.body === null ? null : await raw.arrayBuffer(),
      signal: raw.signal,
    });
  }
  await next();
});
