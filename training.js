import {listPractices, openPractice, saveCoaching} from "./library.js";
import {evidenceForFrame} from "./assessment.js";

function sameReference(a, b) {
  const x = a.referencePose, y = b.referencePose;
  if (x.duration !== y.duration || x.aspectRatio !== y.aspectRatio || x.frames.length !== y.frames.length) return false;
  if (a.summary.id === b.summary.id) return true;
  if (a.summary.standardId && a.summary.standardId === b.summary.standardId) {
    return x.frames.every((frame, index) => frame.time === y.frames[index].time);
  }
  // 旧记录没有标准库编号。比较全部示范采样和骨架，避免把同名但不同的动作并作一组。
  return x.frames.every((frame, index) => frame.time === y.frames[index].time &&
    JSON.stringify(frame.points) === JSON.stringify(y.frames[index].points));
}

function anglesByReference(clip) {
  const {pose, assessment} = clip.report, groups = new Map();
  // 一个示范时刻可能对应多个学生采样。取这一组的平均角差和最明显的学生原片时刻。
  assessment.alignment.forEach((refIndex, index) => {
    const sample = evidenceForFrame(clip.referencePose, pose, assessment.alignment, index);
    if (!groups.has(refIndex)) groups.set(refIndex, new Map());
    const group = groups.get(refIndex);
    for (const {label, delta} of sample.angles) {
      const values = group.get(label) || {sum:0, count:0, peak:-1, time:0};
      values.sum += delta;
      values.count++;
      if (delta > values.peak) { values.peak = delta; values.time = sample.studentTime; }
      group.set(label, values);
    }
  });
  return groups;
}

export function compareAttempts(first, second) {
  if (!sameReference(first, second)) throw Error("两次练习的示范或采样时序不同。请选用同一份标准示范的两次录像。");
  const before = anglesByReference(first), after = anglesByReference(second), joints = new Map();
  // 每个关节只统计两次都测到的示范画面，缺失关节和缺失阶段均不插值。
  for (const [frame, angles] of before) {
    for (const [label, a] of angles) {
      const b = after.get(frame)?.get(label);
      if (!b) continue;
      const row = joints.get(label) || {common:0, first:0, second:0, peak:-1, time:0};
      row.common++;
      row.first += a.sum/a.count;
      row.second += b.sum/b.count;
      if (b.peak > row.peak) { row.peak = b.peak; row.time = b.time; }
      joints.set(label, row);
    }
  }
  return [...joints].map(([label, row]) => ({...row, label, first:row.first/row.common, second:row.second/row.common}));
}

function button(label, action) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.onclick = action;
  return control;
}

function rangesFor(clip) {
  const {assessment, pose} = clip.report;
  if (!assessment.moments.length) return [{label:"整段练习", start:0, end:pose.duration}];
  return assessment.moments.map(point => ({
    label:point.label + " · " + point.studentTime.toFixed(2) + " 秒",
    start:Math.max(0, point.studentTime-1.5), end:Math.min(pose.duration, point.studentTime+1.5),
  }));
}

