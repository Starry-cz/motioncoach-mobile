// 直接使用视频原画幅宽高比，避免竖屏视频的肘角在归一化坐标中被拉伸。
const labels = ["躯干侧倾","左髋角","右髋角","左膝角","右膝角","左肘角","右肘角","左臂上举角","右臂上举角",
  "左上臂方向","右上臂方向","肩线倾斜"];
export const ASSESSMENT_VERSION = 4;
const noticeableDegrees = 12;
const standardParts = [
  {key:"body",label:"身体",scale:90},
  {key:"leftWrist",label:"左腕",scale:1},
  {key:"rightWrist",label:"右腕",scale:1},
];
const upperParts = [
  {key:"shoulders",label:"肩线",scale:90},
  {key:"leftArm",label:"左臂",scale:90},
  {key:"rightArm",label:"右臂",scale:90},
];
const motionBones = [
  ["r_shoulder","l_shoulder"],
  ["l_shoulder","l_elbow"],["l_elbow","l_wrist"],["r_shoulder","r_elbow"],["r_elbow","r_wrist"],
  ["l_hip","l_knee"],["l_knee","l_ankle"],["r_hip","r_knee"],["r_knee","r_ankle"],
];
function angle(a,b,c) {
  if (!a || !b || !c) return NaN;
  const ax=a.x-b.x, ay=a.y-b.y, cx=c.x-b.x, cy=c.y-b.y;
  const dot=(ax*cx+ay*cy)/(Math.hypot(ax,ay)*Math.hypot(cx,cy));
  return 180/Math.PI*Math.acos(Math.max(-1,Math.min(1,dot)));
}
function describe(frame,aspect) {
  const p={};
  for(const [key,point] of Object.entries(frame.points)) {
    // 模型也会外推画面之外的点，裁切画面只使用真实入镜的关节点。
    if(point.confidence>=0.60 && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1) {
      p[key]={x:point.x*aspect,y:point.y};
    }
  }
  const angles=Array(labels.length).fill(NaN), ends=[];
  const {l_hip:lh,r_hip:rh,l_shoulder:ls,r_shoulder:rs}=p;
  const center=lh && rh?{x:(lh.x+rh.x)/2,y:(lh.y+rh.y)/2}:null;
  let torso=0;
  if(ls && rs) {
    if(Math.abs(ls.x-rs.x)>=.015) angles[11]=Math.atan2(rs.y-ls.y,Math.abs(ls.x-rs.x))*180/Math.PI;
    if(center) {
      const dx=(ls.x+rs.x)/2-center.x,dy=(ls.y+rs.y)/2-center.y;
      torso=Math.hypot(dx,dy);
      if(torso>=.01) angles[0]=Math.atan2(dx*Math.sign(lh.x-rh.x),-dy)*180/Math.PI;
    }
  }
  for(const [i,side] of ["l","r"].entries()) {
    const [s,e,w,h,k,a]=["shoulder","elbow","wrist","hip","knee","ankle"].map(j=>p[side+"_"+j]);
    angles[1+i]=angle(s,h,k); angles[3+i]=angle(h,k,a);
    angles[5+i]=angle(s,e,w); angles[7+i]=angle(h,s,e);
    // 没有髋点时，单独测上臂与画面竖直向下的夹角，避免把它当作躯干参照角。
    if(s && e) angles[9+i]=angle({x:s.x,y:s.y+1},s,e);
    if(torso>=.01) {
      if(w) ends[i]=[(w.x-center.x)/torso,(w.y-center.y)/torso];
      if(a) ends[2+i]=[(a.x-center.x)/torso,(a.y-center.y)/torso];
    }
  }
  // 每根骨段独立提供运动方向，半身画面找不到髋点时仍可用肩、肘、腕作时间对应。
  const directions=motionBones.map(([from,to])=>{
    const a=p[from],b=p[to];
    if(!a || !b) return null;
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    return length>=.015?[dx/length,dy/length]:null;
  });
  return {angles,ends,directions};
}
function dist(a,b) {return a&&b ? Math.hypot(a[0]-b[0],a[1]-b[1]) : NaN;}

function closestFrames(frames,times) {
  let index=0;
  return times.map(time=>{
    while(index+1<frames.length && Math.abs(frames[index+1].time-time)<Math.abs(frames[index].time-time)) index++;
    return index;
  });
}

