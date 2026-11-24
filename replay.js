import {evidenceForFrame} from "./assessment.js";
const edges=[["l_shoulder","r_shoulder"],["l_hip","r_hip"],["l_shoulder","l_hip"],["r_shoulder","r_hip"]];
for(const side of ["l","r"]) for(const [a,b] of [["shoulder","elbow"],["elbow","wrist"],["hip","knee"],["knee","ankle"]]) edges.push([side+"_"+a,side+"_"+b]);
const joints=[...new Set(edges.flat())];
const colours=["#57e5ff","#ffc85b"], outline="#132133";
const focusJoints={
  "躯干侧倾":["l_shoulder","r_shoulder","l_hip","r_hip"],
  "左髋角":["l_hip"],"右髋角":["r_hip"],"左膝角":["l_knee"],"右膝角":["r_knee"],
  "左肘角":["l_elbow"],"右肘角":["r_elbow"],"左臂上举角":["l_shoulder"],"右臂上举角":["r_shoulder"],
  "左上臂方向":["l_shoulder","l_elbow"],"右上臂方向":["r_shoulder","r_elbow"],
  "肩线倾斜":["l_shoulder","r_shoulder"],
};

function preceding(frames,time) {
  let a=0,b=frames.length;
  while(a+1<b){const m=(a+b)>>1;if(frames[m].time<=time)a=m;else b=m;}
  return a;
}
function drawSkeleton(c,frame,rect,colour,thickness,focus) {
  const {x,y,width,height}=rect;
  const points={};
  for(const name of joints) {
    const point=frame.points[name];
    if(point?.confidence>=0.6 && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1) {
      points[name]={x:x+point.x*width,y:y+point.y*height};
    }
  }
  // 深色衬边把骨架和画面分开，关键点保留在可见关节上，裁掉的关节不补画。
  c.lineCap="round";
  c.beginPath();
  for(const [a,b] of edges){
    const p=points[a],q=points[b];
    if(p && q){c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);}
  }
  c.strokeStyle=outline;c.lineWidth=thickness+2.4;c.stroke();
  c.strokeStyle=colour;c.lineWidth=thickness;c.stroke();
  const radius=thickness*.68;
  c.beginPath();
  for(const point of Object.values(points)) {
    c.moveTo(point.x+radius,point.y);
    c.arc(point.x,point.y,radius,0,2*Math.PI);
  }
  c.strokeStyle=outline;c.lineWidth=2;c.stroke();
  c.fillStyle=colour;c.fill();
  for(const name of focus || []) {
    const point=points[name];
    if(!point) continue;
    c.beginPath();c.arc(point.x,point.y,radius+3.6,0,2*Math.PI);
    c.strokeStyle=outline;c.lineWidth=4;c.stroke();
    c.strokeStyle="#fff";c.lineWidth=1.8;c.stroke();
  }
}

function paint(video,canvas,frame,box,colour,focus) {
  const sourceWidth=video.videoWidth,sourceHeight=video.videoHeight;
  const {width,height}=box;
  if(!sourceWidth || !sourceHeight || !width || !height || video.seeking) return;
  // 笔宽按屏幕像素计，画布像素密度独立，视频留黑时按 contain 算出实际图像位置。
  const density=Math.min(devicePixelRatio,2);
  const pixelWidth=Math.round(width*density),pixelHeight=Math.round(height*density);
  if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){canvas.width=pixelWidth;canvas.height=pixelHeight;}
  const c=canvas.getContext("2d");
  const fit=Math.min(width/sourceWidth,height/sourceHeight);
  const w=sourceWidth*fit,h=sourceHeight*fit;
  c.setTransform(pixelWidth/width,0,0,pixelHeight/height,0,0);
  c.clearRect(0,0,width,height);
  drawSkeleton(c,frame,{x:(width-w)/2,y:(height-h)/2,width:w,height:h},colour,
    Math.max(3,Math.min(5,Math.min(w,h)/92)),focus);
}

