import type { Context } from "hono";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from "hono/compress";
import { createMiddleware } from "hono/factory";
import { pipeline, Readable } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";

// What the browser takes: Brotli where it can, else gzip, else neither.
function acceptedEncoding(c: Context) {
  const accepted = c.req.header("accept-encoding") ?? "";
  return /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : null;
}

// Pages and API responses, compressed here because the reverse proxy doesn't, as for mousehole
// on the same server (design §14): Brotli for browsers that take it, else gzip. Brotli at quality
// 5 with a 256KB window is quick and small enough to run on every response; static files are
// compressed harder at build time (scripts/compress-assets.ts).
export const compressResponses = createMiddleware(async (c, next) => {
  await next();
  const type = c.res.headers.get("content-type");
  if (
    !c.res.body ||
    c.res.headers.has("content-encoding") ||
    type === null ||
    !COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type)
  ) {
    return;
  }
  c.res.headers.append("vary", "accept-encoding");
  const encoding = acceptedEncoding(c);
  if (encoding === null) return;
  const compressor =
    encoding === "br"
      ? createBrotliCompress({
          params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_LGWIN]: 18 },
        })
      : createGzip();
  // A failure on either side destroys both, and the response ends with it.
  const compressed = pipeline(Readable.from(c.res.body), compressor, () => {});
  const chunks: AsyncIterator<Buffer, undefined> = compressed[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: () => void compressed.destroy(),
  });
  c.res = new Response(body, c.res);
  c.res.headers.delete("content-length");
  c.res.headers.set("content-encoding", encoding);
});
