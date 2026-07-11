// Consumed by the `offline-kit` CLI. Lists what to precache; the CLI bundles
// ui.ts/sw.ts and injects a content-hashed manifest of these globbed from the
// built output.
export default {
  precache: [
    "ui.js",
    "style.min.css",
    "favicon.svg",
    "manifest.webmanifest",
    "assets/**/*.{woff2,png,svg}",
  ],
};
