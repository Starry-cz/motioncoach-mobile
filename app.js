import {extractPose,releasePose} from "./pose.js";
import {compare,refreshAssessment} from "./assessment.js";
import {savePractice,listPractices,openPractice,deletePractice,saveCoaching,classScores,
  addStandard,listStandards,readStandard,removeStandard} from "./library.js";
import {replay} from "./replay.js";
import {makePDF} from "./pdf.js";
import {mountCoach,openCoachSettings} from "./coach.js";
import {mountTraining} from "./training.js";

const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const display=v=>v==null?"—":v.toFixed(1);
let run=null,context=null,player=null,coach=null,training=null,standard=null,standardId=null,revision=0;
const downloadURLs=new Set();
const notice=message=>{$("#notice").textContent=message;};
function dispose() {
  coach?.close();coach=null;training?.();training=null;
  player?.close();player=null;context?.close();context=null;
  for(const url of downloadURLs)URL.revokeObjectURL(url);
  downloadURLs.clear();
}
function show(id,nav) {
  revision++;dispose();notice("");$("#stage").dataset.state=id;
  for(const section of ["form","history","review","standards","training"]) $("#"+section).hidden=section!==id;
  for(const button of ["work","records","standards-nav","training-nav"]){if(button===nav) $("#"+button).setAttribute("aria-current","page");else $("#"+button).removeAttribute("aria-current");}
  window.scrollTo(0,0);
}
function filesChanged() {
  const ref=standard||$("#ref-file").files[0],students=Array.from($("#stu-files").files);
  $("#ref-name").textContent=ref?.name||"选择示范";
  $("#stu-name").textContent=students.length?students.length+" 段 · "+students.map(f=>f.name).join("、"):"可选多段";
  $("#ref-file").parentElement.toggleAttribute("data-selected",Boolean(ref));
  $("#stu-files").parentElement.toggleAttribute("data-selected",Boolean(students.length));
  $("#analyze").disabled=!ref || !students.length || Boolean(run);
}
function busy(value) {
  $("#progress-area").hidden=!value;
  for(const id of ["ref-file","stu-files","work","records","standards-nav","training-nav","choose-standard"]) $("#"+id).disabled=value;
  filesChanged();
}
async function analyze() {
  if(run) return;
  const file=standard||$("#ref-file").files[0],students=Array.from($("#stu-files").files);
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
    saved=await savePractice({title:file.name.replace(/\.[^.]+$/,""),reference:{name:file.name,blob:file,pose:reference,standardId},students:result});
    standard=null;standardId=null;$("#ref-file").value="";$("#stu-files").value="";
  } catch(e){notice(controller.signal.aborted?"已取消本次分析。":e.message);}
  finally{releasePose();run=null;$("#cancel").disabled=false;busy(false);}
  if(saved)await open(saved,0);
}
async function history(){
  show("history","records");const view=revision;
  try {
    const rows=await listPractices();if(revision!==view)return;
    $("#entries").innerHTML=rows.length?rows.map(row=>'<div class="record"><button class="record-open" data-open="'+esc(row.id)+'">'+esc(row.title)+'<span>'+
      esc(new Date(row.createdAt).toLocaleString("zh-CN"))+' · '+row.students.length+' 位学生</span></button><button class="quiet" data-delete="'+esc(row.id)+'">删除</button></div>').join(""):'<p class="empty">暂无练习记录</p>';
    $("#entries").querySelectorAll("[data-open]").forEach(b=>b.onclick=()=>open(b.dataset.open,0));
    $("#entries").querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{
      if(!confirm("删除这组录像及本机报告？"))return;
      try{await deletePractice(b.dataset.delete);await history();}catch(e){notice(e.message);}
    });
  } catch(e){notice(e.message);}
}

