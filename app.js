import {extractPose,releasePose} from "./pose.js";
import {compare} from "./assessment.js";
import {savePractice,listPractices,openPractice,deletePractice} from "./library.js";
import {replay} from "./replay.js";
import {makePDF} from "./pdf.js";

const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const display=v=>v==null?"—":v.toFixed(1);
let run=null,context=null,player=null,downloadURL=null,revision=0;
const notice=message=>{$("#notice").textContent=message;};
function dispose() {
  player?.close();player=null;context?.close();context=null;
  if(downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL=null;
}
function show(id,nav) {
  revision++;dispose();notice("");$("#stage").dataset.state=id;
  for(const section of ["form","history","review"]) $("#"+section).hidden=section!==id;
  for(const button of ["work","records"]){if(button===nav) $("#"+button).setAttribute("aria-current","page");else $("#"+button).removeAttribute("aria-current");}
}
function filesChanged() {
  const ref=$("#ref-file").files[0],students=Array.from($("#stu-files").files);
  $("#ref-name").textContent=ref?.name||"选择一段视频";
  $("#stu-name").textContent=students.length?students.length+" 段 · "+students.map(f=>f.name).join("、"):"选择一段或多段视频";
  $("#analyze").disabled=!ref || !students.length || Boolean(run);
}
function busy(value) {
  $("#progress-area").hidden=!value;
  for(const id of ["ref-file","stu-files","work","records"]) $("#"+id).disabled=value;
  filesChanged();
}
async function analyze() {
  if(run) return;
  const file=$("#ref-file").files[0],students=Array.from($("#stu-files").files);
  if(!file||!students.length)return;
  const controller=new AbortController();run=controller;busy(true);notice("");$("#progress").value=0;
  let saved;
  try {
    const total=1+students.length, result=[];
    const read=(f,i,label)=>{
      $("#progress-title").textContent=label;
      return extractPose(f,{signal:controller.signal,onProgress:n=>{$("#progress").value=(i+n)/total;}});
    };
    const reference=await read(file,0,"正在识别标准示范");
    for(const [i,f] of students.entries()){
      const pose=await read(f,i+1,"正在识别学生 "+(i+1)+" / "+students.length);
      const assessment=compare(reference,pose);
      result.push({name:f.name,blob:f,report:{pose,assessment}});
    }
    if(controller.signal.aborted) throw new DOMException("已取消","AbortError");
    $("#progress-title").textContent="正在本机保存";$("#cancel").disabled=true;
    saved=await savePractice({title:file.name.replace(/\.[^.]+$/,""),reference:{name:file.name,blob:file,pose:reference},students:result});
    $("#ref-file").value="";$("#stu-files").value="";
  } catch(e){notice(controller.signal.aborted?"已取消本次分析。":e.message);}
  finally{releasePose();run=null;$("#cancel").disabled=false;busy(false);}
  if(saved)await open(saved,0);
}
async function history(){
  show("history","records");const view=revision;
  try {
    const rows=await listPractices();if(revision!==view)return;
    $("#entries").innerHTML=rows.length?rows.map(row=>'<div class="record"><button class="record-open" data-open="'+esc(row.id)+'">'+esc(row.title)+'<span>'+
      esc(new Date(row.createdAt).toLocaleString("zh-CN"))+' · '+row.students.length+' 份学生录像</span></button><button class="quiet" data-delete="'+esc(row.id)+'">删除</button></div>').join(""):'<p class="empty">完成一次分析后，可在这里重新打开录像和报告。</p>';
    $("#entries").querySelectorAll("[data-open]").forEach(b=>b.onclick=()=>open(b.dataset.open,0));
    $("#entries").querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{
      if(!confirm("删除这组录像及本机报告？"))return;
      try{await deletePractice(b.dataset.delete);await history();}catch(e){notice(e.message);}
    });
  } catch(e){notice(e.message);}
}
async function open(id,index) {
  show("review","records");const view=revision,review=$("#review");review.innerHTML="<p>正在读取本机录像…</p>";
  try{
    const data=await openPractice(id,index);if(view!==revision){data.close();return;}
    context=data;const {assessment:a,pose}=data.report;const reference=data.referencePose;
    const name=data.summary.students[index].name;
    review.innerHTML='<h1>动作复盘</h1><div class="space"><label>当前学生 <select id="student-select">'+data.summary.students.map((s,i)=>'<option value="'+i+'" '+(i===index?'selected':'')+'>'+esc(s.name)+'</option>').join("")+'</select></label><button id="pdf">导出个人 PDF</button></div><div id="pdf-result"></div>'+
      '<section class="panel"><div class="videos">'+["标准示范","学生练习"].map(t=>'<figure><figcaption>'+t+'</figcaption><div class="surface"><video muted playsinline preload="auto"></video><canvas></canvas></div></figure>').join("")+
      '</div><p class="time" id="stamp"></p><input aria-label="练习进度" id="timeline" type="range" min="0" value="0"><div class="toolbar"><button data-step="-1">上一帧</button><button id="play" class="primary">同步播放</button><button data-step="1">下一帧</button><select id="speed" aria-label="播放速度"><option value="0.5">0.5×</option><option selected value="1">1×</option></select><button id="layout">切换布局</button></div><div class="evidence">'+a.moments.map((p,i)=>'<button data-moment="'+i+'">'+p.studentTime.toFixed(2)+' 秒 · '+esc(p.label)+'</button>').join("")+'</div></section>'+
      '<section class="panel textblock"><h2>动作评分</h2><div class="metrics">'+[["总体",a.overall],["身体",a.body],["左手",a.left],["右手",a.right]].map(([s,v])=>'<div><strong>'+display(v)+'</strong><span>'+s+'</span></div>').join("")+'</div><h2>教练综合建议</h2>'+a.advice.map(p=>'<p>'+esc(p)+'</p>').join("")+
      '<details><summary>评分依据</summary><p>手机本地 MediaPipe 姿态识别。身体按对齐后的躯干、髋和膝的角差评分，两手按腕点相对髋中心的位置评分。缺测分项显示为「—」。进步比较请沿用同一手机版和同一示范。</p></details></section>'+
      '<section class="panel textblock"><h2>整体训练规划</h2><ol>'+a.plan.map(p=>'<li>'+esc(p)+'</li>').join("")+'</ol></section>';
    player=replay(review,reference,pose,a,data.referenceURL,data.studentURL);
    $("#student-select").onchange=e=>open(id,Number(e.target.value));
    review.querySelectorAll("[data-moment]").forEach(b=>b.onclick=()=>player.seek(a.moments[Number(b.dataset.moment)].studentTime));
    $("#pdf").onclick=async e=>{
      const button=e.currentTarget;button.disabled=true;
      try {
        const blob=await makePDF({name,assessment:a,studentPose:pose,referencePose:reference,...player.snapshot()});
        if(view!==revision)return;
        const filename=name.replace(/\.[^.]+$/,"")+"-个人复盘.pdf";
        // 安卓安装版通过系统文件选择器保存报告，也可以直接调起系统分享。
        if(window.MotionCoachAndroid){
          await window.MotionCoachAndroid.renderPDF($("#pdf-result"),blob,filename);
          return;
        }
        if(downloadURL)URL.revokeObjectURL(downloadURL);downloadURL=URL.createObjectURL(blob);
        const anchor=document.createElement("a");anchor.className="download";anchor.href=downloadURL;anchor.download=filename;anchor.textContent="打开或保存 PDF";
        const area=$("#pdf-result");area.replaceChildren(anchor);anchor.click();
        const file=new File([blob],anchor.download,{type:blob.type});
        if(navigator.canShare?.({files:[file]})){const share=document.createElement("button");share.textContent="分享 PDF";share.onclick=()=>navigator.share({files:[file]}).catch(err=>{if(err.name!=="AbortError")notice(err.message);});area.append(share);}
      }catch(ex){notice(ex.message);}finally{button.disabled=false;}
    };
  }catch(e){notice(e.message);}
}
$("#work").onclick=()=>show("form","work");$("#records").onclick=history;
$("#ref-file").onchange=filesChanged;$("#stu-files").onchange=filesChanged;
$("#analyze").onclick=analyze;$("#cancel").onclick=()=>run?.abort();
$("#install").onclick=()=>$("#install-dialog").showModal();$("#close-install").onclick=()=>$("#install-dialog").close();
if(matchMedia("(display-mode: standalone)").matches || navigator.standalone) $("#install").hidden=true;
if(/Android/i.test(navigator.userAgent) && !window.MotionCoachAndroid){
  $("#install").hidden=true;
  $("#android-apk").hidden=false;
}
async function offline(){
  const label=$("#offline-state");
  // 安装包已经包含模型和网页，首次断网启动也能分析。
  if(window.MotionCoachAndroid){
    $("#install").hidden=true;
    label.dataset.ready="yes";label.textContent="离线可用";
    return;
  }
  try{
    // 等待本版本的完整模型与页面都安装，再承诺可断网使用。
    const reg=await navigator.serviceWorker.register("./sw.js",{updateViaCache:"none"});
    const installing=reg.installing;
    if(installing)await new Promise((resolve,reject)=>{
      function check(){if(installing.state==="activated")resolve();if(installing.state==="redundant")reject(Error());}
      installing.addEventListener("statechange",check);check();
    });
    await navigator.serviceWorker.ready;
    label.dataset.ready="yes";label.textContent="离线可用";
  }catch{label.textContent="离线准备失败 · 点此重试";label.onclick=()=>location.reload();}
}
offline();