function motionSequence(clip,poses,divisions) {
  const timestamps=Array.from({length:divisions+1},(_,i)=>clip.duration*i/divisions);
  return closestFrames(clip.frames,timestamps).map(index=>{
    const pose=poses[index];
    return [...pose.directions,...Array.from({length:4},(_,i)=>pose.ends[i])];
  });
}

function matchCost(a,b,weights) {
  let count=0,sum=0,weight=0;
  for(let feature=0;feature<a.length;feature++) {
    const d=dist(a[feature],b[feature]);
    if(!Number.isFinite(d)) continue;
    count++;
    weight+=weights[feature];
    sum+=weights[feature]*Math.min(d,1.4);
  }
  if(!count) return a.some(Boolean) ? .65 : 0;
  const strength=Math.min(1,count/3);
  return strength*sum/weight+(1-strength)*.40;
}

function motionWeights(reference,student) {
  return reference[0].map((_,i)=>{
    let change=0,pairs=0;
    for(const sequence of [reference,student]) {
      for(let n=1;n<sequence.length;n++) {
        const d=dist(sequence[n][i],sequence[n-1][i]);
        if(Number.isFinite(d)){change+=Math.min(d,1);pairs++;}
      }
    }
    // 挥动中的肢段比静止的肩线更能区分动作时刻。腕、踝相对髋的位置仍提供辅助信息。
    const importance=.55+Math.min(1.45,10*change/Math.max(1,pairs));
    return i<motionBones.length?importance:importance*.74;
  });
}

function align(reference,student,ref,stu) {
  const steps=Math.min(160,Math.max(ref.length,stu.length)-1);
  if(steps<2) return [[0,0],[student.duration,reference.duration]];
  const subdivisions=3,maxStep=8;
  const r=motionSequence(reference,ref,steps*subdivisions),s=motionSequence(student,stu,steps);
  const w=r.length,h=s.length,end=w-1;
  const weights=motionWeights(r,s);
  const cost=new Float64Array(w*h).fill(Infinity),parent=new Uint8Array(w*h);
  cost[0]=0;
  // 约束示范时间只向前走。无可见动作时，步幅代价把两边拉回接近全片进度，不留空白和停顿。
  for(let i=1;i<h;i++) {
    const expected=i*subdivisions,band=Math.ceil(end*.30);
    const remaining=steps-i;
    const first=Math.max(i,end-maxStep*remaining,expected-band);
    const last=Math.min(i*maxStep,end-remaining,expected+band);
    for(let j=first;j<=last;j++) {
      const cell=i*w+j;
      let best=Infinity;
      for(let step=1;step<=maxStep && step<=j;step++) {
        const candidate=cost[cell-w-step]+.027*(step-subdivisions)**2;
        if(candidate<best){best=candidate;parent[cell]=step;}
      }
      if(Number.isFinite(best)) cost[cell]=best+matchCost(s[i],r[j],weights)+.42*Math.abs(j-expected)/end;
    }
  }
  const path=Array(h);
  for(let i=steps,j=end;i>=0;i--) {
    path[i]=j;
    j-=parent[i*w+j];
  }
  // 三点平滑只作用在内部，保留两个原片的起点和终点。
  return path.map((j,i)=>[
    student.duration*i/steps,
    reference.duration*(i===0||i===steps?j:(path[i-1]+2*j+path[i+1])/4)/end,
  ]);
}

function sampledAlignment(reference,student,playback) {
  let segment=0;
  const times=student.frames.map(frame=>{
    while(segment+2<playback.length && frame.time>playback[segment+1][0]) segment++;
    const [from,base]=playback[segment],[to,target]=playback[segment+1];
    return base+(target-base)*Math.max(0,Math.min(1,(frame.time-from)/(to-from)));
  });
  return closestFrames(reference.frames,times);
}
function angleDifference(a,b,index) {
  const delta=Math.abs(a-b);
  return index===0 ? Math.min(delta,360-delta) : delta;
}

function pairAngles(a,b) {
  return labels.flatMap((label,i)=>{
    // 只有主指标不能同时测得时，才显示取景裁切下的替代测量。
    if(i>=9 && i<=10 && Number.isFinite(a.angles[i-2]) && Number.isFinite(b.angles[i-2])) return [];
    if(i===11 && Number.isFinite(a.angles[0]) && Number.isFinite(b.angles[0])) return [];
    const studentAngle=a.angles[i],referenceAngle=b.angles[i],delta=angleDifference(studentAngle,referenceAngle,i);
    return Number.isFinite(delta)?[{metric:i,label,studentAngle,referenceAngle,delta}]:[];
  });
}

