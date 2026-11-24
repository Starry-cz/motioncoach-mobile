// 直接使用视频原画幅宽高比，避免竖屏视频的肘角在归一化坐标中被拉伸。
const labels = ["躯干侧倾","左髋角","右髋角","左膝角","右膝角","左肘角","右肘角","左臂上举角","右臂上举角"];
function angle(a,b,c) {
  if (!a || !b || !c) return NaN;
  const ax=a.x-b.x, ay=a.y-b.y, cx=c.x-b.x, cy=c.y-b.y;
  const dot=(ax*cx+ay*cy)/(Math.hypot(ax,ay)*Math.hypot(cx,cy));
  return 180/Math.PI*Math.acos(Math.max(-1,Math.min(1,dot)));
}
function describe(frame,aspect) {
  const p={};
  for(const [key,point] of Object.entries(frame.points)) {
    if(point.confidence>=0.60) p[key]={x:point.x*aspect,y:point.y};
  }
  const angles=Array(9).fill(NaN), ends=[];
  const {l_hip:lh,r_hip:rh,l_shoulder:ls,r_shoulder:rs}=p;
  if(!lh || !rh || !ls || !rs) return {angles,ends};
  const hx=(lh.x+rh.x)/2, hy=(lh.y+rh.y)/2;
  const dx=(ls.x+rs.x)/2-hx, dy=(ls.y+rs.y)/2-hy, torso=Math.hypot(dx,dy);
  if(torso<0.01) return {angles,ends};
  angles[0]=Math.atan2(dx*Math.sign(lh.x-rh.x),-dy)*180/Math.PI;
  for(const [i,side] of ["l","r"].entries()) {
    const [s,e,w,h,k,a]=["shoulder","elbow","wrist","hip","knee","ankle"].map(j=>p[side+"_"+j]);
    angles[1+i]=angle(s,h,k); angles[3+i]=angle(h,k,a);
    angles[5+i]=angle(s,e,w); angles[7+i]=angle(h,s,e);
    if(w) ends[i]=[(w.x-hx)/torso,(w.y-hy)/torso];
    if(a) ends[2+i]=[(a.x-hx)/torso,(a.y-hy)/torso];
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
  return {studentTime:stu.time,referenceTime:ref.time,angles:labels.flatMap((label,i)=>{
    const delta=angleDifference(a.angles[i],b.angles[i],i);
    return Number.isFinite(delta)?[{label,studentAngle:a.angles[i],referenceAngle:b.angles[i],delta}]:[];
  })};
}

export function compare(reference,student) {
  if(!reference.frames.length || !student.frames.length) throw Error("视频中没有可读取的画面。");
  const r=reference.frames.map(f=>describe(f,reference.aspectRatio)),s=student.frames.map(f=>describe(f,student.aspectRatio));
  const rt=reference.frames.map(f=>f.time),st=student.frames.map(f=>f.time);
  const alignment=align(r,s,rt,st),sums=[0,0,0],counts=[0,0,0],peaks=Array(9);
  let measured=0;
  s.forEach((a,i)=>{
    const ri=alignment[i],b=r[ri],body=[];
    a.angles.forEach((v,k)=>{
      const delta=angleDifference(v,b.angles[k],k);
      if(!Number.isFinite(delta)) return;
      if(k<5) body.push(delta);
      if(delta>=3 && (!peaks[k]||delta>peaks[k].delta)) peaks[k]={studentIndex:i,referenceIndex:ri,label:labels[k],delta,
        studentAngle:v,referenceAngle:b.angles[k],studentTime:st[i],referenceTime:rt[ri]};
    });
    const errors=[body.length?body.reduce((x,y)=>x+y)/body.length:NaN,dist(a.ends[0],b.ends[0]),dist(a.ends[1],b.ends[1])];
    errors.forEach((v,k)=>{if(Number.isFinite(v)){sums[k]+=v;counts[k]++;}});
    if(errors.some(Number.isFinite)) measured++;
  });
  const parts=sums.map((sum,k)=>counts[k]?100*Math.max(0,1-sum/counts[k]/(k?1:90)):null);
  const available=parts.filter(v=>v!==null), moments=peaks.filter(Boolean).sort((a,b)=>b.delta-a.delta).slice(0,4);
  const overall=available.length?available.reduce((a,b)=>a+b)/available.length:null;
  const names=["身体","左腕","右腕"],focus=names.filter((_,k)=>parts[k]!==null && parts[k]<=Math.min(...available)+3);
  const target=focus.length===3?"全身的过渡动作":focus.join("和")+"的动作";
  let advice,plan;
  if(measured>1) {
    const scores=names.flatMap((n,k)=>parts[k]===null?[]:[n+" "+parts[k].toFixed(1)+" 分"]).join("、");
    const p=moments[0],when=p?p.studentTime.toFixed(2)+" 秒的"+p.label:"一次换向或换手";
    advice=["本次有 "+measured+" 个学生画面能与示范比较，"+scores+"。下一遍先练"+target+"，留意动作怎样从上一拍进入、又怎样接到下一拍。",
      p?"回看练习 "+when+"，此处相差约 "+p.delta.toFixed(1)+"°。示范与练习并排暂停，先对照身体朝向和关节位置，再退回上一个姿势，把这段过渡慢慢连起来。":"已测角度中没有突出的定格差异，可以挑一次转向，把起势、经过位置和收势慢慢连接起来。",
      "恢复原速后再录一遍。用同一机位和同一份示范，对照两次报告，看练到的细节能否在整段里重复做到。"];
    plan=["分练。定位到"+when+"，松开暂停跟做两遍，能稳定到达同一位置后进入连练。",
      "连练。把重点及其前后各一个动作串起来，先半速再原速。若一提速又偏开，缩短片段，再接回完整组合。",
      "复测。独立录一遍完整动作，回看相同示范时刻。两次原速录像都能做到，再换下一个练习重点。"];
  } else {
    advice=["这次只有 "+measured+" 个时刻能同时测到两侧身体或手腕。先把手脚、起势和收势拍全，再用相近机位复录。"];
    plan=["补录。每份学生视频聚焦一个人，手脚始终留在画面内。","慢练。找一段两边都能看清的过渡，从上一姿势连到下一姿势。","复测。使用同一示范重新分析，用连续可测的录像作为下一轮起点。"];
  }
  return {alignment,body:parts[0],left:parts[1],right:parts[2],overall,measured,moments,advice,plan};
}
