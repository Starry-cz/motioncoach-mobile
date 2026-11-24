// 标准视频在整组学生间复用。首页读取轻量索引，进入复盘才取出当前学生的原片与报告。
const databaseName = "motioncoach-phone-library";
const summaries = "practices";
const media = "media";

function openLibrary() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(summaries, {keyPath: "id"});
      database.createObjectStore(media, {keyPath: ["id", "slot"]});
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
  const id = crypto.randomUUID();
  const summary = {
    id, title, createdAt: Date.now(), referenceName: reference.name,
    students: students.map(student => ({name: student.name})),
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
  const requests = await transact([summaries, media], "readonly", transaction => {
    const clips = transaction.objectStore(media);
    return [
      transaction.objectStore(summaries).get(id),
      clips.get([id, -1]),
      clips.get([id, studentIndex]),
    ];
  });
  const [summary, reference, student] = requests.map(request => request.result);
  if (!summary || !summary.students[studentIndex] || !reference || !student) {
    throw new Error("这份本机练习或所选学生的录像不存在。");
  }
  const referenceURL = URL.createObjectURL(reference.blob);
  const studentURL = URL.createObjectURL(student.blob);
  return {
    summary, studentIndex, report: student.report, referencePose: reference.pose, referenceURL, studentURL,
    close() {
      URL.revokeObjectURL(referenceURL);
      URL.revokeObjectURL(studentURL);
    },
  };
}

export async function deletePractice(id) {
  await transact([summaries, media], "readwrite", transaction => {
    transaction.objectStore(summaries).delete(id);
    // 同一事务删除全部学生和共享示范，防止只释放列表项而留下大文件。
    transaction.objectStore(media).delete(IDBKeyRange.bound([id, -1], [id, Number.MAX_SAFE_INTEGER]));
  });
}
