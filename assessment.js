// 直接使用视频原画幅宽高比，避免竖屏视频的肘角在归一化坐标中被拉伸。
const labels = ["躯干侧倾","左髋角","右髋角","左膝角","右膝角","左肘角","右肘角","左臂上举角","右臂上举角",
  "左上臂方向","右上臂方向","肩线倾斜"];
const assessmentVersion = 2;
const noticeableDegrees = 12;
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
  return {angles,ends};
}
function dist(a,b) {return a&&b ? Math.hypot(a[0]-b[0],a[1]-b[1]) : NaN;}
function anchors(n) {
  const size=Math.min(240,n);
  return Array.from({length:size},(_,i)=>size===1?0:Math.round(i*(n-1)/(size-1)));
}
function align(ref,stu,rt,st) {
  const r=anchors(ref.length),s=anchors(stu.length),w=r.length,h=s.length;
  if(Math.min(w,h)===1) return Array(stu.length).fill(0);
  const cost=new Float64Array(w*h).fill(Infinity),parent=new Uint8Array(w*h);
  // 在有限的时间带内比较腕踝轨迹；没有关键点的时刻仍按顺序播放完整原片。
  for(let i=0;i<h;i++) for(let j=0;j<w;j++) {
    const gap=Math.abs(i/(h-1)-j/(w-1));
    if(gap>0.24+1/Math.min(h-1,w-1)) continue;
    const a=stu[s[i]].ends,b=ref[r[j]].ends;
    let sum=0,n=0;
    for(let k=0;k<4;k++) {const d=dist(a[k],b[k]); if(Number.isFinite(d)){sum+=Math.min(d,3);n++;}}
    const local=(n>=2?sum/n:1)+0.35*gap, k=i*w+j;
    if(!k){cost[k]=local;continue;}
    let best=i&&j?cost[k-w-1]:Infinity;
    if(i && cost[k-w]+0.025<best){best=cost[k-w]+0.025;parent[k]=1;}
    if(j && cost[k-1]+0.025<best){best=cost[k-1]+0.025;parent[k]=2;}
    cost[k]=local+best;
  }
  const first=Array(h).fill(w-1),last=Array(h).fill(0);
  for(let i=h-1,j=w-1;;) {
    first[i]=Math.min(first[i],j);last[i]=Math.max(last[i],j);
    if(!i&&!j) break;
    const step=parent[i*w+j];if(step!==2)i--;if(step!==1)j--;
  }
  const pair=first.map((j,i)=>r[Math.floor((j+last[i])/2)]);
  pair[0]=0;pair[h-1]=ref.length-1;
  let segment=0,j=0;
  return st.map((time,i)=>{
    while(segment+2<h && i>s[segment+1]) segment++;
    const l=s[segment],u=s[segment+1],a=pair[segment],b=pair[segment+1];
    const t=(time-st[l])/(st[u]-st[l]||1),target=rt[a]+t*(rt[b]-rt[a]);
    j=Math.max(j,a);
    while(j<b && Math.abs(rt[j+1]-target)<Math.abs(rt[j]-target)) j++;
    return j;
  });
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

function recommend({moments,metrics,points,sampled,measured}) {
  const stable=metrics.filter(item=>item.frames>=Math.max(3,sampled*.45) && item.stable/item.frames>=.8)
    .sort((a,b)=>b.stable-a.stable || a.meanDelta-b.meanDelta)[0];
  const coverageNote=points.any===0?"两段里没有足够的共同关节点。重录时把要练的部位留在画面里。"
    :!points.legs?"本次下肢可测范围有限。要练脚步时，补一段全身录像。"
    :points.partial?"部分关节只在少数画面能同时测到。分数以可见部位为准。":"";
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
    : points.any?"先把测到的动作顺下来，回看一次起势、过渡和收势。":"先补一段能看清要练部位的录像。";
  const steps=key
    ? [
      {title:"先跟一遍",text:"用半速跟完整示范一遍。走到重点前一拍时放慢，留意这一下是从哪里带过来的。",momentIndex:0},
      {title:"拆开练三遍",text:"把重点和前后各一拍设为 A–B 循环。"+cue(key)+"每一遍到位后停一拍。",momentIndex:0},
      {title:"接回整段",text:"半速连过两遍，再用原速试一遍。若一提速就偏，退回上一拍，只重练这次过渡。"+(moments[1]?"做顺以后再看"+seconds(moments[1].studentTime)+"的"+moments[1].label+"。":""),momentIndex:moments[1]?1:0},
      {title:"录一遍复测",text:"沿用同一份示范和机位录完整原速。回看相同示范时刻，先核对"+key.label+"是否更接近，再看前后动作能不能连上。",momentIndex:0}
    ]
    : [
      {title:points.any?"先跟一遍":"补拍",text:points.any?"先用半速跟一遍示范，挑一段最容易丢掉起点或收势的地方。":"手机放稳，把要练的部位从动作起势到收势都拍进去。"},
      {title:"连练两轮",text:"暂停看清一个位置，从前一拍带进来，再接下一拍。能连着做两遍以后提到原速。"},
      {title:"录一遍复测",text:"用同一机位再录一遍，对照相同示范时刻。先看需要练的部位是否都能测到，再看动作到位的情况。"}
    ];
  return {summary,coverageNote,insights,steps};
}

function measure(reference,student,r,s,alignment) {
  const rt=reference.frames.map(f=>f.time),st=student.frames.map(f=>f.time);
  const sums=[0,0,0],counts=[0,0,0],stats=labels.map(label=>({label,frames:0,sum:0,stable:0,differenceFrames:0}));
  const maxGap=Math.max(.25,1.6*student.duration/Math.max(1,st.length-1));
  let measured=0,anglesMeasured=0;
  s.forEach((a,i)=>{
    const ri=alignment[i],b=r[ri],body=[];
    const readings=pairAngles(a,b);
    if(readings.length) anglesMeasured++;
    for(const reading of readings) {
      const {metric,delta,studentAngle,referenceAngle}=reading, stat=stats[metric];
      stat.frames++;stat.sum+=delta;
      if(delta<=8) stat.stable++;
      if(metric<5) body.push(delta);
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
    const errors=[body.length?body.reduce((x,y)=>x+y)/body.length:NaN,dist(a.ends[0],b.ends[0]),dist(a.ends[1],b.ends[1])];
    errors.forEach((v,k)=>{if(Number.isFinite(v)){sums[k]+=v;counts[k]++;}});
    if(errors.some(Number.isFinite)) measured++;
  });
  stats.forEach(finishRun);
  const parts=sums.map((sum,k)=>counts[k]?100*Math.max(0,1-sum/counts[k]/(k?1:90)):null);
  const moments=stats.flatMap(stat=>stat.interval?[stat.interval]:stat.peak?[{...stat.peak,range:null,observations:1,
    meanDelta:stat.peak.delta,priority:stat.peak.delta*.8}]:[])
    .sort((a,b)=>b.priority-a.priority).slice(0,4).map(({priority,...point})=>point);
  const available=parts.filter(v=>v!==null);
  const overall=available.length?available.reduce((a,b)=>a+b)/available.length:null;
  const sampled=s.length;
  const metrics=stats.map(({label,frames,sum,stable,differenceFrames})=>({label,frames,meanDelta:frames?sum/frames:null,stable,differenceFrames}));
  const legs=Math.min(...stats.slice(3,5).map(stat=>stat.frames))>=Math.max(1,sampled*.25);
  const partial=!legs||counts.some(count=>count<Math.max(1,sampled*.65))||stats[0].frames<sampled*.65;
  const coverage={sampled,any:anglesMeasured,metrics,parts:{body:counts[0],left:counts[1],right:counts[2]},legs,partial};
  const guidance=recommend({moments,metrics,points:coverage,sampled,measured});
  const advice=[guidance.summary,...guidance.insights.map(item=>item.text),guidance.coverageNote].filter(Boolean);
  const plan=guidance.steps.map(step=>step.title+"。"+step.text);
  return {version:assessmentVersion,alignment,body:parts[0],left:parts[1],right:parts[2],overall,measured,moments,coverage,guidance,advice,plan};
}

export function compare(reference,student) {
  if(!reference.frames.length || !student.frames.length) throw Error("视频中没有可读取的画面。");
  const r=reference.frames.map(f=>describe(f,reference.aspectRatio)),s=student.frames.map(f=>describe(f,student.aspectRatio));
  const rt=reference.frames.map(f=>f.time),st=student.frames.map(f=>f.time);
  const alignment=align(r,s,rt,st);
  return measure(reference,student,r,s,alignment);
}

export function refreshAssessment(reference,student,stored) {
  if(stored.version===assessmentVersion) return stored;
  // 复用原来的对齐路径，使已有 AI 评语和问答里的回看时间仍可定位。
  const r=reference.frames.map(f=>describe(f,reference.aspectRatio)),s=student.frames.map(f=>describe(f,student.aspectRatio));
  return measure(reference,student,r,s,stored.alignment);
}
