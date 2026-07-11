// live-server middleware for `npm run dev:no-sw`.
//
// Serves a no-op service worker that unregisters itself, so the cache-first
// production SW never gets in the way of live-reload during local development
// (otherwise you'd keep seeing stale cached assets).
module.exports = function (req, res, next) {
  if (req.url === "/sw.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(
      'self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", () => self.registration.unregister());',
    );
    return;
  }
  next();
};
