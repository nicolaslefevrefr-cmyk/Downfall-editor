/* Version du cache : à incrémenter à chaque déploiement notable. Change le
   nom du cache => l'ancien est supprimé au prochain "activate", donc rien
   ne reste bloqué sur une ancienne version indéfiniment. */
const CACHE_VERSION = "v2";
const CACHE_NAME = "editeur-chutelibre-" + CACHE_VERSION;
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/editor.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

/* Réseau d'abord : on veut toujours la dernière version déployée quand la
   connexion est disponible. Le cache ne sert que de repli hors-ligne (ou si
   le réseau échoue) — jamais de "vieille version qui reste collée". */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
