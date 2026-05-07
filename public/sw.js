const CACHE_NAME = 'shogi-analyzer-prototype-v2'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.svg', '/icon-512.svg', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  const { request } = event
  const url = new URL(request.url)
  const isNavigation = request.mode === 'navigate'
  const isSameOrigin = url.origin === self.location.origin

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached

      return fetch(request)
        .then((response) => {
          if (isSameOrigin && response.ok) {
            const cloned = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned))
          }
          return response
        })
        .catch(() => {
          if (isNavigation) return caches.match('/index.html')
          if (request.destination === 'image') return caches.match('/icon-192.svg')
          return new Response('offline', { status: 503, statusText: 'Offline' })
        })
    }),
  )
})
