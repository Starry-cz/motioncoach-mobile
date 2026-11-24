import {evidenceAt} from "./assessment.js";

const services = {
  deepseek: {name:"DeepSeek", url:"https://api.deepseek.com/chat/completions", models:["deepseek-flash","deepseek-v4-pro"]},
  bailian: {name:"阿里云百炼（北京）", url:"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", models:["qwen-plus","qwen-flash"]},
};
const storageKey = "motioncoach-phone-ai-settings";
const tabs = {review:"教练长评",plan:"训练计划",chat:"证据问答"};
const instructions = {
  review:"用三至五个自然段写一份约 350 至 550 中文字的教练长评。解释各评分的含义，把一个具体差异和下一遍该怎样练联系起来，最后说怎样复测。缺测时缩短篇幅并解释该补录什么。",
  plan:"为同一学生制订一周的分段训练计划。按训练日列出重点、次数或时长、速度、观察点，最后给出在同一机位复测的判断条件。把训练目标与本次测量区分开。",
  chat:"用中文直接回答本次学生的问题。若问到具体时刻，优先用该时刻的实测关节角。没有所问时刻或部位的证据时明说。若追问，用本学生最近几轮问答理解上下文，以本次测量为准。",
};
const systemPrompt = "你是舞蹈与啦啦操教练。只依据本轮提供的当前学生测量做判断；没有视频、声音、三维信息或其他学生数据。身体分反映对齐后的躯干、髋和膝角差；左右腕分反映腕点相对躯干的位置，不代表手型。不要编造评分、时刻、角差、动作名、节拍、诊断或进步趋势。空分代表缺测。请用普通中文和分段换行，不用 Markdown。输出 JSON 对象，text 为完整正文字符串，citations 为正文引用的材料 id 字符串数组。引用实测画面时必须选用所给 id，没有相关画面则返回空数组。";

let activeService = "deepseek", profiles, dialog;
function loadSettings() {
  if (profiles) return;
  profiles = {};
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (!saved) return;
    if (Object.prototype.hasOwnProperty.call(services,saved.selected)) activeService = saved.selected;
    for (const id of Object.keys(services)) {
      const item = saved.profiles?.[id];
      if (item?.key && services[id].models.includes(item.model)) profiles[id] = {...item,remember:true};
    }
  } catch { /* 浏览器禁止存储时仍可由用户选择仅在本次打开期间使用。 */ }
}

function saveSettings(id, profile) {
  const updated = {...profiles};
  if (profile) updated[id] = profile; else delete updated[id];
  const remembered = Object.fromEntries(Object.entries(updated).filter(([,entry])=>entry.remember));
  // 两个服务各自保管其密钥，切换服务时不会沿用另一个服务的凭据。
  try {
    if (Object.keys(remembered).length) localStorage.setItem(storageKey,JSON.stringify({selected:id,profiles:remembered}));
    else localStorage.removeItem(storageKey);
  } catch {
    if (profile?.remember || profiles[id]?.remember) throw Error("设备未能保存设置，请检查浏览器的网站存储权限。");
  }
  activeService=id;
  profiles=updated;
  window.dispatchEvent(new Event("motioncoach-ai-settings"));
}

function el(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent=content;
  if (className) node.className=className;
  return node;
}

