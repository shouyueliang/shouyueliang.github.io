/* ==========================================================
   绮捐繘缇ゅ伐鍏风娴嬭瘯 鈥?Service Worker
   鏂囨。涓庝唬鐮侊紙html/js/css/json锛夛細缃戠粶浼樺厛 鈫?缂撳瓨鍏滃簳锛堟洿鏂板嵆鏃跺彲瑙侊級
   鍥剧墖涓庤棰戠瓑澶ф枃浠讹細缂撳瓨浼樺厛锛堢绾垮彲鐢ㄣ€佺渷娴侀噺锛?
   ========================================================== */
"use strict";

const CACHE = "jjq-toolbox-v44";
const PRECACHE = [
  "./",
  "./index.html",
  "./admin.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./css/style.css",
  "./js/app.js",
  "./js/admin.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 鏂囨。/浠ｇ爜绫伙細缂撳瓨浼樺厛绉掑紑 + 鍚庡彴闈欓粯鏇存柊锛坰tale-while-revalidate锛夈€?
   鍘熺綉缁滀紭鍏堝湪绾胯矾鎷ュ牭鏃朵細璁╅〉闈㈡寕浣忓嚑鍗佺鐧藉睆 */
function staleWhileRevalidate(request) {
  return caches.match(request).then((hit) => {
    const bg = fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    }).catch(() => null);
    return hit || bg || Response.error();
  });
}

/* 澶ф枃浠讹紙瑙嗛/鍥剧墖锛夛細缂撳瓨浼樺厛 */
function cacheFirst(request) {
  return caches.match(request, { ignoreSearch: true }).then((hit) => {
    if (hit) return hit;
    return fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    });
  });
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  /* 视频/音频的分段（Range）请求不经过这里，交给浏览器直接取：
     经 Service Worker 中转的范围请求会间歇性出现"有响应头却不出数据"的卡死，
     而且分段响应(206)本来也无法写入缓存，中转没有任何好处 */
  if (e.request.headers.has("range")) return;

  const isDocLike =
    e.request.mode === "navigate" ||
    /\.(html|js|css|json)$/.test(url.pathname) ||
    url.pathname === "./" || url.pathname === "/";

  if (isDocLike) {
    e.respondWith(staleWhileRevalidate(e.request));
  } else {
    e.respondWith(cacheFirst(e.request).catch(() => {
      if (e.request.mode === "navigate") return caches.match("./index.html");
      return Response.error();
    }));
  }
});

