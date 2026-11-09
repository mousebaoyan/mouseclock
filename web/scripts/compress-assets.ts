// After the build: a Brotli and a gzip copy of each built static file worth compressing, which
// the server sends in its place to browsers that take them (design §14). Done once, so each
// format at its strongest.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = "build/client";
const TEXT = /\.(?:css|html|js|json|svg|txt|webmanifest|xml)$/;
// Shorter than this, compressing saves less than the extra file costs.
const MIN_BYTES = 1024;

for (const entry of await readdir(ROOT, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !TEXT.test(entry.name)) continue;
  const path = join(entry.parentPath, entry.name);
  const data = await readFile(path);
  if (data.length < MIN_BYTES) continue;
  const brotli = {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
  };
  await writeFile(`${path}.br`, brotliCompressSync(data, { params: brotli }));
  await writeFile(`${path}.gz`, gzipSync(data, { level: 9 }));
}
