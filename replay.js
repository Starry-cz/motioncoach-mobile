const edges=[["l_shoulder","r_shoulder"],["l_hip","r_hip"],["l_shoulder","l_hip"],["r_shoulder","r_hip"]];
for(const side of ["l","r"]) for(const [a,b] of [["shoulder","elbow"],["elbow","wrist"],["hip","knee"],["knee","ankle"]]) edges.push([side+"_"+a,side+"_"+b]);

function preceding(frames,time) {
  let a=0,b=frames.length;
  while(a+1<b){const m=(a+b)>>1;if(frames[m].time<=time)a=m;else b=m;}
  return a;
}
function paint(video,canvas,frame,colour) {
  const w=video.videoWidth,h=video.videoHeight;
  if(!w || !h) return;
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  const c=canvas.getContext("2d");
  c.clearRect(0,0,w,h);c.strokeStyle=colour;c.lineWidth=Math.max(3,Math.min(w,h)/140);
  c.lineCap="round";c.beginPath();
  for(const [a,b] of edges){
    const p=frame.points[a],q=frame.points[b];
    if(p?.confidence>=0.6 && q?.confidence>=0.6){c.moveTo(p.x*w,p.y*h);c.lineTo(q.x*w,q.y*h);}
  }
  c.stroke();
}
export function replay(view,ref,stu,analysis,refURL,stuURL) {
  const [rv,sv]=view.querySelectorAll("video"),[rc,sc]=view.querySelectorAll(".surface canvas");
  const slider=view.querySelector("#timeline"), play=view.querySelector("#play"), stamp=view.querySelector("#stamp");
  const speed=view.querySelector("#speed"),clips=[ref,stu],videos=[rv,sv];
  let raf=0,closed=false,playing=false,desired=0, currentRef=0;
  const events=new AbortController(),on=(node,event,fn)=>node.addEventListener(event,fn,{signal:events.signal});
  // 竖持手机回看横屏舞蹈时，默认让每位学生占满行宽。
  const layout=view.querySelector("#layout"),pair=view.querySelector(".videos");
  const narrow=matchMedia("(max-width:580px)");
  function nameLayout(){layout.textContent=pair.classList.contains("stacked")?"并排对比":"上下对比";}
  function fitLayout(){pair.classList.toggle("stacked",narrow.matches && ref.aspectRatio>1 && stu.aspectRatio>1);nameLayout();}
  fitLayout();on(narrow,"change",fitLayout);
  rv.src=refURL;sv.src=stuURL;rv.muted=true;sv.muted=true;
  videos.forEach((v,i)=>{v.parentElement.style.aspectRatio=String(clips[i].aspectRatio);});
  slider.max=stu.duration;slider.step="0.01";
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
    paint(sv,sc,stu.frames[i],"#afc0ff");paint(rv,rc,ref.frames[preceding(ref.frames,currentRef)],"#44c8ff");
    slider.value=desired;stamp.textContent="练习 "+desired.toFixed(2)+" 秒 · 示范 "+currentRef.toFixed(2)+" 秒";
  }
  function tick(){if(closed||!playing)return;update(sv.currentTime);raf=requestAnimationFrame(tick);}
  function pause(){playing=false;sv.pause();cancelAnimationFrame(raf);play.textContent="同步播放";}
  function seek(t){pause();update(t,true);}
  videos.forEach(v=>{on(v,"loadeddata",()=>update(desired));});
  on(sv,"ended",()=>{pause();update(stu.duration);});
  on(play,"click",async()=>{
    if(playing){pause();return;}
    if(desired>=stu.duration-0.05)seek(0);
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
  update(0);
  return {seek, snapshot(){
    const images=videos.map((v,i)=>{
      if(v.readyState<2 || v.seeking) return null;
      const c=document.createElement("canvas");c.width=Math.min(820,v.videoWidth);c.height=Math.round(c.width*v.videoHeight/v.videoWidth);
      const ctx=c.getContext("2d");ctx.drawImage(v,0,0,c.width,c.height);ctx.drawImage(i?sc:rc,0,0,c.width,c.height);return c;
    });
    return {images:images.every(Boolean)?images:[],imageTimes:[rv.currentTime,sv.currentTime]};
  },close(){closed=true;pause();events.abort();for(const v of videos){v.removeAttribute("src");v.load();}}};
}