// 问到具体秒数时，沿用评分已对齐的实测画面和同一套可见度、角度定义。
export function evidenceAt(reference,student,alignment,seconds) {
  if(seconds<0 || seconds>student.duration) throw Error("提问的时刻超出练习范围，请输入 0 至 "+student.duration.toFixed(2)+" 秒。");
  const frames=student.frames;
  let index=0;
  while(index+1<frames.length && Math.abs(frames[index+1].time-seconds)<Math.abs(frames[index].time-seconds)) index++;
  return evidenceForFrame(reference,student,alignment,index);
}

// 进步追踪已持有学生采样序号，直接复用问答的角差定义，无需再次扫描时间轴。
export function evidenceForFrame(reference,student,alignment,index) {
  const stu=student.frames[index],ref=reference.frames[alignment[index]];
  const a=describe(stu,student.aspectRatio),b=describe(ref,reference.aspectRatio);
  return {studentTime:stu.time,referenceTime:ref.time,angles:pairAngles(a,b).map(({metric,...reading})=>reading)};
}

function finishRun(stat) {
  const run=stat.run;
  if(run?.count>=3 && run.end-run.start>=.3) {
    const meanDelta=run.sum/run.count;
    const priority=meanDelta*.7+run.peak.delta*.3+8;
    if(!stat.interval || priority>stat.interval.priority) {
      stat.interval={...run.peak,range:{start:run.start,end:run.end},observations:run.count,meanDelta,priority,
        direction:Math.abs(run.direction)/run.count>=.8?Math.sign(run.direction):0};
    }
  }
  stat.run=null;
}

const seconds=time=>time.toFixed(2)+" 秒";
const degrees=angle=>angle.toFixed(1)+"°";

function maxDifferenceText(moment) {
  return "练习 "+seconds(moment.studentTime)+" 相比示范 "+seconds(moment.referenceTime)+
    " 相差 "+degrees(moment.delta)+"（练习 "+degrees(moment.studentAngle)+"，示范 "+degrees(moment.referenceAngle)+"）。";
}

function cue({metric,direction}) {
  const side=metric%2?"左":"右";
  if(metric===5 || metric===6) {
    if(direction>0) return "到这个位置时把"+side+"肘多收一点，再从上一拍接进来。";
    if(direction<0) return "让"+side+"肘多打开一点，注意手腕跟着前臂走。";
    return "分开对照前臂的起点和终点，再把弯肘、伸肘接起来。";
  }
  if(metric===7 || metric===8 || metric===9 || metric===10) {
    if(direction>0) return "试着把"+side+"上臂放低一点到位，回看肩到肘的连线。";
    if(direction<0) return "让"+side+"肘再往示范的高度送一点，到位后继续接下一拍。";
    return "跟一遍肩到肘的路线，重点对照这一拍的高度和朝向。";
  }
  if(metric===3 || metric===4) {
    if(direction>0) return "试着把"+side+"膝再弯一点，先定住这个姿势，再练进出这个动作。";
    if(direction<0) return "试着让"+side+"膝少弯一点，先慢速找到接近示范的角度。";
    return "慢速对照弯膝和伸开的顺序，先练前后一拍怎样接起来。";
  }
  if(metric===1 || metric===2) return "并排停住，先对齐躯干和大腿形成的夹角，再练着从上一拍进入。";
  if(metric===11) return "并排暂停看两肩的高低，慢做一遍，观察肩线在这一拍怎样变化。";
  return "跟着示范把身体慢慢带到对应的倾斜位置，接上前后两拍再试一次。";
}

