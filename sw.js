// Detector de Almas en Pena: funciona sin conexión.
// Sube CACHE al cambiar archivos del núcleo.
const CACHE = "almas-v7";
const CORE = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png", "voz/mespeak.js", "voz-worker.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
// al actualizar se borran las versiones viejas de la app, nunca la voz descargada («almas-voz»)
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== "almas-voz").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // la página: primero la red (siempre lo más nuevo), sin conexión la copia guardada
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put("index.html", cp)); return r; })
      .catch(() => caches.match("index.html")));
    return;
  }
  // el resto (voz, íconos, fuentes): primero la copia guardada
  // el motor de la voz realista (onnxruntime y el fonetizador) también queda guardado para usarla sin internet;
  // el modelo de voz lo guarda la propia app en «almas-voz»
  const engine = url.hostname === "cdnjs.cloudflare.com" && url.pathname.includes("/onnxruntime-web/")
    || url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("/piper-wasm@");
  if (url.origin === location.origin || engine || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok || r.type === "opaque") { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
      return r;
    })));
  }
});
