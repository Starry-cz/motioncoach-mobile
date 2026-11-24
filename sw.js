const VERSION="1.3.6";
const CACHE="motioncoach-pocket-"+VERSION;
const MODEL_EDITION="mediapipe-0.10.21-pose-lite-1";
// 这些版本使用相同的 MediaPipe 运行库与 Pose Landmarker Lite 模型，可直接复用下载结果。
const REUSABLE=["motioncoach-pocket-1.2.1","motioncoach-pocket-1.2.0","motioncoach-pocket-1.1.1-1","motioncoach-pocket-1.1.0-1"];
const MODEL_FILES=["./vendor/vision_bundle.mjs","./vendor/pose_landmarker_lite.task",
  "./vendor/wasm/vision_wasm_internal.js","./vendor/wasm/vision_wasm_internal.wasm","./vendor/wasm/vision_wasm_nosimd_internal.js",
  "./vendor/wasm/vision_wasm_nosimd_internal.wasm","./vendor/LICENSE-mediapipe.txt","./vendor/NOTICE.txt"];
const FILES=["./","./index.html","./app.js","./style.css","./manifest.webmanifest","./icon-180.png","./icon-192.png","./icon-512.png",
  "./assessment.js","./pose.js","./replay.js","./pdf.js","./library.js","./account.js","./profile.js","./coach.js","./coach.css","./coach-yue.webp",
  "./coach-avatar.js","./coach-viewer.js","./coach-yue-3d.glb","./coach-yue-poster.webp","./vendor/coach-three.mjs","./vendor/LICENSE-coach-three.txt",
  "./training.js","./training.css",...MODEL_FILES];
const assets=new Set(FILES.map(p=>new URL(p,self.registration.scope).href));
const modelMarker=new URL("./.offline-model",self.registration.scope).href;

async function previousModelCache() {
  for(const name of await caches.keys()) {
    if(name===CACHE || !name.startsWith("motioncoach-pocket-"))continue;
    const installed=await caches.open(name);
    const marker=await installed.match(modelMarker);
    if(REUSABLE.includes(name) || (marker && await marker.text()===MODEL_EDITION))return installed;
  }
  return null;
}

self.addEventListener("install",event=>{
  // 模型、WASM、页面同时就绪才启用这一版，下载中断可以重新安装。
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    const installed=await previousModelCache();
    const toDownload=[];
    for(const path of FILES) {
      const request=new Request(new URL(path,self.registration.scope),{cache:"reload"});
      const asset=MODEL_FILES.includes(path) && installed ? await installed.match(request) : null;
      if(asset) await cache.put(request,asset);
      else toDownload.push(request);
    }
    await cache.addAll(toDownload);
    // 发布边缘节点可能先到达新版脚本，确认已拿到同版首页后再接管页面。
    const home=await cache.match(new URL("./",self.registration.scope));
    if(!home || !(await home.text()).includes('data-release="'+VERSION+'"'))throw Error("首页版本尚未同步");
    // 后续版本只需更新 VERSION。模型或推理运行库变更时同步改 MODEL_EDITION。
    await cache.put(modelMarker,new Response(MODEL_EDITION));
    await self.skipWaiting();
  })().catch(async error=>{
    // 发布过程中下载到旧首页时，只清理这次未激活的缓存，保留使用中的旧版。
    await caches.delete(CACHE);
    throw error;
  }));
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
self.addEventListener("message",event=>{
  // 页面只在接管当前标签的工作线程已经完成安装后切换版本。
  if(event.data?.type==="version")event.ports[0]?.postMessage(VERSION);
});
