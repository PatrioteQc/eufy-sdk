/**
 * Collapse the emitted `dist` JavaScript into the single ESM file `dist/index.js`.
 *
 * A consumer evaluates the whole package on import — `exports` has one entry and no subpaths, so the
 * barrel is the only door — and ~200 separate module records cost far more resident memory than the
 * same code in one. Measured on Node 22 x86-64, importing the package costs +28 MB as a tree and
 * +15 MB bundled: module records, per-file source maps and compilation units collapse into one.
 *
 * Runtime dependencies stay external, so `mqtt` and `protobufjs` keep loading on first use rather
 * than being pulled into the bundle and evaluated at import.
 *
 * Declarations are untouched: `tsc` emits the `.d.ts` tree, `exports.types` still points at
 * `dist/index.d.ts`, and the relative specifiers inside it resolve against files this script leaves
 * in place. Only `.js` and `.js.map` are replaced.
 */

import { build } from "esbuild";
import { readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const STAGE = ".bundle";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/**
 * Every runtime dependency, kept out of the bundle.
 *
 * Bundling one would defeat the lazy loads it is there to preserve and ship a second copy of a
 * package the consumer already resolves. Read from `dependencies` so adding one cannot silently
 * change what is inlined.
 */
const external = Object.keys(pkg.dependencies ?? {});

await build({
  entryPoints: [join(DIST, "index.js")],
  outfile: join(STAGE, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external,
  sourcemap: true,
  logLevel: "warning",
});

/** Every emitted `.js` and `.js.map` under `dist`, which the bundle now supersedes. */
function emittedJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...emittedJs(path));
    else if (entry.endsWith(".js") || entry.endsWith(".js.map")) out.push(path);
  }
  return out;
}

for (const file of emittedJs(DIST)) rmSync(file);
renameSync(join(STAGE, "index.js"), join(DIST, "index.js"));
renameSync(join(STAGE, "index.js.map"), join(DIST, "index.js.map"));
rmSync(STAGE, { recursive: true, force: true });

const bytes = statSync(join(DIST, "index.js")).size;
console.log(`bundled dist/index.js (${(bytes / 1024 / 1024).toFixed(2)} MB, external: ${external.join(", ")})`);
