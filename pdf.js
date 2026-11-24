// iPhone 离线导出：逐页绘制并立即压缩，中文使用当前设备字体，视频通过本地画布传入。
const WIDTH = 595, HEIGHT = 842, MARGIN = 42, CONTENT = WIDTH - 2 * MARGIN;
const INK = "#162d42", BLUE = "#185b95", MUTED = "#506578";
const score = v => Number.isFinite(v) ? v.toFixed(1) : "—";
const font = (px, bold) => (bold ? "600 " : "400 ") + px + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

function hexText(text) {
  let encoded = "FEFF";
  for (let i = 0; i < text.length; i++) encoded += text.charCodeAt(i).toString(16).padStart(4, "0");
  return encoded;
}

function packagePDF(pages) {
  // xref 记录的是二进制流的字节偏移，因此 JPEG 与 ASCII 描述分别写入。
  const parts = [], offsets = [0], encoder = new TextEncoder();
  let length = 0;
  function put(part) {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.byteLength;
  }
  function object(id, content, stream) {
    offsets[id] = length;
    put(id + " 0 obj\n" + content);
    if (stream) { put("\nstream\n"); put(stream); put("\nendstream"); }
    put("\nendobj\n");
  }
  put("%PDF-1.7\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const ids = pages.map((_, i) => 4 + i * 3);
  object(2, "<< /Type /Pages /Count " + ids.length + " /Kids [" + ids.map(id => id + " 0 R").join(" ") + "] >>");
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((page, i) => {
    const id = ids[i];
    object(id, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Sheet " +
            (id + 1) + " 0 R >> /Font << /F1 3 0 R >> >> /Contents " + (id + 2) + " 0 R >>");
    object(id + 1, "<< /Type /XObject /Subtype /Image /Width 1190 /Height 1684 /ColorSpace /DeviceRGB " +
           "/BitsPerComponent 8 /Filter /DCTDecode /Length " + page.jpeg.byteLength + " >>", page.jpeg);
    // ActualText 保留画布上每一行的 Unicode 正文，支持识别此标记的阅读器复制、搜索。
    const text = page.lines.map(({x, y, size, value}) =>
      "/Span << /ActualText <" + hexText(value) + "> >> BDC BT /F1 " + size + " Tf 3 Tr 1 0 0 1 " +
      x.toFixed(2) + " " + (HEIGHT - y - size).toFixed(2) + " Tm (.) Tj ET EMC"
    ).join("\n");
    const stream = "q 595 0 0 842 0 0 cm /Sheet Do Q\n" + text;
    object(id + 2, "<< /Length " + stream.length + " >>", encoder.encode(stream));
  });
  const start = length;
  put("xref\n0 " + offsets.length + "\n0000000000 65535 f \n");
  offsets.slice(1).forEach(offset => put(String(offset).padStart(10, "0") + " 00000 n \n"));
  put("trailer\n<< /Size " + offsets.length + " /Root 1 0 R >>\nstartxref\n" + start + "\n%%EOF\n");
  return new Blob(parts, {type:"application/pdf"});
}

export async function makePDF({name, assessment, studentPose, referencePose, images, imageTimes}) {
  const sheet = document.createElement("canvas");
  sheet.width = WIDTH * 2; sheet.height = HEIGHT * 2;
  const c = sheet.getContext("2d", {alpha:false});
  c.scale(2, 2);
  c.textBaseline = "top";
  const pages = [];
  let y, lines;
  function line(value, x, top, size, bold, color) {
    c.fillStyle = color;
    c.font = font(size, bold);
    c.fillText(value, x, top);
    lines.push({value, x, y:top, size});
  }
  function reset() {
    c.fillStyle = "white"; c.fillRect(0, 0, WIDTH, HEIGHT);
    lines = [];
    line("动作研习室  /  个人复盘", MARGIN, 23, 10, true, BLUE);
    c.fillStyle = "#d2e1ee"; c.fillRect(MARGIN, 42, CONTENT, 1);
    y = 58;
  }
  async function flush() {
    line(String(pages.length + 1), WIDTH - MARGIN - 12, HEIGHT - 31, 10, false, MUTED);
    const jpg = await new Promise((resolve, reject) => sheet.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("手机未能生成 PDF 页面图像。")), "image/jpeg", .91));
    pages.push({jpeg:new Uint8Array(await jpg.arrayBuffer()), lines});
    reset();
  }
  async function space(h) { if (y + h > HEIGHT - 55) await flush(); }
  async function paragraph(value, size = 13, bold = false, color = INK) {
    // 按实际字形宽度折行；长文件名、中文姓名和整段教练建议都能跨页。
    const height = Math.ceil(size * 1.65);
    let row = "";
    for (const char of String(value)) {
      c.font = font(size, bold);
      // 句号和逗号随上一字收行，避免独占下一行。
      if (char === "\n" || (row && !/[，。！？；：、）》”」]/u.test(char) && c.measureText(row + char).width > CONTENT)) {
        await space(height); line(row, MARGIN, y, size, bold, color); y += height;
        row = "";
        if (char === "\n") continue;
      }
      row += char;
    }
    if (row) { await space(height); line(row, MARGIN, y, size, bold, color); y += height; }
    y += 6;
  }
  async function heading(value) { await space(59); await paragraph(value, 17, true, BLUE); }
  function still(source, x) {
    const w = (CONTENT - 10) / 2, h = 157;
    c.fillStyle = INK; c.fillRect(x, y, w, h);
    const scale = Math.min(w / source.width, h / source.height);
    c.drawImage(source, x + (w - source.width * scale) / 2, y + (h - source.height * scale) / 2,
                source.width * scale, source.height * scale);
  }
  try {
    reset();
    await paragraph(name, 22, true);
    await space(122);
    c.fillStyle = "#edf5fb"; c.fillRect(MARGIN, y, CONTENT, 106);
    line("动作相似度", MARGIN + 15, y + 12, 12, true, BLUE);
    line(score(assessment.overall) + " / 100", MARGIN + 15, y + 34, 27, true, INK);
    const parts = [["身体", assessment.body], ["左手", assessment.left], ["右手", assessment.right]];
    parts.forEach(([label, value], i) => line(label + "  " + score(value), MARGIN + 16 + i * 151, y + 78, 13, false, INK));
    y += 119;
    await paragraph("手机端姿态测量 · " + assessment.measured + " 个可测时刻", 11, false, MUTED);
    if (images?.length === 2 && images.every(image => image?.width && image?.height)) {
      await space(194);
      const x = MARGIN + (CONTENT + 10) / 2;
      const labels = ["标准示范", "学生练习"].map((v, i) =>
        v + (Number.isFinite(imageTimes?.[i]) ? "　" + imageTimes[i].toFixed(2) + " 秒" : ""));
      line(labels[0], MARGIN, y, 11, true, BLUE); line(labels[1], x, y, 11, true, BLUE);
      y += 19;
      still(images[0], MARGIN); still(images[1], x);
      y += 174;
    }
    if (assessment.moments.length) {
      await heading("关键时刻");
      for (const m of assessment.moments) {
        const t = studentPose.frames[m.studentIndex].time, r = referencePose.frames[m.referenceIndex].time;
        await paragraph(m.label + "　练习 " + t.toFixed(2) + " 秒 · " + score(m.studentAngle) +
                        "°　　示范 " + r.toFixed(2) + " 秒 · " + score(m.referenceAngle) + "°", 12);
      }
    }
    await heading("教练综合建议");
    for (const value of assessment.advice) await paragraph(value);
    await flush();
    await heading("整体训练规划");
    for (const [index, value] of assessment.plan.entries()) {
      await space(59);
      await paragraph("第 " + (index + 1) + " 次练习", 14, true, BLUE);
      await paragraph(value);
      y += 6;
    }
    await flush();
    return packagePDF(pages);
  } finally { sheet.width = 1; sheet.height = 1; }
}