export function replay(view,ref,stu,analysis,refURL,stuURL) {
  const [rv,sv]=view.querySelectorAll("video"),[rc,sc]=view.querySelectorAll(".surface canvas");
  const slider=view.querySelector("#timeline"), play=view.querySelector("#play"), stamp=view.querySelector("#stamp");
  const speed=view.querySelector("#speed"),clips=[ref,stu],videos=[rv,sv],canvases=[rc,sc];
  let raf=0,closed=false,playing=false,desired=0, currentRef=0;
  let markA=null,markB=null,loop=false,lastFrame=-1;
  let showSkeleton=true, focus=null;
  const overlay=view.querySelector("#overlay");
  const loopButton=view.querySelector("#ab-loop"),positions=view.querySelector("#loop-times");
  const frameData=view.querySelector("#frame-data"),angleRows=view.querySelector("#frame-angles");
  const events=new AbortController(),on=(node,event,fn)=>node.addEventListener(event,fn,{signal:events.signal});
  // 竖持手机回看横屏舞蹈时，默认让每位学生占满行宽。
  const layout=view.querySelector("#layout"),pair=view.querySelector(".videos");
  const narrow=matchMedia("(max-width:580px)");
  function nameLayout(){layout.textContent=pair.classList.contains("stacked")?"并排对比":"上下对比";}
  function fitLayout(){pair.classList.toggle("stacked",narrow.matches && ref.aspectRatio>1 && stu.aspectRatio>1);nameLayout();}
  fitLayout();on(narrow,"change",fitLayout);
  const dimensions=new Map();
  function visibleFrame(i){return clips[i].frames[preceding(clips[i].frames,videos[i].currentTime)];}
  function redraw(){
    if(!showSkeleton)return;
    videos.forEach((video,i)=>{
      const canvas=canvases[i],box=dimensions.get(canvas);
      if(box)paint(video,canvas,visibleFrame(i),box,colours[i],focus);
    });
  }
  // 缩放时重绘。播放循环复用测得的尺寸，避免每帧反复计算页面布局。
  const surfaceSizes=new ResizeObserver(entries=>{
    for(const {target,contentRect} of entries)dimensions.set(target,contentRect);
    redraw();
  });
  for(const canvas of canvases) surfaceSizes.observe(canvas);
  rv.src=refURL;sv.src=stuURL;rv.muted=true;sv.muted=true;
  videos.forEach((v,i)=>{v.parentElement.style.aspectRatio=String(clips[i].aspectRatio);});
  slider.max=stu.duration;slider.step="0.01";
  function showMarks(){
    const valid=markA!==null && markB!==null && markB>markA;
    if(!valid)loop=false;
    loopButton.disabled=!valid;loopButton.setAttribute("aria-pressed",String(loop));
    const format=t=>t===null?"—":t.toFixed(2)+" 秒";
    positions.textContent="A "+format(markA)+" · B "+format(markB)+(markA!==null && markB!==null && !valid?"（B 须晚于 A）":"");
  }
  function showAngles(i){
    if(!frameData.open || lastFrame===i)return;
    lastFrame=i;angleRows.replaceChildren();
    const info=evidenceForFrame(ref,stu,analysis.alignment,i);
    for(const angle of info.angles){
      const row=angleRows.insertRow();
      for(const value of [angle.label,...[angle.referenceAngle,angle.studentAngle,angle.delta].map(v=>v.toFixed(1)+"°")])row.insertCell().textContent=value;
    }
    if(!info.angles.length){const cell=angleRows.insertRow().insertCell();cell.colSpan=4;cell.textContent="此时刻缺少可测关节。";}
  }
  function update(time,seekStudent=false) {
    desired=Math.min(stu.duration,Math.max(0,time));
    if(seekStudent && sv.readyState>=1) sv.currentTime=desired;
    const i=preceding(stu.frames,desired),next=Math.min(i+1,stu.frames.length-1);
    const a=ref.frames[analysis.alignment[i]].time,b=ref.frames[analysis.alignment[next]].time;
    const width=stu.frames[next].time-stu.frames[i].time;
    const fraction=width ? Math.min(1,Math.max(0,(desired-stu.frames[i].time)/width)) : 0;
    currentRef=a+(b-a)*fraction;
    // 示范按单调动作路径插值连续回看；未测到骨架的画面仍显示原片。
    if(rv.readyState>=1 && (!playing || !rv.seeking) && Math.abs(rv.currentTime-currentRef)>0.025) rv.currentTime=currentRef;
    redraw();
    showAngles(i);
    slider.value=desired;stamp.textContent="练习 "+desired.toFixed(2)+" 秒 · 示范 "+currentRef.toFixed(2)+" 秒";
  }
  function tick(){if(closed||!playing)return;if(loop && sv.currentTime>=markB)update(markA,true);else update(sv.currentTime);raf=requestAnimationFrame(tick);}
  function pause(){playing=false;sv.pause();cancelAnimationFrame(raf);play.textContent="同步播放";}
  function seek(t,label){pause();focus=focusJoints[label]||null;update(t,true);}
  on(rv,"loadeddata",()=>update(desired));
  on(sv,"loadeddata",()=>update(desired,Math.abs(sv.currentTime-desired)>.025));
  for(const video of videos)on(video,"seeked",redraw);
  on(sv,"ended",()=>{if(loop && playing){update(markA,true);sv.play().catch(pause);}else{pause();update(stu.duration);}});
  on(play,"click",async()=>{
    if(playing){pause();return;}
    if(loop && (desired<markA || desired>=markB))seek(markA);
    else if(desired>=stu.duration-0.05)seek(0);
    focus=null;
    try{sv.playbackRate=Number(speed.value);await sv.play();if(closed)return;playing=true;play.textContent="暂停";tick();}
    catch{pause();stamp.textContent="此视频无法播放，请使用手机支持的原片格式。";}
  });
  on(speed,"change",()=>{sv.playbackRate=Number(speed.value);});
  on(slider,"input",()=>seek(Number(slider.value)));
  for(const button of view.querySelectorAll("[data-step]")) on(button,"click",()=>{
    let i=preceding(stu.frames,desired);i=Math.max(0,Math.min(stu.frames.length-1,i+Number(button.dataset.step)));
    seek(stu.frames[i].time);
  });
  on(layout,"click",()=>{pair.classList.toggle("stacked");nameLayout();});
  if(overlay)on(overlay,"click",()=>{
    showSkeleton=!showSkeleton;
    overlay.setAttribute("aria-pressed",String(showSkeleton));
    for(const canvas of canvases)canvas.hidden=!showSkeleton;
    redraw();
  });
  on(view.querySelector("#mark-a"),"click",()=>{markA=desired;showMarks();});
  on(view.querySelector("#mark-b"),"click",()=>{markB=desired;showMarks();});
  on(loopButton,"click",()=>{loop=!loop;showMarks();if(loop)seek(markA);});
  on(frameData,"toggle",()=>{if(frameData.open)showAngles(preceding(stu.frames,desired));});
  showMarks();
  update(0);
  return {seek, snapshot(){
    const images=videos.map((v,i)=>{
      if(v.readyState<2 || v.seeking) return null;
      const c=document.createElement("canvas");c.width=Math.min(820,v.videoWidth);c.height=Math.round(c.width*v.videoHeight/v.videoWidth);
      const ctx=c.getContext("2d");
      ctx.drawImage(v,0,0,c.width,c.height);
      // PDF 使用原图比例单独绘制，避免把屏幕留白或像素缩放带入报告。
      if(showSkeleton)drawSkeleton(ctx,visibleFrame(i),{x:0,y:0,width:c.width,height:c.height},colours[i],
        Math.max(4,Math.min(10,Math.min(c.width,c.height)/76)),focus);
      return c;
    });
    return {images:images.every(Boolean)?images:[],imageTimes:[rv.currentTime,sv.currentTime]};
  },close(){closed=true;pause();events.abort();surfaceSizes.disconnect();for(const v of videos){v.removeAttribute("src");v.load();}}};
}
