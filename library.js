// 标准视频在整组学生间复用。首页读取轻量索引，进入复盘才取出当前学生的原片与报告。
const databaseName = "motioncoach-phone-library";
const summaries = "practices";
const media = "media";
const coaching = "coaching";
const standards = "standards";
const standardVideos = "standardVideos";

function localId() {
  // 资料编号只作本机数据库主键，直接使用 128 位随机数，兼容没有 randomUUID 的 WebView。
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,"0")).join("");
}

function openLibrary() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    request.onupgradeneeded = event => {
      const database = request.result;
      if (event.oldVersion < 1) {
        database.createObjectStore(summaries, {keyPath: "id"});
        database.createObjectStore(media, {keyPath: ["id", "slot"]});
      }
      // 新增小型资料表，不迁移或重写旧版本的大视频。
      database.createObjectStore(coaching, {keyPath: ["id", "slot"]});
      database.createObjectStore(standards, {keyPath: "id"});
      database.createObjectStore(standardVideos);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function transact(stores, mode, operation) {
  let database;
  try {
    database = await openLibrary();
    const transaction = database.transaction(stores, mode);
    // 在同一轮事件里发出全部请求，兼容 Safari 在异步间隙自动提交事务的行为。
    return await new Promise((resolve, reject) => {
      let result;
      let requestError;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = event => { requestError = event.target.error; };
      transaction.onabort = () => reject(requestError || transaction.error || new Error("本机资料保存已中断。"));
      try {
        result = operation(transaction);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  } catch (error) {
    if (error.name === "QuotaExceededError") {
      throw new Error("手机存储空间不足，整组练习尚未保存。请释放空间或删除旧练习后重试。");
    }
    throw error;
  } finally {
    database?.close();
  }
}

export async function savePractice({title, reference, students}) {
  if (!(reference?.blob instanceof Blob) || !students?.length ||
      students.some(student => !(student.blob instanceof Blob) || student.report == null)) {
    throw new Error("需要一份标准视频及每名学生的录像和复盘结果。");
  }
  const id = localId();
  const summary = {
    id, title, createdAt: Date.now(), referenceName: reference.name, standardId: reference.standardId || null,
    students: students.map(student => ({name: student.name, scores: scoresOf(student.report)})),
  };
  await transact([summaries, media], "readwrite", transaction => {
    const clips = transaction.objectStore(media);
    transaction.objectStore(summaries).add(summary);
    clips.add({id, slot: -1, blob: reference.blob, pose: reference.pose});
    students.forEach(({blob, report}, slot) => clips.add({id, slot, blob, report}));
  });
  return id;
}

export async function listPractices() {
  const request = await transact(summaries, "readonly", tx => tx.objectStore(summaries).getAll());
  return request.result.sort((a, b) => b.createdAt - a.createdAt);
}

export async function openPractice(id, studentIndex = 0) {
  const requests = await transact([summaries, media, coaching], "readonly", transaction => {
    const clips = transaction.objectStore(media);
    return [
      transaction.objectStore(summaries).get(id),
      clips.get([id, -1]),
      clips.get([id, studentIndex]),
      transaction.objectStore(coaching).get([id, studentIndex]),
    ];
  });
  const [summary, reference, student, notes] = requests.map(request => request.result);
  if (!summary || !summary.students[studentIndex] || !reference || !student) {
    throw new Error("这份本机练习或所选学生的录像不存在。");
  }
  const referenceURL = URL.createObjectURL(reference.blob);
  const studentURL = URL.createObjectURL(student.blob);
  return {
    summary, studentIndex, report: student.report, referencePose: reference.pose, referenceURL, studentURL,
    coaching: notes?.state || {}, coachingVersion: notes?.version || 0,
    close() {
      URL.revokeObjectURL(referenceURL);
      URL.revokeObjectURL(studentURL);
    },
  };
}

export async function deletePractice(id) {
  await transact([summaries, media, coaching], "readwrite", transaction => {
    transaction.objectStore(summaries).delete(id);
    // 同一事务删除全部学生和共享示范，防止只释放列表项而留下大文件。
    transaction.objectStore(media).delete(IDBKeyRange.bound([id, -1], [id, Number.MAX_SAFE_INTEGER]));
    transaction.objectStore(coaching).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  });
}

export async function saveCoaching(id, slot, state, lastVersion) {
  let problem;
  await transact([summaries, coaching], "readwrite", tx => {
    const exists=tx.objectStore(summaries).getKey(id), store=tx.objectStore(coaching);
    const current=store.get([id,slot]);
    current.onsuccess=()=>{
      if (exists.result===undefined) {problem="练习已删除。";return;}
      if ((current.result?.version || 0)!==lastVersion) {problem="这份复盘已在另一页面更新，请重新打开。";return;}
      store.put({id,slot,state,version:lastVersion+1});
    };
  });
  if (problem) throw Error(problem);
  return lastVersion+1;
}

function scoresOf(report) {
  const a=report?.assessment;
  return {overall:a?.overall??null,body:a?.body??null,left:a?.left??null,right:a?.right??null,
    focus:a?.moments?.[0]?.label || "", firstMoment:a?.moments?.[0]?.studentTime??null, version:a?.version??0};
}

export async function classScores(summary, updateAssessment, version) {
  const rows=[];
  for (const [index,member] of summary.students.entries()) {
    // 旧练习需要按新版可测规则重算，其余仅用入库时保存的轻量评分索引。
    let scores=member.scores;
    if (!scores || (updateAssessment && scores.version!==version)) {
      const request=await transact(media,"readonly",tx=>tx.objectStore(media).get([summary.id,index]));
      const report=request.result?.report;
      scores=scoresOf(report && updateAssessment ? {assessment:updateAssessment(report)} : report);
    }
    rows.push({index,name:member.name,...scores});
  }
  return rows;
}

export async function addStandard(file) {
  const id=localId();
  await transact([standards,standardVideos],"readwrite",tx=>{
    tx.objectStore(standards).add({id,name:file.name,createdAt:Date.now(),size:file.size});
    tx.objectStore(standardVideos).add(file,id);
  });
  return id;
}
export async function listStandards() {
  const request=await transact(standards,"readonly",tx=>tx.objectStore(standards).getAll());
  return request.result.sort((a,b)=>b.createdAt-a.createdAt);
}
export async function readStandard(id) {
  const request=await transact(standardVideos,"readonly",tx=>tx.objectStore(standardVideos).get(id));
  if (!request.result) throw Error("这份示范已删除，请重新选择。");
  return request.result;
}
export async function removeStandard(id) {
  await transact([standards,standardVideos],"readwrite",tx=>{
    tx.objectStore(standards).delete(id);tx.objectStore(standardVideos).delete(id);
  });
}