export function openCoachSettings() {
  loadSettings();
  if (dialog?.open) return;
  dialog=el("dialog",null,"coach-settings");
  // 这里是固定的界面模板；用户问题、模型回答和存储值只走 DOM 属性或 textContent。
  dialog.innerHTML=`
    <form><h2 id="coach-settings-title">AI 服务设置</h2>
    <label>服务<select name="service" aria-label="服务"></select></label>
    <label>模型<select name="model" aria-label="模型"></select></label>
    <label>API Key<input name="key" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <label class="coach-remember"><input name="remember" type="checkbox">在此设备记住该服务的 Key</label>
    <p class="coach-hint">在共享手机上可仅本次使用。生成内容会按所选服务的账号用量计费。</p>
    <p class="coach-error" role="alert"></p>
    <div class="coach-actions"><button type="submit" class="primary">应用设置</button><button type="button" data-clear>清除此服务的 Key</button><button type="button" data-close>关闭</button></div></form>`;
  dialog.setAttribute("aria-labelledby","coach-settings-title");
  document.body.append(dialog);
  const form=dialog.querySelector("form"), {service,model,key,remember}=form.elements;
  const error=dialog.querySelector("[role=alert]"),clear=dialog.querySelector("[data-clear]");
  for (const [id,spec] of Object.entries(services)) service.add(new Option(spec.name,id));
  service.value=activeService;
  function selectService() {
    const id=service.value, profile=profiles[id];
    model.replaceChildren(...services[id].models.map(name=>new Option(name,name)));
    model.value=profile?.model || services[id].models[0];
    key.value=profile?.key || "";
    key.setCustomValidity("");
    remember.checked=Boolean(profile?.remember);
    clear.disabled=!profile?.key;
    error.textContent="";
  }
  selectService();
  service.onchange=selectService;
  key.oninput=()=>key.setCustomValidity("");
  form.onsubmit=event=>{
    event.preventDefault();
    const value=key.value.trim();
    if (!value || /\s/.test(value)) {key.setCustomValidity("请输入完整的 API Key，请去掉空格或换行。");key.reportValidity();return;}
    try {
      saveSettings(service.value,{model:model.value,key:value,remember:remember.checked});
      dialog.close();
    } catch(e) { error.textContent=e.message; }
  };
  clear.onclick=()=>{
    try {saveSettings(service.value,null);selectService();error.textContent="已清除该服务的 Key。";}
    catch(e){error.textContent=e.message;}
  };
  dialog.querySelector("[data-close]").onclick=()=>dialog.close();
  const current=dialog;
  current.addEventListener("close",()=>{current.remove();if(dialog===current)dialog=null;},{once:true});
  dialog.showModal();
}

const rounded = (value,digits=1) => Number.isFinite(value)?Number(value.toFixed(digits)):null;
function reading(moment) {
  return {label:moment.label,studentAngle:rounded(moment.studentAngle),referenceAngle:rounded(moment.referenceAngle),delta:rounded(moment.delta)};
}

export function buildEvidence({assessment:a,studentPose,referencePose},question="") {
  const cards=a.moments.map((moment,i)=>({id:"E"+(i+1),label:moment.label,studentTime:rounded(moment.studentTime,3),
    referenceTime:rounded(moment.referenceTime,3),angles:[reading(moment)]}));
  // 用户点名的练习时刻即使不在突出差异榜上，也按相同对齐路径查询。
  const time=question.match(/(?:(\d+)\s*分\s*)?(\d+(?:\.\d+)?)\s*秒/);
  if (time) {
    const frame=evidenceAt(referencePose,studentPose,a.alignment,Number(time[1]||0)*60+Number(time[2]));
    cards.push({id:"T",label:"指定时刻",studentTime:rounded(frame.studentTime,3),
      referenceTime:rounded(frame.referenceTime,3),angles:frame.angles.map(reading)});
  }
  return {scores:{overall:rounded(a.overall),body:rounded(a.body),leftWrist:rounded(a.left),rightWrist:rounded(a.right)},
    measuredFrames:a.measured,sampledStudentFrames:studentPose.frames.length,studentSeconds:rounded(studentPose.duration,2),
    referenceSeconds:rounded(referencePose.duration,2),cards};
}

function serviceError(code) {
  if (code===401 || code===403) return "服务拒绝了这组凭据。请核对所选服务的 API Key 和模型权限。";
  if (code===402) return "服务账号余额不足，请检查该账号的余额。";
  if (code===429) return "服务用量或请求频率已达限制，请检查额度或稍后重试。";
  if (code>=500) return "模型服务暂时不可用，请稍后重试。";
  return "模型服务未接受请求（HTTP "+code+"），请核对服务和模型设置。";
}

