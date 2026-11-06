// Builds the server for Vercel as one bundled function in Vercel's Build Output format (.vercel/output).
// Bundling sidesteps what Vercel's own TypeScript step can't follow: our .ts import paths and the sdk's .ts files.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

// Bring the database up to date first: the build is the one step that can read Vercel's encrypted settings.
// Projects or environments without a database (previews) skip it.
if (process.env.DATABASE_URL) {
  const run = spawnSync(process.execPath, ["scripts/migrate.ts"], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

const out = ".vercel/output";
const fn = `${out}/functions/index.func`;
rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ["src/vercel.ts"],
  outfile: `${fn}/index.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["pg-native"],
  // Some bundled packages still call require(); give ESM output one.
  banner: { js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);` },
});
writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify({ runtime: "nodejs24.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false }),
);
writeFileSync(`${out}/config.json`, JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/index" }] }));
console.log("built .vercel/output");
