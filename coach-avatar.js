export function mountCoachAvatar(host,{onOpen,signal}) {
  const dialog=document.createElement("dialog");
  dialog.id="coach-avatar-dialog";
  dialog.className="coach-avatar-dialog";
  dialog.setAttribute("aria-labelledby","coach-avatar-title");
  dialog.innerHTML=`
    <header class="coach-avatar-heading">
      <div><h2 id="coach-avatar-title">跃教练</h2><span>3D 形象</span></div>
      <button id="close-coach-avatar" type="button" autofocus>返回复盘</button>
    </header>
    <div class="coach-avatar-stage" data-state="preview">
      <img id="coach-avatar-poster" src="./coach-yue-poster.webp" alt="跃教练的全身形象" width="420" height="540" loading="lazy">
      <canvas id="coach-avatar-canvas" role="img" aria-label="可旋转的跃教练全身 3D 模型" aria-hidden="true"></canvas>
      <p id="coach-avatar-status" role="status"></p>
    </div>
    <div class="coach-avatar-controls" hidden>
      <span>拖动旋转</span>
      <div aria-label="旋转模型" role="group">
        <button type="button" data-avatar-rotate="-30" aria-label="向左转 30 度">左转</button>
        <button type="button" id="coach-avatar-reset">正面</button>
        <button type="button" data-avatar-rotate="30" aria-label="向右转 30 度">右转</button>
      </div>
    </div>`;
  host.append(dialog);

  const $=selector=>dialog.querySelector(selector);
  const stage=$(".coach-avatar-stage"),poster=$("#coach-avatar-poster");
  const canvasTemplate=$("#coach-avatar-canvas"),status=$("#coach-avatar-status"),controls=$(".coach-avatar-controls");
  const listen=(node,event,handler)=>node.addEventListener(event,handler,{signal});
  let active;

  function release() {
    const previous=active;
    active=null;
    previous?.abort.abort();
    previous?.viewer?.close();
  }

  async function open() {
    if(dialog.open)return;
    release();
    const instance={abort:new AbortController(),viewer:null};
    active=instance;
    // WebGL 上下文会随上次关闭释放，每次打开使用一个新画布。
    const canvas=canvasTemplate.cloneNode(false);
    $("#coach-avatar-canvas").replaceWith(canvas);
    stage.dataset.state="preview";
    poster.hidden=false;
    canvas.setAttribute("aria-hidden","true");
    controls.hidden=true;
    status.textContent="正在打开 3D 形象…";
    onOpen?.();
    dialog.showModal();
    try {
      // 只在主动打开形象时启动渲染器，复盘页面平时用静态头像。
      const {mountCoachViewer}=await import("./coach-viewer.js");
      if(active!==instance || !dialog.open)return;
      const viewer=await mountCoachViewer({canvas,src:new URL("./coach-yue-3d.glb",import.meta.url),
        signal:instance.abort.signal});
      if(active!==instance || !dialog.open){viewer.close();return;}
      instance.viewer=viewer;
      stage.dataset.state="ready";
      poster.hidden=true;
      controls.hidden=false;
      canvas.removeAttribute("aria-hidden");
      status.textContent="";
    } catch {
      if(active!==instance || !dialog.open)return;
      status.textContent="这台设备暂时无法旋转，仍可查看全身形象。";
    }
  }

  listen(host.querySelector("#open-coach-avatar"),"click",open);
  listen($("#close-coach-avatar"),"click",()=>dialog.close());
  listen(dialog,"close",()=>{if(!dialog.open)release();});
  for(const button of dialog.querySelectorAll("[data-avatar-rotate]")){
    listen(button,"click",()=>active?.viewer?.rotateBy(Number(button.dataset.avatarRotate)));
  }
  listen($("#coach-avatar-reset"),"click",()=>active?.viewer?.reset());
  return ()=>{
    release();
    if(dialog.open)dialog.close();
    dialog.remove();
  };
}
