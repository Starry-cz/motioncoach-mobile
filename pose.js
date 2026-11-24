import { FilesetResolver, PoseLandmarker } from "./vendor/vision_bundle.mjs";

const resource = name => new URL("./vendor/" + name, import.meta.url).href;
const jointIndex = {
  nose: 0, l_shoulder: 11, r_shoulder: 12, l_elbow: 13, r_elbow: 14,
  l_wrist: 15, r_wrist: 16, l_hip: 23, r_hip: 24, l_knee: 25, r_knee: 26,
  l_ankle: 27, r_ankle: 28,
};
let resources;

// 同一批学生复用已读入的权重，每份独立录像创建自己的检测器，避免跨学生沿用跟踪框。
function loadResources() {
  if (!resources) {
    resources = Promise.all([
      FilesetResolver.forVisionTasks(resource("wasm")),
      fetch(resource("pose_landmarker_lite.task")).then(async response => {
        if (!response.ok) throw Error("姿态模型未下载完整，请联网重新准备离线资源。");
        return new Uint8Array(await response.arrayBuffer());
      }),
    ]).catch(error => { resources = undefined; throw error; });
  }
  return resources;
}

export function releasePose() {
  resources = undefined;
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException("已取消分析", "AbortError");
}

function waitForMedia(video, event, start, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      video.removeEventListener(event, ready);
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish();
    const abort = () => finish(new DOMException("已取消分析", "AbortError"));
    const failed = () => finish(Error("浏览器无法解码这段视频，请选择本机可播放的 MP4 或 MOV。"));
    const timer = setTimeout(() => finish(Error("读取视频超时，请回到前台并重新选择录像。")), 30000);
    video.addEventListener(event, ready, {once:true});
    video.addEventListener("error", failed, {once:true});
    signal?.addEventListener("abort", abort, {once:true});
    try { start(); } catch (error) { finish(error); }
  });
}

function bodyPoints(landmarks) {
  const points = {};
  if (!landmarks) return points;
  for (const [key, index] of Object.entries(jointIndex)) {
    const p = landmarks[index];
    if (p && p.visibility >= 0.35) {
      points[key] = {x:p.x, y:p.y, confidence:p.visibility};
    }
  }
  // MediaPipe 不单列颈根和骨盆中心，取两端都可见时的中点。
  for (const [name, pair] of [["neck", "shoulder"], ["root", "hip"]]) {
    const a = points["l_" + pair], b = points["r_" + pair];
    if (a && b) points[name] = {x:(a.x + b.x) / 2, y:(a.y + b.y) / 2,
      confidence:Math.min(a.confidence,b.confidence)};
  }
  return points;
}

/** 视频始终由本地媒体解码器读取。结果时间使用原片的播放秒数，可直接回看。 */
export async function extractPose(file, {mirror=false, signal, onProgress=()=>{}} = {}) {
  checkAbort(signal);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("aria-hidden", "true");
  // iOS 需要挂载内联视频才能稳定获得解码画面。使用本地 Blob URL，无需相册上传。
  video.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.01;pointer-events:none";
  document.body.append(video);
  const url = URL.createObjectURL(file);
  const canvas = document.createElement("canvas");
  let model;
  try {
    await waitForMedia(video, "loadedmetadata", () => { video.src = url; video.load(); }, signal);
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration < 2.99 || duration > 1200.04) {
      throw Error("请选择 3 秒至 20 分钟的录像。");
    }
    if (!video.videoWidth || !video.videoHeight) throw Error("所选文件中没有可解码的视频画面。");
    // videoWidth/videoHeight 和 drawImage 都采用浏览器应用旋转元数据后的呈现方向。
    const aspectRatio = video.videoWidth / video.videoHeight;
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d", {alpha:false});
    if (mirror) ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    onProgress(0);
    const [wasm, modelBytes] = await loadResources();
    checkAbort(signal);
    model = await PoseLandmarker.createFromOptions(wasm, {
      baseOptions:{modelAssetBuffer:modelBytes, delegate:"CPU"},
      runningMode:"VIDEO", numPoses:1, outputSegmentationMasks:false,
    });
    checkAbort(signal);
    const frames = [];
    const interval = Math.max(0.1, duration / 2400);
    // 每个目标都定位到真实的播放时间，VFR 视频不需要猜帧率；记录当时显示的画面。
    const end = duration - 0.001;
    const last = Math.ceil(end / interval);
    for (let i = 0; i <= last; i++) {
      checkAbort(signal);
      const target = Math.max(0.001, Math.min(i * interval, end));
      await waitForMedia(video, "seeked", () => { video.currentTime = target; }, signal);
      checkAbort(signal);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // 检测器接收递增的毫秒时间戳；实际回看使用媒体元素的播放秒数。
      const time = video.currentTime;
      const result = model.detectForVideo(canvas, target * 1000);
      frames.push({time, points:bodyPoints(result.landmarks[0])});
      onProgress((i + 1) / (last + 1));
    }
    if (!frames.some(frame => frame.points.root || frame.points.neck)) {
      throw Error("录像中没有识别到清晰的人体，请使用全身可见的个人录像。");
    }
    return {duration, aspectRatio, frames};
  } finally {
    model?.close();
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    canvas.width = canvas.height = 0;
    URL.revokeObjectURL(url);
  }
}