export async function generateCoach({service,model,key,mode,evidence,question,history,signal}) {
  const spec=services[service];
  const payload={evidence};
  if (mode==="chat") {
    payload.question=question;
    payload.previous=(history || []).slice(-3).map(turn=>({question:turn.question,answer:turn.text}));
  }
  const body={model,messages:[{role:"system",content:systemPrompt+instructions[mode]},
    {role:"user",content:JSON.stringify(payload)}],response_format:{type:"json_object"},stream:false};
  if (service==="deepseek") {body.thinking={type:"disabled"};body.max_tokens=mode==="chat"?1100:2400;}
  else body.enable_thinking=false;
  let response;
  try {
    response=await fetch(spec.url,{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},
      body:JSON.stringify(body),signal,credentials:"omit",redirect:"error",referrerPolicy:"no-referrer",cache:"no-store"});
  } catch(e) {
    if (signal.aborted) throw e;
    throw Error("未能连接"+spec.name+"，请检查网络后重试。");
  }
  if (!response.ok) throw Error(serviceError(response.status));
  let result;
  try {
    const data=await response.json(),choice=data.choices?.[0];
    if (choice?.finish_reason==="stop") result=JSON.parse(choice.message.content);
  } catch(e) { if(signal.aborted) throw e; }
  if (typeof result?.text!=="string" || !result.text.trim() || !Array.isArray(result.citations))
    throw Error("模型未返回完整的教练内容，请重新生成。");
  // 可点击引用必须由本机记录解析，模型给出的时间或链接不作为回放地址。
  const ids=new Set(result.citations);
  const citations=evidence.cards.filter(card=>ids.has(card.id)).map(({label,studentTime,referenceTime})=>({label,studentTime,referenceTime}));
  return {text:result.text.trim(),model,citations};
}