export function mountTraining(host, {openReview}) {
  host.innerHTML = '<h1>训练中心</h1><p data-status role="status">正在读取本机练习…</p>' +
    '<div class="phone-training" hidden><section class="panel"><h2>片段训练</h2><label>练习录像<select data-first></select></label>' +
    '<div data-drill hidden><label>训练片段<select data-range></select></label><video muted playsinline preload="metadata" aria-label="训练片段"></video>' +
    '<div class="toolbar"><button type="button" data-play>循环跟练</button><button type="button" data-check>完成一轮</button>' +
    '<button type="button" data-source>打开复盘</button></div><p data-record role="status"></p></div></section>' +
    '<section class="panel"><h2>进步追踪</h2><p>上方录像作为起点。请选择同一位练习者使用同一示范的另一次录像。</p>' +
    '<label>复练录像<select data-second></select></label><div data-trend aria-live="polite"></div></section></div>';
  const find = selector => host.querySelector(selector);
  const form = find(".phone-training"), status = find("[data-status]"), drill = find("[data-drill]");
  const firstSelect = find("[data-first]"), secondSelect = find("[data-second]"), rangeSelect = find("[data-range]");
  const video = find("video"), play = find("[data-play]"), check = find("[data-check]"), trend = find("[data-trend]");
  let entries = [], current = null, ranges = [], range = null, disposed = false, loadId = 0, compareId = 0;

  function release() {
    video.pause(); video.removeAttribute("src"); video.load(); current?.close(); current = null;
  }
  function presentRange() {
    range = ranges[Number(rangeSelect.value)];
    video.pause();
    if (video.readyState >= 1) video.currentTime = range.start;
    play.textContent = "循环跟练";
    const count = current.coaching?.trainingRounds?.[rangeSelect.value] || 0;
    find("[data-record]").textContent = range.start.toFixed(2) + "–" + range.end.toFixed(2) + " 秒 · 已练 " + count + " 轮";
  }
  video.onloadedmetadata = () => { if (range) video.currentTime = range.start; };
  video.ontimeupdate = () => {
    if (range && !video.paused && (video.currentTime >= range.end || video.currentTime < range.start-0.1)) video.currentTime = range.start;
  };
  video.onended = () => {
    if (disposed || !range || play.textContent !== "暂停") return;
    video.currentTime = range.start;
    video.play().catch(error => { play.textContent = "循环跟练"; status.textContent = error.message; });
  };
  play.onclick = async () => {
    if (!video.paused) { video.pause(); play.textContent = "循环跟练"; return; }
    try {
      if (video.currentTime < range.start || video.currentTime >= range.end) video.currentTime = range.start;
      await video.play();
      play.textContent = "暂停";
    } catch { status.textContent = "此设备无法播放该视频，请在复盘中检查原片格式。"; }
  };
  check.onclick = async () => {
    const clip = current, segment = rangeSelect.value;
    check.disabled = true;
    try {
      const state = {...clip.coaching, trainingRounds:{...clip.coaching?.trainingRounds}};
      state.trainingRounds[segment] = (state.trainingRounds[segment] || 0) + 1;
      clip.coachingVersion = await saveCoaching(clip.summary.id, clip.studentIndex, state, clip.coachingVersion);
      clip.coaching = state;
      if (!disposed && clip === current) presentRange();
    } catch (error) { if (!disposed) status.textContent = error.message; }
    finally { check.disabled = false; }
  };
  find("[data-source]").onclick = () => openReview(current.summary.id, current.studentIndex, video.currentTime || range.start);
  rangeSelect.onchange = presentRange;

  async function compareSelected() {
    const request = ++compareId;
    trend.replaceChildren();
    if (!current || !secondSelect.value) return;
    if (firstSelect.value === secondSelect.value) { trend.textContent = "请选择另一份录像。"; return; }
    const member = entries[Number(secondSelect.value)], baseline = current;
    let later;
    try {
      trend.textContent = "正在比较共同示范画面的角差…";
      later = await openPractice(member.id, member.index);
      if (disposed || request !== compareId) return;
      const rows = compareAttempts(baseline, later);
      if (!rows.length) { trend.textContent = "两次练习没有共同拍清的关节画面。"; return; }
      const select = document.createElement("select"), label = document.createElement("label"), value = document.createElement("p");
      label.textContent = "对比关节"; label.append(select);
      for (const row of rows) select.add(new Option(row.label, row.label));
      const peak = button("回看复练最大角差", () => openReview(member.id, member.index, rows[select.selectedIndex].time));
      function showJoint() {
        const row = rows[select.selectedIndex];
        value.textContent = "共同示范画面 " + row.common + " 个 · 平均绝对角差由 " + row.first.toFixed(1) + "° 到 " +
          row.second.toFixed(1) + "°。复练最大角差 " + row.peak.toFixed(1) + "°，位于 " + row.time.toFixed(2) + " 秒。";
      }
      select.onchange = showJoint; showJoint();
      trend.replaceChildren(label, value, peak);
    } catch (error) { if (!disposed && request === compareId) trend.textContent = error.message; }
    finally { later?.close(); }
  }
  async function changeFirst() {
    const request = ++loadId;
    compareId++; release(); range = null; drill.hidden = true; trend.replaceChildren(); secondSelect.value = ""; status.textContent = "";
    if (!firstSelect.value) return;
    const member = entries[Number(firstSelect.value)];
    try {
      const clip = await openPractice(member.id, member.index);
      if (disposed || request !== loadId) { clip.close(); return; }
      current = clip; ranges = rangesFor(clip);
      rangeSelect.replaceChildren(...ranges.map((r, i) => new Option(r.label, String(i))));
      video.src = clip.studentURL; drill.hidden = false; presentRange();
      await compareSelected();
    } catch (error) { if (!disposed && request === loadId) status.textContent = error.message; }
  }
  firstSelect.onchange = changeFirst; secondSelect.onchange = compareSelected;
  listPractices().then(practices => {
    if (disposed) return;
    entries = practices.flatMap(practice => practice.students.map((s, index) => ({
      id:practice.id, index, label:new Date(practice.createdAt).toLocaleString("zh-CN") + " · " + practice.title + " · " + s.name,
    })));
    status.textContent = entries.length ? "" : "完成一组本机动作分析后，即可选择录像进行训练。";
    form.hidden = !entries.length;
    for (const select of [firstSelect, secondSelect]) {
      select.add(new Option("请选择录像", ""));
      entries.forEach((entry, index) => select.add(new Option(entry.label, String(index))));
    }
  }).catch(error => { if (!disposed) status.textContent = error.message; });
  return () => { disposed = true; release(); };
}
