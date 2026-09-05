/** Bundles the React viewer into dist/public (run after tsc). */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

// The viewer registers Excalidraw canvas fonts (Virgil, Cascadia, …) via
// FontFace at ./fonts/<Family>/<file>.woff2 relative to viewer.js. Without
// these files every canvas falls back to system fonts and text no longer
// matches the geometry the server computed. Ship them (minus the 13MB CJK
// Xiaolai set — CJK falls back to system fonts).
const excaliEntry = createRequire(join(process.cwd(), "package.json")).resolve("@excalidraw/excalidraw");
const excaliDir = dirname(excaliEntry);
const srcFonts = join(excaliDir, "fonts");
if (!existsSync(srcFonts)) {
  console.warn(`fonts not found at ${srcFonts} — canvas will fall back to system fonts`);
} else {
  console.log(`copying canvas fonts from ${srcFonts}`);
}
const destFonts = join(process.cwd(), "dist", "public", "fonts");
mkdirSync(destFonts, { recursive: true });
if (existsSync(srcFonts)) {
  for (const fam of ["Assistant", "Cascadia", "ComicShanns", "Excalifont", "Liberation", "Lilita", "Nunito", "Virgil"]) {
    const from = join(srcFonts, fam);
    if (existsSync(from)) cpSync(from, join(destFonts, fam), { recursive: true });
  }
}

console.log("viewer bundled to dist/public (+fonts, no Xiaolai)");
