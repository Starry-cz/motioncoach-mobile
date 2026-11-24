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

function nearest(frames,time) {
  const i=preceding(frames,time), next=frames[i+1];
  return next && next.time-time<time-frames[i].time ? i+1 : i;
}

function referenceClock(nodes,time) {
  let left=0,right=nodes.length-1;
  while(left+1<right) {
    const mid=(left+right)>>1;
    if(nodes[mid][0]<=time)left=mid;
    else right=mid;
  }
  const [s0,r0]=nodes[left],[s1,r1]=nodes[right];
  const fraction=Math.max(0,Math.min(1,(time-s0)/(s1-s0)));
  return r0+(r1-r0)*fraction;
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
  let raf=0,closed=false,playing=false,desired=0,desiredReference=0;
  let playRequest=0, lastCatchUp=-Infinity;
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
  const referenceAt=time=>referenceClock(analysis.playback,time);
  function display(time,referenceTime) {
    desired=time;
    desiredReference=referenceTime;
    redraw();
    showAngles(nearest(stu.frames,time));
    slider.value=time;
    stamp.textContent="练习 "+time.toFixed(2)+" 秒 · 示范 "+referenceTime.toFixed(2)+" 秒";
  }
  function seekMedia(video,time) {
    if(video.readyState>=1 && Math.abs(video.currentTime-time)>.008)video.currentTime=time;
  }
  function position(time,sample=false) {
    const studentTime=Math.min(stu.duration,Math.max(0,time));
    const referenceTime=sample ? ref.frames[analysis.alignment[nearest(stu.frames,studentTime)]].time : referenceAt(studentTime);
    seekMedia(sv,studentTime);
    seekMedia(rv,referenceTime);
    display(studentTime,referenceTime);
  }
  function adjustReferenceRate(time) {
    // 从一小段时间平均配速，吸收逐采样点的微小波动。偏离时先调整速度，让原视频持续播放。
    const start=Math.max(0,time-.2),end=Math.min(stu.duration,time+.45);
    const drift=referenceAt(time)-rv.currentTime;
    const base=(referenceAt(end)-referenceAt(start))/(end-start)*sv.playbackRate;
    const rate=Math.max(.125,Math.min(8,base+drift*1.8));
    if(Math.abs(rv.playbackRate-rate)>.04)rv.playbackRate=rate;
    return drift;
  }
  function tick(now) {
    if(closed || !playing)return;
    const time=Math.min(stu.duration,sv.currentTime);
    if(loop && time>=markB) {
      start(markA);
      return;
    }
    const drift=adjustReferenceRate(time);
    // 解码器偶发落后时低频向前校正。普通播放和低可见度片段沿连续时钟自然前进。
    if(drift>.55 && !rv.seeking && !sv.seeking && now-lastCatchUp>950) {
      seekMedia(rv,referenceAt(time));
      lastCatchUp=now;
    }
    display(time,Math.min(ref.duration,rv.currentTime));
    raf=requestAnimationFrame(tick);
  }
  function pause() {
    playing=false;playRequest++;
    sv.pause();rv.pause();cancelAnimationFrame(raf);
    play.textContent="同步播放";
  }
  function seek(time,label,sample=Boolean(label)) {
    pause();
    focus=focusJoints[label] || null;
    position(time,sample);
  }
  async function start(time) {
    const request=++playRequest;
    focus=null;
    position(time);
    lastCatchUp=performance.now();
    playing=true;play.textContent="暂停";
    try {
      sv.playbackRate=Number(speed.value);
      adjustReferenceRate(time);
      // 两个内联静音播放器必须在同一次点击中启动，避免移动端丢失播放授权。
      await Promise.all([sv.play(),rv.play()]);
      if(request===playRequest && !closed)raf=requestAnimationFrame(tick);
    } catch {
      if(request!==playRequest || closed)return;
      pause();
      stamp.textContent="此视频无法播放，请使用手机支持的原片格式。";
    }
  }
  on(rv,"loadedmetadata",()=>seekMedia(rv,desiredReference));
  on(sv,"loadedmetadata",()=>seekMedia(sv,desired));
  for(const video of videos) {
    on(video,"loadeddata",redraw);
    on(video,"seeked",redraw);
  }
  on(sv,"ended",()=>{
    if(!playing)return;
    pause();
    if(loop)start(markA);
    else position(stu.duration);
  });
  on(play,"click",()=>{
    if(playing) {
      pause();
      display(sv.currentTime,rv.currentTime);
      return;
    }
    const outside=loop && (desired<markA || desired>=markB);
    start(outside ? markA : desired>=stu.duration-.04 ? 0 : desired);
  });
  on(speed,"change",()=>{sv.playbackRate=Number(speed.value);});
  on(slider,"input",()=>seek(Number(slider.value)));
  for(const button of view.querySelectorAll("[data-step]")) on(button,"click",()=>{
    let i=nearest(stu.frames,desired);i=Math.max(0,Math.min(stu.frames.length-1,i+Number(button.dataset.step)));
    seek(stu.frames[i].time,undefined,true);
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
  on(frameData,"toggle",()=>{if(frameData.open)showAngles(nearest(stu.frames,desired));});
  showMarks();
  position(0);
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
