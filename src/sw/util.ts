import webpDataUrl from 'data-url:./tiny.webp';
import avifDataUrl from 'data-url:./tiny.avif';

// Give TypeScript the correct global.
declare var self: ServiceWorkerGlobalScope;

export function cacheOrNetwork(event: FetchEvent): void {
  event.respondWith(
    (async function () {
      const cachedResponse = await caches.match(event.request, {
        ignoreSearch: true,
      });
      return cachedResponse || fetch(event.request);
    })(),
  );
}

export function cacheOrNetworkAndCache(
  event: FetchEvent,
  cacheName: string,
): void {
  event.respondWith(
    (async function () {
      const { request } = event;
      // Return from cache if possible.
      const cachedResponse = await caches.match(request);
      if (cachedResponse) return cachedResponse;

      // Else go to the network.
      const response = await fetch(request);
      const responseToCache = response.clone();

      event.waitUntil(
        (async function () {
          // Cache what we fetched.
          const cache = await caches.open(cacheName);
          await cache.put(request, responseToCache);
        })(),
      );

      // Return the network response.
      return response;
    })(),
  );
}

export function serveShareTarget(event: FetchEvent): void {
  const dataPromise = event.request.formData();

  // Redirect so the user can refresh the page without resending data.
  event.respondWith(Response.redirect('/?share-target'));

  event.waitUntil(
    (async function () {
      // The page sends this message to tell the service worker it's ready to receive the file.
      await nextMessage('share-ready');
      const client = await self.clients.get(event.resultingClientId);
      const data = await dataPromise;
      const file = data.get('file');
      client!.postMessage({ file, action: 'load-image' });
    })(),
  );
}

export function cleanupCache(
  event: FetchEvent,
  cacheName: string,
  keepAssets: string[],
) {
  event.waitUntil(
    (async function () {
      const cache = await caches.open(cacheName);

      // Clean old entries from the dynamic cache.
      const requests = await cache.keys();
      const promises = requests.map((cachedRequest) => {
        // Get pathname without leading /
        const assetPath = new URL(cachedRequest.url).pathname.slice(1);
        // If it isn't one of our keepAssets, we don't need it anymore.
        if (!keepAssets.includes(assetPath)) return cache.delete(cachedRequest);
      });

      await Promise.all<any>(promises);
    })(),
  );
}

function getAssetsWithPrefix(assets: string[], prefixes: string[]) {
  return assets.filter((asset) =>
    prefixes.some((prefix) => asset.startsWith(prefix)),
  );
}

export async function cacheBasics(cacheName: string, buildAssets: string[]) {
  const toCache = ['/'];

  const prefixesToCache = [
    // TODO: this is likely incomplete
    // Main app JS & CSS:
    'c/initial-app-',
    // Service worker handler:
    'c/sw-bridge-',
    // Little icons for the demo images on the homescreen:
    'c/icon-demo-',
    // Site logo:
    'c/logo-',
  ];

  const prefixMatches = getAssetsWithPrefix(buildAssets, prefixesToCache);

  toCache.push(...prefixMatches);

  const cache = await caches.open(cacheName);
  await cache.addAll(toCache);
}

export async function cacheAdditionalProcessors(
  cacheName: string,
  buildAssets: string[],
) {
  let toCache = [];

  const prefixesToCache = [
    // TODO: these will need to change
    // Worker which handles image processing:
    'processor-worker.',
    // processor-worker imports:
    'process-',
  ];

  const prefixMatches = getAssetsWithPrefix(buildAssets, prefixesToCache);
  const wasm = buildAssets.filter((asset) => asset.endsWith('.wasm'));

  toCache.push(...prefixMatches, ...wasm);

  const [supportsWebP, supportsAvif] = await Promise.all(
    [webpDataUrl, avifDataUrl].map(async (dataUrl) => {
      if (!self.createImageBitmap) return false;
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      return createImageBitmap(blob).then(
        () => true,
        () => false,
      );
    }),
  );

  // TODO: this is likely wrong
  // No point caching decoders the browser already supports:
  toCache = toCache.filter(
    (asset) =>
      (supportsWebP ? !/webp[\-_]dec/.test(asset) : true) &&
      (supportsAvif ? !/avif[\-_]dec/.test(asset) : true),
  );

  const cache = await caches.open(cacheName);
  await cache.addAll(toCache);
}

const nextMessageResolveMap = new Map<string, (() => void)[]>();

/**
 * Wait on a message with a particular event.data value.
 *
 * @param dataVal The event.data value.
 */
function nextMessage(dataVal: string): Promise<void> {
  return new Promise((resolve) => {
    if (!nextMessageResolveMap.has(dataVal)) {
      nextMessageResolveMap.set(dataVal, []);
    }
    nextMessageResolveMap.get(dataVal)!.push(resolve);
  });
}

self.addEventListener('message', (event) => {
  const resolvers = nextMessageResolveMap.get(event.data);
  if (!resolvers) return;
  nextMessageResolveMap.delete(event.data);
  for (const resolve of resolvers) resolve();
});