// 关键片段与复练步骤共用证据序号，点击任一位置都回到相同的动作。
function feedbackMarkup(a) {
  const data=a.guidance;
  const evidenceButton=(index,label)=>Number.isInteger(index)
    ? '<button class="jump-link" type="button" data-moment="'+index+'">'+label+'</button>' : "";
  const insights=data.insights.map(item=>{
    const moment=a.moments[item.momentIndex];
    const measurement=moment ? `<div class="measurement">
      <span>${moment.range?`${moment.range.start.toFixed(2)}–${moment.range.end.toFixed(2)} 秒 · 平均角差 ${moment.meanDelta.toFixed(1)}°`:`${moment.studentTime.toFixed(2)} 秒 · 单帧角差 ${moment.delta.toFixed(1)}°`}</span>
      <span>练习 ${moment.studentAngle.toFixed(1)}° · 示范 ${moment.referenceAngle.toFixed(1)}°</span>
    </div>` : "";
    return `<div><div class="insight-heading"><h3>${esc(item.title)}</h3>${evidenceButton(item.momentIndex,"回看")}</div>
      <p>${esc(item.cue || item.text)}</p>${measurement}</div>`;
  }).join("");
  const steps=data.steps.map(step=>'<li><div><h3>'+esc(step.title)+'</h3><p>'+esc(step.text)+'</p>'+
    evidenceButton(step.momentIndex,"定位练习")+'</div></li>').join("");
  return `<section class="review-section" id="feedback">
    <div class="section-head"><h2>动作评分${a.coverage.partial?' <small>可测部分</small>':""}</h2><button id="go-coach" class="quiet">AI 长评与问答 ↓</button></div>
    <div class="metrics">${[["总体",a.overall],["身体",a.body],["左腕",a.left],["右腕",a.right]].map(([label,v])=>
      '<div><span>'+label+'</span><strong>'+display(v)+'</strong></div>').join("")}</div>
    ${data.coverageNote?'<p class="coverage-note">'+esc(data.coverageNote)+'</p>':""}
    <h2 class="feedback-title">教练建议</h2><p class="feedback-summary">${esc(data.summary)}</p>
    <div class="insight-list">${insights}</div>
    <details class="metric-details"><summary>评分依据</summary><p>身体比较躯干、髋和膝的可测角度。左右腕比较腕点相对髋中心的位置。</p></details>
  </section>
  <section class="review-section"><h2>训练规划</h2><ol class="training-steps">${steps}</ol></section>`;
}

function playerMarkup(a) {
  const moments=a.moments.map((p,i)=>{
    const time=p.range ? p.range.start.toFixed(2)+"–"+p.range.end.toFixed(2) : p.studentTime.toFixed(2);
    return '<button data-moment="'+i+'"><span>'+time+' 秒</span><strong>'+esc(p.label)+
      '</strong><span>'+p.delta.toFixed(1)+'°</span></button>';
  }).join("");
  return `<section class="review-player" aria-label="视频对比">
    <div class="player-header"><h2>视频对比</h2><div class="playback-view">
      <button id="overlay" aria-pressed="true">骨架</button><button id="layout">切换布局</button>
    </div></div>
    <div class="videos">${["标准示范","学生练习"].map((title,i)=>`<figure>
      <figcaption class="${i===0?"reference-tone":"student-tone"}">${title}</figcaption>
      <div class="surface"><video muted playsinline preload="auto" aria-label="${title}"></video><canvas aria-hidden="true"></canvas></div>
    </figure>`).join("")}</div>
    <div class="playback-dock"><p class="time" id="stamp"></p>
      <input aria-label="练习进度" id="timeline" type="range" min="0" value="0">
      <div class="playback-controls"><button data-step="-1">上一帧</button><button id="play" class="primary">同步播放</button><button data-step="1">下一帧</button>
        <select id="speed" aria-label="播放速度"><option value="0.5">0.5×</option><option selected value="1">1×</option></select></div>
    </div>
  </section>
  ${moments?'<section class="review-section review-evidence"><h2>关键片段</h2><div class="evidence">'+moments+'</div></section>':""}
  <details id="frame-data" class="review-section"><summary>定点复练与本帧角度</summary>
    <div class="toolbar"><button id="mark-a">设 A</button><button id="mark-b">设 B</button><button id="ab-loop" aria-pressed="false" disabled>A–B 循环</button><span id="loop-times" role="status"></span></div>
    <div class="table-scroll"><table><thead><tr><th>关节</th><th>示范</th><th>练习</th><th>相差</th></tr></thead><tbody id="frame-angles"></tbody></table></div>
  </details>`;
}

