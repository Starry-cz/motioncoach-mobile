import {
  AmbientLight, BackSide, Box3, CanvasTexture, CircleGeometry, DataTexture, DirectionalLight,
  Group, Mesh, MeshBasicMaterial, MeshToonMaterial, NearestFilter, OrthographicCamera,
  RedFormat, Scene, Vector3, WebGLRenderer, GLTFLoader,
} from "./vendor/coach-three.mjs";

const outlinedSurfaces=new Set(["hair","hair_lock","hair_deep","jacket","pants","shoe","sole"]);

function collectTextures(material,textures) {
  for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
}

function releaseTextures(textures,retained=new Set()) {
  const images=new Set(),retainedImages=new Set(Array.from(retained,texture=>texture.image));
  for(const texture of textures){
    if(retained.has(texture))continue;
    if(texture.image?.close && !retainedImages.has(texture.image))images.add(texture.image);
    texture.dispose();
  }
  // glTF 加载器可能在多个贴图对象之间共享同一张 ImageBitmap。
  for(const image of images)image.close();
}

function applyCelShading(model,height) {
  // 用四档亮度保留动画式的明暗边界，眼线、眼睛高光和纸上细节沿用原色。
  const ramp=new DataTexture(new Uint8Array([110,110,110,110,162,162,209,255]),8,1,RedFormat);
  ramp.minFilter=ramp.magFilter=NearestFilter;
  ramp.needsUpdate=true;
  const shaded=new Map(),meshes=[],originalTextures=new Set(),renderedTextures=new Set();
  model.traverse(mesh=>{if(mesh.isMesh)meshes.push(mesh);});
  const contour=new MeshBasicMaterial({color:0x262536,side:BackSide,toneMapped:false});
  const width=(height*.00145).toFixed(6);
  contour.onBeforeCompile=shader=>{
    // 只沿原网格的法线轻微外扩背面，轮廓共享原几何数据。
    shader.vertexShader=shader.vertexShader.replace("#include <begin_vertex>",
      `vec3 transformed = vec3(position) + normalize(normal) * ${width};`);
  };
  function shade(source) {
    if(source.isMeshBasicMaterial){
      collectTextures(source,renderedTextures);
      return source;
    }
    if(!shaded.has(source)){
      const properties={
        name:source.name,color:source.color,map:source.map,alphaMap:source.alphaMap,
        alphaTest:source.alphaTest,side:source.side,transparent:source.transparent,
        opacity:source.opacity,depthWrite:source.depthWrite,vertexColors:source.vertexColors,
        toneMapped:false,
      };
      const material=new MeshToonMaterial({...properties,gradientMap:ramp});
      collectTextures(source,originalTextures);
      collectTextures(material,renderedTextures);
      shaded.set(source,material);
    }
    return shaded.get(source);
  }
  let hasContour=false;
  for(const mesh of meshes){
    if(Array.isArray(mesh.material)){
      mesh.material=mesh.material.map(shade);
    }else{
      if(!mesh.isSkinnedMesh && outlinedSurfaces.has(mesh.material.name)){
        mesh.add(new Mesh(mesh.geometry,contour));
        hasContour=true;
      }
      mesh.material=shade(mesh.material);
    }
  }
  if(!hasContour)contour.dispose();
  releaseTextures(originalTextures,renderedTextures);
  for(const source of shaded.keys())source.dispose();
}

function releaseMeshes(root) {
  const geometries=new Set(),materials=new Set(),textures=new Set();
  root.traverse(node=>{
    if(!node.isMesh)return;
    geometries.add(node.geometry);
    for(const material of [].concat(node.material))materials.add(material);
  });
  for(const material of materials) {
    collectTextures(material,textures);
    material.dispose();
  }
  releaseTextures(textures);
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
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));

  // glTF 按 Y 轴向上、Z 轴向前。以脚底为轴心让角色转身，保持绘制范围随屏幕宽高变化。
  const box=new Box3().setFromObject(model),size=box.getSize(new Vector3()),center=box.getCenter(new Vector3());
  applyCelShading(model,size.y);
  model.position.sub(new Vector3(center.x,box.min.y,center.z));
  const turntable=new Group();
  turntable.add(model);
  const scene=new Scene();
  const diameter=Math.hypot(size.x,size.z);
  scene.add(turntable,floorShadow(diameter),new AmbientLight(0xeef3ff,1.13));
  const key=new DirectionalLight(0xfff6ed,2.63);
  key.position.set(-3,4,5);
  scene.add(key);
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
