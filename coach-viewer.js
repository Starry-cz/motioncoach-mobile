import {
  Box3, CanvasTexture, CircleGeometry, DirectionalLight, Group, HemisphereLight, Mesh,
  MeshBasicMaterial, NeutralToneMapping, OrthographicCamera, Scene, Vector3, WebGLRenderer,
  GLTFLoader,
} from "./vendor/coach-three.mjs";

function releaseMeshes(root) {
  const geometries=new Set(),materials=new Set(),textures=new Set();
  root.traverse(node=>{
    if(!node.isMesh)return;
    geometries.add(node.geometry);
    for(const material of [].concat(node.material))materials.add(material);
  });
  for(const material of materials) {
    for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    material.dispose();
  }
  for(const texture of textures)texture.dispose();
  for(const geometry of geometries)geometry.dispose();
}

function floorShadow(width) {
  const image=document.createElement("canvas");
  image.width=image.height=64;
  const brush=image.getContext("2d");
  const shade=brush.createRadialGradient(32,32,0,32,32,32);
  shade.addColorStop(0,"rgba(16,42,69,.30)");
  shade.addColorStop(.47,"rgba(16,42,69,.16)");
  shade.addColorStop(1,"rgba(16,42,69,0)");
  brush.fillStyle=shade;
  brush.fillRect(0,0,64,64);
  const shadow=new Mesh(new CircleGeometry(width*.58,36),new MeshBasicMaterial({
    map:new CanvasTexture(image),transparent:true,depthWrite:false,toneMapped:false,
  }));
  shadow.rotation.x=-Math.PI/2;
  shadow.scale.y=.7;
  shadow.position.y=-.001;
  return shadow;
}

export async function mountCoachViewer({canvas,src,signal}) {
  const response=await fetch(src,{signal});
  if(!response.ok)throw Error("暂时无法加载 3D 形象。");
  const {scene:model}=await new GLTFLoader().parseAsync(await response.arrayBuffer(),"");
  if(signal?.aborted) {
    releaseMeshes(model);
    throw new DOMException("已取消加载 3D 形象。","AbortError");
  }

  const context=canvas.getContext("webgl2",{alpha:true,antialias:true,powerPreference:"low-power"});
  if(!context) {
    releaseMeshes(model);
    throw Error("当前设备暂时无法显示 3D 形象。");
  }
  const renderer=new WebGLRenderer({canvas,context,alpha:true,antialias:true});
  renderer.toneMapping=NeutralToneMapping;
  renderer.toneMappingExposure=1.1;
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));

  // glTF 按 Y 轴向上、Z 轴向前。以脚底为轴心让角色转身，保持绘制范围随屏幕宽高变化。
  const box=new Box3().setFromObject(model),size=box.getSize(new Vector3()),center=box.getCenter(new Vector3());
  model.position.sub(new Vector3(center.x,box.min.y,center.z));
  const turntable=new Group();
  turntable.add(model);
  const scene=new Scene();
  const diameter=Math.hypot(size.x,size.z);
  scene.add(turntable,floorShadow(diameter),new HemisphereLight(0xf8faff,0xc2ccdc,1.4));
  const key=new DirectionalLight(0xfff6ec,2.1);
  key.position.set(-3,5,4);
  // 正面补光让眼睛和深蓝运动服在手机上也清楚，保留模型材质本身的颜色。
  const fill=new DirectionalLight(0xffffff,1.2);
  fill.position.set(3,2,5);
  const rim=new DirectionalLight(0xe0ecff,1.35);
  rim.position.set(2,4,-3);
  scene.add(key,fill,rim);
  const camera=new OrthographicCamera(-1,1,1,-1,.05,size.y*8);
  camera.position.set(0,size.y*.76,size.y*2.9);
  camera.lookAt(0,size.y*.48,0);

  const events=new AbortController();
  let gesture=null,angle=0,frame=0,lastWidth=0,lastHeight=0;
  function redraw() {
    if(frame || events.signal.aborted)return;
    frame=requestAnimationFrame(()=>{
      frame=0;
      const {clientWidth,clientHeight}=canvas;
      if(!clientWidth || !clientHeight)return;
      // 转身只更新角度，不在每一帧重新分配画布缓冲区。
      if(clientWidth!==lastWidth || clientHeight!==lastHeight) {
        const aspect=clientWidth/clientHeight;
        const height=Math.max(size.y*1.19,diameter*1.25/aspect);
        camera.top=height/2;
        camera.bottom=-height/2;
        camera.right=height*aspect/2;
        camera.left=-camera.right;
        camera.updateProjectionMatrix();
        renderer.setSize(clientWidth,clientHeight,false);
        lastWidth=clientWidth;
        lastHeight=clientHeight;
      }
      turntable.rotation.y=angle*Math.PI/180;
      renderer.render(scene,camera);
      canvas.dataset.angle=String(Math.round(angle));
    });
  }
  function face(degrees) {
    angle=((degrees+180)%360+360)%360-180;
    redraw();
  }
  const resize=new ResizeObserver(redraw);
  resize.observe(canvas);
  const options={signal:events.signal};
  canvas.addEventListener("pointerdown",event=>{
    if(!event.isPrimary || event.button!==0)return;
    gesture={id:event.pointerId,x:event.clientX,start:angle};
    canvas.setPointerCapture(event.pointerId);
  },options);
  canvas.addEventListener("pointermove",event=>{
    if(gesture?.id===event.pointerId)face(gesture.start+(event.clientX-gesture.x)*.72);
  },options);
  canvas.addEventListener("lostpointercapture",()=>{gesture=null;},options);
  function close() {
    if(events.signal.aborted)return;
    events.abort();
    resize.disconnect();
    cancelAnimationFrame(frame);
    releaseMeshes(scene);
    renderer.dispose();
    renderer.forceContextLoss();
    delete canvas.dataset.angle;
  }
  signal?.addEventListener("abort",close,{...options,once:true});
  redraw();
  return {rotateBy(degrees){face(angle+degrees);},reset(){face(0);},close};
}