async function open(id,index,startTime=0) {
  show("review","records");const view=revision,review=$("#review");review.innerHTML="<p>正在读取本机录像…</p>";
  try{
    const data=await openPractice(id,index);if(view!==revision){data.close();return;}
    context=data;const {pose}=data.report;const reference=data.referencePose;
    const a=refreshAssessment(reference,pose,data.report.assessment);
    const name=data.summary.students[index].name;
    const students=data.summary.students.map((s,i)=>'<option value="'+i+'" '+(i===index?'selected':'')+'>'+esc(s.name)+'</option>').join("");
    review.innerHTML=`<div class="page-title"><h1>动作复盘</h1><button id="pdf" class="quiet">导出个人 PDF</button></div>
      <div class="review-selector"><select id="student-select" aria-label="当前学生">${students}</select></div><div id="pdf-result"></div>
      ${playerMarkup(a)}
      ${feedbackMarkup(a)}
      <section id="ai-coach" tabindex="-1"></section>
      ${data.summary.students.length>1?'<details class="review-section" id="classroom"><summary>全班总览 · '+data.summary.students.length+' 名学生</summary><div id="class-content"></div></details>':""}`;
    player=replay(review,reference,pose,a,data.referenceURL,data.studentURL);
    if (startTime>0) player.seek(startTime);
    const aiArea=$("#ai-coach");
    coach=mountCoach(aiArea,{assessment:a,referencePose:reference,studentPose:pose,seek:(time,label)=>player.seek(time,label),
      saved:data.coaching,onChange:async state=>{
        const version=await saveCoaching(id,index,state,data.coachingVersion);
        data.coaching=state;data.coachingVersion=version;
      }});
    $("#go-coach").onclick=()=>{aiArea.focus({preventScroll:true});aiArea.scrollIntoView({block:"start"});};
    if ($("#classroom")) $("#classroom").ontoggle=async event=>{
      if(!event.target.open || $("#class-content")?.hasChildNodes())return;
      try {
        const rows=await classScores(data.summary,report=>refreshAssessment(reference,report.pose,report.assessment));
        if(view!==revision)return;
        const area=$("#class-content");
        area.innerHTML='<div class="table-scroll"><table><thead><tr><th>学生</th><th>总体</th><th>身体</th><th>左手</th><th>右手</th></tr></thead><tbody>'+
          rows.map(row=>'<tr><th><button data-member="'+row.index+'">'+esc(row.name)+'</button></th>'+["overall","body","left","right"].map(k=>'<td>'+display(row[k])+'</td>').join("")+'</tr>').join("")+
          '</tbody></table></div><button id="class-pdf">导出班级 PDF</button><div id="class-download"></div>';
        area.querySelectorAll("[data-member]").forEach(b=>b.onclick=()=>open(id,Number(b.dataset.member)));
        $("#class-pdf").onclick=async event=>{
          const button=event.currentTarget;button.disabled=true;
          try {
            const blob=await makePDF({classroom:{title:data.summary.title,rows}});
            if(view===revision) await offerPDF(blob,data.summary.title+"-班级讲评.pdf",$("#class-download"));
          }catch(e){notice(e.message);}finally{button.disabled=false;}
        };
      }catch(e){notice(e.message);}
    };
    $("#student-select").onchange=e=>open(id,Number(e.target.value));
    review.querySelectorAll("[data-moment]").forEach(button=>button.onclick=()=>{
      const moment=a.moments[Number(button.dataset.moment)];
      player.seek(moment.studentTime,moment.label);
      review.querySelector(".evidence [aria-current]")?.removeAttribute("aria-current");
      review.querySelector('.evidence [data-moment="'+button.dataset.moment+'"]')?.setAttribute("aria-current","true");
      review.querySelector(".review-player").scrollIntoView({block:"start"});
    });
    $("#pdf").onclick=async e=>{
      const button=e.currentTarget;button.disabled=true;
      try {
        const blob=await makePDF({name,assessment:a,studentPose:pose,referencePose:reference,coaching:data.coaching,...player.snapshot()});
        if(view!==revision)return;
        const filename=name.replace(/\.[^.]+$/,"")+"-个人复盘.pdf";
        await offerPDF(blob,filename,$("#pdf-result"));
      }catch(ex){notice(ex.message);}finally{button.disabled=false;}
    };
  }catch(e){notice(e.message);}
}
async function offerPDF(blob,filename,area) {
  // 安卓走系统文件选择器；Safari 可用本机文件分享菜单。
  if(window.MotionCoachAndroid){await window.MotionCoachAndroid.renderPDF(area,blob,filename);return;}
  const previous=area.querySelector("a.download")?.href;
  if(downloadURLs.delete(previous))URL.revokeObjectURL(previous);
  const url=URL.createObjectURL(blob);
  downloadURLs.add(url);
  const anchor=document.createElement("a");anchor.className="download";anchor.href=url;anchor.download=filename;anchor.textContent="打开或保存 PDF";
  area.replaceChildren(anchor);anchor.click();
  const file=new File([blob],filename,{type:blob.type});
  if(navigator.canShare?.({files:[file]})){
    const share=document.createElement("button");share.textContent="分享 PDF";
    share.onclick=()=>navigator.share({files:[file]}).catch(err=>{if(err.name!=="AbortError")notice(err.message);});area.append(share);
  }
}
async function standardsPage() {
  show("standards","standards-nav");const view=revision;
  try{
    const rows=await listStandards();if(view!==revision)return;
    const entries=$("#standard-entries");
    entries.innerHTML=rows.length?rows.map(s=>'<div class="record"><button class="record-open" data-use="'+esc(s.id)+'">'+esc(s.name)+'<span>用作示范</span></button><button class="quiet" data-remove="'+esc(s.id)+'">移除</button></div>').join(""):'<p class="empty">暂无标准视频</p>';
    entries.querySelectorAll("[data-use]").forEach(b=>b.onclick=async()=>{
      try{const file=await readStandard(b.dataset.use);if(view!==revision)return;standard=file;standardId=b.dataset.use;$("#ref-file").value="";show("form","work");filesChanged();}catch(e){notice(e.message);}
    });
    entries.querySelectorAll("[data-remove]").forEach(b=>b.onclick=async()=>{
      if(!confirm("从标准库移除这份示范？"))return;
      try{await removeStandard(b.dataset.remove);if(view===revision)await standardsPage();}catch(e){notice(e.message);}
    });
  }catch(e){notice(e.message);}
}
$("#work").onclick=()=>show("form","work");$("#records").onclick=history;
$("#standards-nav").onclick=standardsPage;$("#choose-standard").onclick=standardsPage;
$("#training-nav").onclick=()=>{show("training","training-nav");training=mountTraining($("#training"),{openReview:open});};
$("#ai-settings").onclick=()=>openCoachSettings();
$("#add-standard").onchange=async e=>{
  const input=e.currentTarget,file=input.files[0];if(!file)return;input.disabled=true;
  try{await addStandard(file);if(!$("#standards").hidden)await standardsPage();}catch(err){notice(err.message);}
  finally{input.value="";input.disabled=false;}
};
$("#ref-file").onchange=()=>{standard=null;standardId=null;filesChanged();};$("#stu-files").onchange=filesChanged;
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
