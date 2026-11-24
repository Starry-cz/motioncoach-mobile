const CACHE="motioncoach-pocket-1.2.1";
// 这些版本使用相同的 MediaPipe 运行库与 Pose Landmarker Lite 模型，可直接复用下载结果。
const REUSABLE=["motioncoach-pocket-1.2.0","motioncoach-pocket-1.1.1-1","motioncoach-pocket-1.1.0-1"];
const FILES=["./","./index.html","./app.js","./style.css","./manifest.webmanifest","./icon-180.png","./icon-192.png","./icon-512.png",
  "./assessment.js","./pose.js","./replay.js","./pdf.js","./library.js","./coach.js","./coach.css","./training.js","./training.css","./vendor/vision_bundle.mjs","./vendor/pose_landmarker_lite.task",
  "./vendor/wasm/vision_wasm_internal.js","./vendor/wasm/vision_wasm_internal.wasm","./vendor/wasm/vision_wasm_nosimd_internal.js",
  "./vendor/wasm/vision_wasm_nosimd_internal.wasm","./vendor/LICENSE-mediapipe.txt","./vendor/NOTICE.txt"];
const assets=new Set(FILES.map(p=>new URL(p,self.registration.scope).href));
self.addEventListener("install",event=>{
  // 模型、WASM、页面同时就绪才启用这一版，下载中断可以重新安装。
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    const names=await caches.keys();
    const previous=REUSABLE.find(name=>names.includes(name));
    const installed=previous?await caches.open(previous):null;
    const toDownload=[];
    for(const path of FILES) {
      const request=new Request(new URL(path,self.registration.scope),{cache:"reload"});
      const asset=path.startsWith("./vendor/") && installed ? await installed.match(request) : null;
      if(asset) await cache.put(request,asset);
      else toDownload.push(request);
    }
    await cache.addAll(toDownload);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate",event=>event.waitUntil((async()=>{
  // 先接管页面再移除旧缓存，让离线重开不会撞上切换时的空窗。
  await self.clients.claim();
  for(const name of await caches.keys())if(name.startsWith("motioncoach-pocket-") && name!==CACHE)await caches.delete(name);
})()));
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET" || !assets.has(request.url))return;
  event.respondWith((async()=> (await (await caches.open(CACHE)).match(request)) || fetch(request))());
});
