// sw.js - Service Worker de Conteo+
//
// Estrategia:
// - App shell (html/css/js propios + manifest + íconos): cache-first, con
//   actualización en segundo plano (stale-while-revalidate) para que el
//   próximo arranque ya tenga la versión nueva sin que el usuario note nada.
// - Firebase (Auth/Firestore) y cualquier dominio externo: NUNCA se cachea,
//   pasa directo a la red. Estos datos siempre tienen que ser frescos.
//
// IMPORTANTE: subí CACHE_VERSION cada vez que hagas un deploy con cambios en
// los archivos cacheados (app.js, style.css, index.html, firebase.js), si no
// los usuarios pueden quedar viendo una versión vieja hasta que expire el caché.
const CACHE_VERSION = 'conteo-plus-v1';

const APP_SHELL = [
    './',
    './index.html',
    './app.js',
    './firebase.js',
    './style.css',
    './manifest.json',
    './web-app-manifest-192x192.png',
    './web-app-manifest-512x512.png',
    './web-app-manifest-512x512.png'
];

// -------------------------------
// Instalación: precachea el app shell
// -------------------------------
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

// -------------------------------
// Activación: borra cachés de versiones viejas
// -------------------------------
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((nombres) => Promise.all(
                nombres
                    .filter((nombre) => nombre !== CACHE_VERSION)
                    .map((nombre) => caches.delete(nombre))
            ))
            .then(() => self.clients.claim())
    );
});

// -------------------------------
// Fetch: cache-first + stale-while-revalidate para el app shell propio.
// Todo lo demás (Firebase, fonts, CDNs externos) pasa directo a la red.
// -------------------------------
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Solo interceptamos GET.
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Cualquier dominio que no sea el propio (Firebase, Google Fonts,
    // Tailwind CDN, html5-qrcode, etc.) lo dejamos pasar directo a la red,
    // sin tocarlo ni cachearlo.
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        caches.match(request).then((cacheado) => {
            const fetchPromise = fetch(request)
                .then((respuestaRed) => {
                    if (respuestaRed && respuestaRed.ok) {
                        const clon = respuestaRed.clone();
                        caches.open(CACHE_VERSION).then((cache) => cache.put(request, clon));
                    }
                    return respuestaRed;
                })
                .catch(() => cacheado); // sin conexión: devolvemos lo cacheado si hay

            // Si hay algo en caché lo servimos al toque (rápido) y actualizamos
            // en segundo plano. Si no hay nada cacheado, esperamos la red.
            return cacheado || fetchPromise;
        })
    );
});