function recommend({moments,metrics,points,sampled,measured,scoreMode}) {
  const stable=metrics.filter(item=>item.frames>=Math.max(3,sampled*.45) && item.stable/item.frames>=.8)
    .sort((a,b)=>b.stable-a.stable || a.meanDelta-b.meanDelta)[0];
  const coverageNote=scoreMode==="upper" ? "仅按两段画面中共同可测的肩线和手臂评分。"
    : scoreMode==="unavailable" ? "共同可测的动作片段不足以评分，仍可同步回看。"
    : points.partial ? "评分取自两段画面中共同可测的关节。" : "";
  const insights=moments.slice(0,3).map((moment,momentIndex)=>{
    const pattern=moment.range
      ? "练习 "+moment.range.start.toFixed(2)+"–"+seconds(moment.range.end)+" 连续 "+moment.observations+" 个采样点存在角差，平均 "+degrees(moment.meanDelta)+"。"
      : "";
    const action=cue(moment);
    return {title:moment.label,text:pattern+maxDifferenceText(moment)+action,cue:action,momentIndex};
  });
  const key=moments[0];
  if(!key && measured) insights.push({title:"连起来看",text:"先用半速把示范和练习并排走一遍。挑一个转向或换手，暂停对照起点、经过位置和收势，再完整做一次。"});
  if(stable) {
    const scope=stable.frames>=sampled*.9?"大部分画面":"测到的多数画面";
    insights.push({title:"可以保持的动作",text:stable.label+"在"+scope+"都接近示范。练其他部位时，顺带用这条线检查原来做顺的动作有没有变形。"});
  }
  const summary=key
    ? (key.range?"先练 "+key.range.start.toFixed(2)+"–"+seconds(key.range.end)+" 的"+key.label+"。":"先在 "+seconds(key.studentTime)+" 停一下，看"+key.label+"。")
    : "先同步回看全段，对照起势、过渡和收势，选一处想先练的动作。";
  const steps=key
    ? [
      {title:"先跟一遍",text:"用半速跟完整示范一遍。走到重点前一拍时放慢，留意这一下是从哪里带过来的。",momentIndex:0},
      {title:"拆开练三遍",text:"把重点和前后各一拍设为 A–B 循环。"+cue(key)+"每一遍到位后停一拍。",momentIndex:0},
      {title:"接回整段",text:"半速连过两遍，再用原速试一遍。若一提速就偏，退回上一拍，只重练这次过渡。"+(moments[1]?"做顺以后再看"+seconds(moments[1].studentTime)+"的"+moments[1].label+"。":""),momentIndex:moments[1]?1:0},
      {title:"录一遍复测",text:"沿用同一份示范和机位录完整原速。回看相同示范时刻，先核对"+key.label+"是否更接近，再看前后动作能不能连上。",momentIndex:0}
    ]
    : [
      {title:"先跟一遍",text:"半速同步回看两段，挑一个动作的起点和收势。"},
      {title:"连练两轮",text:"暂停看清一个位置，从前一拍带进来，再接下一拍。能连着做两遍以后提到原速。"},
      {title:"录一遍复测",text:"用同一机位再录一遍，放在一起回看这个动作能不能接上前后两拍。"}
    ];
  return {summary,coverageNote,insights,steps};
}

