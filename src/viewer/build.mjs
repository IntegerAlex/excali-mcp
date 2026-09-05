/** Bundles the React viewer into dist/public (run after tsc). */
import { build } from "esbuild";

await build({
  entryPoints: ["src/viewer/app.tsx"],
  bundle: true,
  outdir: "dist/public",
  entryNames: "viewer",
  format: "esm",
  platform: "browser",
  conditions: ["production", "browser", "import", "module", "default"],
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".woff": "file", ".woff2": "file" },
  minify: true,
  sourcemap: true,
});

console.log("viewer bundled to dist/public");
