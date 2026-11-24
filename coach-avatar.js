export async function mountCoachAvatar(stage,signal) {
  const canvas=stage.querySelector("canvas");
  // 入口始终可以点击。海报与模型使用同一站姿，首帧画好再切换。
  const showPoster=()=>{stage.dataset.state="poster";};
  canvas.addEventListener("webglcontextlost",showPoster,{signal});
  try {
    const {mountCoachViewer}=await import("./coach-viewer.js");
    if(signal.aborted)return;
    await mountCoachViewer({canvas,src:new URL("./coach-yue-3d.glb",import.meta.url),signal,
      onFirstFrame:()=>{stage.dataset.state="ready";}});
  } catch {
    // 老设备可能无法创建 WebGL 上下文，站立海报同样可以直接打开教练。
    if(!signal.aborted)showPoster();
  }
}
