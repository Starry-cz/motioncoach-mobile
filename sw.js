const CACHE="motioncoach-pocket-1.0.0-3";
const FILES=["./","./index.html","./app.js","./style.css","./manifest.webmanifest","./icon-180.png","./icon-192.png","./icon-512.png",
  "./assessment.js","./pose.js","./replay.js","./pdf.js","./library.js","./vendor/vision_bundle.mjs","./vendor/pose_landmarker_lite.task",
  "./vendor/wasm/vision_wasm_internal.js","./vendor/wasm/vision_wasm_internal.wasm","./vendor/wasm/vision_wasm_nosimd_internal.js",
  "./vendor/wasm/vision_wasm_nosimd_internal.wasm","./vendor/LICENSE-mediapipe.txt","./vendor/NOTICE.txt"];
const assets=new Set(FILES.map(p=>new URL(p,self.registration.scope).href));
self.addEventListener("install",event=>{
  // 模型、WASM、页面同时就绪才启用这一版，下载中断可以重新安装。
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll(FILES.map(p=>new Request(new URL(p,self.registration.scope),{cache:"reload"})));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate",event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith("motioncoach-pocket-") && name!==CACHE)await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET" || !assets.has(request.url))return;
  event.respondWith((async()=> (await (await caches.open(CACHE)).match(request)) || fetch(request))());
});
