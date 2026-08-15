// Consumed by the `offline-kit` CLI. Lists what to precache; the CLI bundles
// ui.ts/sw.ts and injects a content-hashed manifest of these globbed from the
// built output.
export default {
  // The AI search runs off the main thread; declaring it here bundles it and
  // lets `offline-kit verify` see it (nothing else can — it's only ever named
  // inside JS, so an unprecached worker would break offline silently).
  workers: [{ entry: "ai-worker.ts", outfile: "ai-worker.js" }],
  precache: [
    "ui.js",
    "ai-worker.js",
    "style.min.css",
    "favicon.svg",
    "manifest.webmanifest",
    "assets/**/*.{woff2,png,svg}",
  ],
};
