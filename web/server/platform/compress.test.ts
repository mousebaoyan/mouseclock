import { Hono } from "hono";
import { brotliDecompressSync } from "node:zlib";
import { expect, test } from "vitest";
import { compressResponses } from "./compress.ts";

const programs = Array.from({ length: 200 }, (_, i) => ({ id: i, name: "2027 年夏令营" }));
const app = new Hono()
  .use(compressResponses)
  .get("/json", (c) => c.json({ programs }))
  .get("/logo", (c) => c.body(new Uint8Array(2000), 200, { "content-type": "image/png" }));

function get(path: string, encoding = "gzip, deflate, br, zstd") {
  return app.request(path, { headers: { "accept-encoding": encoding } });
}

test("浏览器支持 Brotli 就用 Brotli，否则用 gzip；都不支持就原样返回", async () => {
  const br = await get("/json");
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("vary")).toBe("accept-encoding");
  const body = brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString();
  expect(JSON.parse(body)).toEqual({ programs });

  expect((await get("/json", "gzip, deflate")).headers.get("content-encoding")).toBe("gzip");
  expect((await get("/json", "identity")).headers.get("content-encoding")).toBeNull();
});

test("已经压缩过的图片原样返回", async () => {
  const png = await get("/logo");
  expect(png.headers.get("content-encoding")).toBeNull();
  expect((await png.arrayBuffer()).byteLength).toBe(2000);
});