export function mountCoach(host,{assessment,studentPose,referencePose,seek,saved,onChange}) {
  loadSettings();
  const events=new AbortController();
  const listen=(node,type,fn)=>node.addEventListener(type,fn,{signal:events.signal});
  let current="review",report={...saved,chat:saved?.chat || []},pending=null,needsSave=false;
  host.classList.add("panel","phone-coach");
  host.innerHTML=`
    <div class="coach-heading"><h2>AI 动作教练</h2><button type="button" data-settings>AI 服务设置</button></div>
    <p class="coach-hint" data-service></p>
    <div class="coach-modes" role="group" aria-label="教练功能"></div>
    <div data-result></div>
    <label class="coach-question" hidden>你的问题<textarea rows="2" maxlength="800" placeholder="例如，第 3 秒的右膝与示范相差多少？"></textarea></label>
    <div class="coach-actions"><button type="button" class="primary" data-generate></button><button type="button" data-cancel hidden>取消请求</button><button type="button" data-retry hidden>重试保存</button></div>
    <p data-status role="status"></p>`;
  const area=host.querySelector("[data-result]"),modes=host.querySelector(".coach-modes");
  const generate=host.querySelector("[data-generate]"),cancel=host.querySelector("[data-cancel]");
  const status=host.querySelector("[data-status]"),retry=host.querySelector("[data-retry]");
  const field=host.querySelector("textarea"),serviceLabel=host.querySelector("[data-service]");

  function showService() {
    const spec=services[activeService],profile=profiles[activeService];
    const model=profile?.model || spec.models[0];
    serviceLabel.textContent=spec.name+" · "+model+"。生成时发送该学生的评分和动作证据。提问会附上最近三轮问答。视频留在设备上。";
  }

  function renderAnswer(item) {
    const answer=el("article",null,"coach-answer");
    if (item.question) answer.append(el("h3",item.question));
    answer.append(el("p",item.text,"coach-prose"),el("small","模型 · "+item.model));
    if (seek && item.citations?.length) {
      const links=el("div",null,"coach-citations");
      for (const card of item.citations) {
        const button=el("button","回看 "+card.studentTime.toFixed(2)+" 秒 · "+card.label);
        button.type="button";
        button.onclick=()=>{
          seek(card.studentTime);
          host.closest("#review")?.querySelector(".videos")?.scrollIntoView({block:"start"});
        };
        links.append(button);
      }
      answer.append(links);
    }
    return answer;
  }

  function render() {
    for (const button of modes.children) button.setAttribute("aria-pressed",String(button.dataset.mode===current));
    host.querySelector(".coach-question").hidden=current!=="chat";
    const responses=current==="chat"?report.chat:(report[current]?[report[current]]:[]);
    area.replaceChildren(...responses.map(renderAnswer));
    generate.textContent=current==="chat"?"发送问题":(responses.length?"重新生成":"生成")+tabs[current];
    generate.disabled=Boolean(pending);
    retry.hidden=!needsSave;
    retry.disabled=Boolean(pending);
  }

  function feedback(message,error=false) {
    status.textContent=message;
    status.classList.toggle("coach-error",error);
  }

  async function persist() {
    if (!onChange) return;
    try {
      await onChange(report);
      needsSave=false;
    } catch {
      needsSave=true;
      feedback("已生成，但未能写入这份学生记录。请在离开前重试保存。",true);
    }
    retry.hidden=!needsSave;
  }

  for (const [mode,title] of Object.entries(tabs)) {
    const button=el("button",title);
    button.type="button";button.dataset.mode=mode;
    listen(button,"click",()=>{current=mode;if(!pending && !needsSave)feedback("");render();});
    modes.append(button);
  }
  listen(host.querySelector("[data-settings]"),"click",openCoachSettings);
  listen(window,"motioncoach-ai-settings",showService);
  listen(cancel,"click",()=>pending?.abort());
  listen(retry,"click",async()=>{
    pending=new AbortController();render();
    await persist();
    pending=null;
    if (!needsSave) feedback("已保存到本机学生记录。");
    render();
  });
  listen(generate,"click",async()=>{
    if (pending) return;
    const mode=current,question=mode==="chat"?field.value.trim():"",service=activeService,profile=profiles[service];
    if (mode==="chat" && !question) {feedback("请先输入想问的动作或时刻。",true);field.focus();return;}
    if (!profile) {feedback("请先配置此服务的 API Key，然后再次点生成。");openCoachSettings();return;}
    const controller=new AbortController();
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},90000);
    pending=controller;cancel.hidden=false;
    feedback("正在向"+services[service].name+"请求"+tabs[mode]+"…");render();
    try {
      const evidence=buildEvidence({assessment,studentPose,referencePose},question);
      const answer=await generateCoach({service,model:profile.model,key:profile.key,mode,evidence,
        question,history:report.chat,signal:controller.signal});
      if (controller.signal.aborted || events.signal.aborted) return;
      if (mode==="chat") {
        report={...report,chat:[...report.chat,{...answer,question}]};
        if (field.value.trim()===question) field.value="";
      } else report={...report,[mode]:answer};
      clearTimeout(timer);cancel.hidden=true;
      feedback("");render();
      await persist();
    } catch(e) {
      if (!events.signal.aborted) {
        if (controller.signal.aborted) feedback(timedOut?"等待模型超时，请稍后重新生成。":"已取消请求。",timedOut);
        else feedback(e.message,true);
      }
    } finally {
      clearTimeout(timer);pending=null;
      if (!events.signal.aborted) {cancel.hidden=true;render();}
    }
  });
  showService();render();
  // 打开其他学生或离开本页时中断未完成的请求，上一份回答不会覆盖新学生。
  return {close(){events.abort();pending?.abort();}};
}