function measure(reference,student,r,s,playback) {
  const alignment=sampledAlignment(reference,student,playback);
  const rt=reference.frames.map(f=>f.time),st=student.frames.map(f=>f.time);
  const scoreStats=[...standardParts,...upperParts].map(part=>({...part,sum:0,samples:0,lastRef:-1,distinctRef:0}));
  const stats=labels.map(label=>({label,frames:0,sum:0,stable:0,differenceFrames:0}));
  const maxGap=Math.max(.25,1.6*student.duration/Math.max(1,st.length-1));
  const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:NaN;
  let standardMeasured=0,upperMeasured=0,anglesMeasured=0;
  s.forEach((a,i)=>{
    const ri=alignment[i],b=r[ri],body=[],arms=[[],[]];
    const readings=pairAngles(a,b);
    if(readings.length) anglesMeasured++;
    for(const reading of readings) {
      const {metric,delta,studentAngle,referenceAngle}=reading, stat=stats[metric];
      stat.frames++;stat.sum+=delta;
      if(delta<=8) stat.stable++;
      if(metric<5) body.push(delta);
      if(metric>=5 && metric<=10) arms[metric%2===1?0:1].push(delta);
      if(delta<3) continue;
      const direction=metric===0 || metric===11?0:Math.sign(studentAngle-referenceAngle);
      const point={...reading,studentIndex:i,referenceIndex:ri,studentTime:st[i],referenceTime:rt[ri],direction};
      if(!stat.peak || delta>stat.peak.delta) stat.peak=point;
      if(delta<noticeableDegrees) continue;
      stat.differenceFrames++;
      if(stat.run && (stat.run.index!==i-1 || st[i]-stat.run.end>maxGap)) finishRun(stat);
      const run=stat.run ??= {count:0,sum:0,start:st[i],direction:0,peak:point};
      run.count++;run.sum+=delta;run.direction+=direction;run.end=st[i];run.index=i;
      if(delta>run.peak.delta) run.peak=point;
    }
    // 上半身评分独立于髋点。肩线可测时直接取两边角差，手臂只用两边都看到的角度。
    const shoulders=angleDifference(a.angles[11],b.angles[11],11);
    const fullErrors=[mean(body),dist(a.ends[0],b.ends[0]),dist(a.ends[1],b.ends[1])];
    const upperErrors=[shoulders,mean(arms[0]),mean(arms[1])];
    [...fullErrors,...upperErrors].forEach((error,index)=>{
      if(!Number.isFinite(error))return;
      const part=scoreStats[index];
      part.sum+=error;part.samples++;
      if(part.lastRef!==ri){part.lastRef=ri;part.distinctRef++;}
    });
    if(fullErrors.some(Number.isFinite))standardMeasured++;
    if(upperErrors.some(Number.isFinite))upperMeasured++;
  });
  stats.forEach(finishRun);
  // 单个测量或反复落在同一示范画面的瞬时结果不能代表一整段得分。
  const parts=scoreStats.map(({key,label,scale,sum,samples,distinctRef})=>({
    key,label,samples,value:samples>=3 && distinctRef>=2 ? 100*Math.max(0,1-sum/samples/scale) : null,
  }));
  const full=parts.slice(0,standardParts.length),upper=parts.slice(standardParts.length);
  const moments=stats.flatMap(stat=>stat.interval?[stat.interval]:stat.peak?[{...stat.peak,range:null,observations:1,
    meanDelta:stat.peak.delta,priority:stat.peak.delta*.8}]:[])
    .sort((a,b)=>b.priority-a.priority).slice(0,4).map(({priority,...point})=>point);
  const sampled=s.length;
  const metrics=stats.map(({label,frames,sum,stable,differenceFrames})=>({label,frames,meanDelta:frames?sum/frames:null,stable,differenceFrames}));
  const legs=Math.min(...stats.slice(3,5).map(stat=>stat.frames))>=Math.max(1,sampled*.25);
  const hasFull=full.some(part=>part.value!==null);
  const hasUpper=upper.some(part=>part.value!==null);
  const preferUpper=!hasFull || (!legs && upper.slice(1).some(part=>part.value!==null));
  const scoreMode=hasUpper && preferUpper ? "upper" : hasFull ? "standard" : "unavailable";
  const scoreParts=scoreMode==="upper"?upper:scoreMode==="standard"?full:[];
  const available=scoreParts.filter(part=>part.value!==null).map(part=>part.value);
  const overall=available.length?mean(available):null;
  const measured=scoreMode==="upper"?upperMeasured:scoreMode==="standard"?standardMeasured:Math.max(standardMeasured,upperMeasured);
  const partial=scoreMode!=="standard"||!legs||full.some(part=>part.value===null || part.samples<sampled*.65)||stats[0].frames<sampled*.65;
  const coverage={sampled,any:anglesMeasured,metrics,parts:{body:full[0].samples,left:full[1].samples,right:full[2].samples},legs,partial};
  const guidance=recommend({moments,metrics,points:coverage,sampled,measured,scoreMode});
  const advice=[guidance.summary,...guidance.insights.map(item=>item.text),guidance.coverageNote].filter(Boolean);
  const plan=guidance.steps.map(step=>step.title+"。"+step.text);
  return {version:ASSESSMENT_VERSION,alignment,playback,body:full[0].value,left:full[1].value,right:full[2].value,
    overall,scoreMode,scoreParts,measured,moments,coverage,guidance,advice,plan};
}

export function compare(reference,student) {
  if(!reference.frames.length || !student.frames.length) throw Error("视频中没有可读取的画面。");
  const r=reference.frames.map(f=>describe(f,reference.aspectRatio)),s=student.frames.map(f=>describe(f,student.aspectRatio));
  return measure(reference,student,r,s,align(reference,student,r,s));
}

export function refreshAssessment(reference,student,stored) {
  // 旧记录仍用原片坐标保存回看时间，以缓存的关节点重建整段同步路径。
  return stored.version===ASSESSMENT_VERSION ? stored : compare(reference,student);
}
