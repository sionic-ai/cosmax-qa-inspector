// ═══════════════════════════════════════════════════════════════════
//  COSMAX QA Inspector — Browser controller
//  Vanilla ES module. Pure logic lives in /lib/inspector.mjs.
//
//  Run-safety model (fixes the blocker):
//    • Every Start issues a fresh run token via makeRunToken().
//    • Long-running loops (producer, frame extractor, fetch handler)
//      capture the token when they start and no-op if state.runToken
//      has changed by the time they resolve.
//    • state.currentAbort is a fresh AbortController per run; Stop aborts
//      it, which cancels the in-flight fetch and unblocks the seek loop.
//    • Per-source media state is stored in state.sources[kind] so that
//      switching tabs never overwrites another tab's uploaded images
//      or extracted frames.
// ═══════════════════════════════════════════════════════════════════
import {
  clampBatchSize,
  validateResolution,
  DEFAULT_CRITERIA,
  makeDemoResult,
  clampBoundingBoxes,
  computePreparedDimensions,
  roiToPixels,
  pixelsToRoi,
  eventGateDecision,
  buildSnapshotTimes,
  buildUnitId,
  countSelectedItems,
  makeRunToken,
  snapshotEqual,
  MIN_SNAPSHOT_FPS,
  MAX_SNAPSHOT_FPS,
  MAX_EXTRACTED_FRAMES,
  buildReferenceFocusPlan,
  waitForVideoMetadata,
  createGenerationGate,
  detectRasterDimensions,
  computeBoundedImageDimensions,
  buildInspectionSettingsSnapshot,
  beginBoundedFileGeneration,
} from "/lib/inspector.mjs";

// ─── DOM helpers ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

// ─── State ──────────────────────────────────────────────────────────
const state = {
  line: "A",
  model: "moonshotai/kimi-k3-ultrafast",
  mode: "zero_shot",
  criteria: DEFAULT_CRITERIA,
  batchSize: 6,
  resolution: 768,
  threshold: 0.55,
  totalUnits: 200,
  eventGate: false,
  eventThreshold: 0.03,

  running: false,
  extracting: false,
  runToken: null,          // fresh token per Start
  activeRunSettings: null, // immutable settings/reference snapshot per run
  currentAbort: null,      // per-run AbortController for fetches + extractor
  produced: 0, processed: 0,
  ok: 0, bad: 0, skip: 0, review: 0, err: 0,
  latencies: [],
  startedAt: 0,
  serverMode: "demo",

  references: { OK: null, DEFECT: null },
  referenceSources: { OK: null, DEFECT: null },
  referenceRois: { OK: null, DEFECT: null },
  refEditor: { slot: null, canvas: null, sourceDataUrl: null, roi: null, dragging: false, start: null, drawRect: null },
  roiNorm: null,
  lastRoiPixels: null,

  currentSample: null,
  dragging: false,
  dragStart: null,

  // Per-source state — SWITCHING TABS MUST NOT MUTATE OTHER TABS
  sourceKind: "sample-images",
  sources: null,           // filled by initSources()
  fps: 2,                  // shared snapshot fps for video sources

  workUnits: [],
  workIndex: 0,
};

const recent = [];
const referenceGates = { OK: createGenerationGate(), DEFECT: createGenerationGate() };
const uploadedVideoGate = createGenerationGate();
const uploadedVideoPreviewGate = createGenerationGate();
const referenceEditorGate = createGenerationGate();
const MAX_REFERENCE_FILE_BYTES = 12 * 1024 * 1024;

// ─── Config load ────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const r = await fetch("/api/config");
    if (r.ok) {
      const cfg = await r.json();
      state.serverMode = cfg.mode || "demo";
      applyModeIndicator();
    }
  } catch { /* demo default */ }
}

function applyModeIndicator() {
  const pill = $("modePill");
  const txt = $("modeText");
  const spotMode = $("spotMode");
  const mode = state.serverMode === "live" ? "live" : "demo";
  pill.setAttribute("data-mode", mode);
  txt.textContent = mode.toUpperCase();
  if (spotMode) spotMode.textContent = mode.toUpperCase();
}

// ─── Cosmetic package image generator ──────────────────────────────
const LINE_PALETTES = {
  A: { body: "#e8ceb9", cap: "#3a2a20", label: "#8b1e3f", accent: "#f5deb3", name: "COSMAX LIPSTICK" },
  B: { body: "#f0e6d2", cap: "#2c2c2c", label: "#4a3728", accent: "#c9a679", name: "COSMAX FOUNDATION" },
  C: { body: "#dbe9f4", cap: "#e0e5eb", label: "#1e40af", accent: "#c7d7e8", name: "COSMAX HYDRA-GEL" },
  D: { body: "#f3f4f6", cap: "#8b8b8b", label: "#065f46", accent: "#d1d5db", name: "COSMAX PACKAGING" },
};

function fRand(seed) {
  let s = 0x811c9dc5;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = (s * 16777619) >>> 0; }
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return (s >>> 0) / 0xffffffff;
  };
}

function drawPackage(ctx, w, h, palette, plan, seed) {
  const rand = fRand(seed);
  // background — warm-white line surface with subtle top-down grade
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#f0e9db"); g.addColorStop(1, "#d9d1c1");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // conveyor stripes
  ctx.strokeStyle = "rgba(60,50,40,.06)";
  ctx.lineWidth = 1;
  for (let y = 0; y < h; y += 14) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  // shadow beneath package
  ctx.fillStyle = "rgba(20,15,10,.16)";
  ctx.beginPath();
  ctx.ellipse(w/2, h*0.86, w*0.28, h*0.03, 0, 0, Math.PI*2);
  ctx.fill();

  // body
  const bodyX = w*0.28, bodyY = h*0.28, bodyW = w*0.44, bodyH = h*0.55;
  ctx.save();
  const bodyGrad = ctx.createLinearGradient(bodyX, 0, bodyX+bodyW, 0);
  bodyGrad.addColorStop(0, shade(palette.body, -.15));
  bodyGrad.addColorStop(0.5, palette.body);
  bodyGrad.addColorStop(1, shade(palette.body, -.25));
  ctx.fillStyle = bodyGrad;
  roundRect(ctx, bodyX, bodyY, bodyW, bodyH, 14); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.22)";
  roundRect(ctx, bodyX + bodyW*0.10, bodyY + bodyH*0.08, bodyW*0.14, bodyH*0.75, 6); ctx.fill();
  ctx.restore();

  // cap
  const capX = w*0.34, capW = w*0.32, capH = h*0.10;
  const capY = bodyY - capH + 4;
  const capTilt = (plan?.type === "cap-tilt") ? (plan.magnitude || (rand() * 8 + 6)) : 0;
  ctx.save();
  ctx.translate(capX + capW/2, capY + capH/2);
  ctx.rotate(capTilt * Math.PI / 180);
  ctx.translate(-(capX + capW/2), -(capY + capH/2));
  const capGrad = ctx.createLinearGradient(capX, 0, capX+capW, 0);
  capGrad.addColorStop(0, shade(palette.cap, -.2));
  capGrad.addColorStop(0.5, palette.cap);
  capGrad.addColorStop(1, shade(palette.cap, -.35));
  ctx.fillStyle = capGrad;
  roundRect(ctx, capX, capY, capW, capH, 4); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.25)";
  for (let x = capX + 4; x < capX + capW - 4; x += 4) {
    ctx.beginPath(); ctx.moveTo(x, capY + 3); ctx.lineTo(x, capY + capH - 3); ctx.stroke();
  }
  if (plan?.type === "seal-damage") {
    const sx = capX + capW*0.4, sy = capY + capH - 2;
    ctx.fillStyle = "#1a1410";
    ctx.beginPath();
    ctx.moveTo(sx, sy); ctx.lineTo(sx + 12, sy - 6); ctx.lineTo(sx + 20, sy);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // label
  const lblX = bodyX + bodyW*0.08, lblW = bodyW*0.84;
  const lblY = bodyY + bodyH*0.30, lblH = bodyH*0.40;
  const skew = (plan?.type === "label-skew") ? (plan.magnitude || (rand() * 6 + 4)) : 0;
  ctx.save();
  ctx.translate(lblX + lblW/2, lblY + lblH/2);
  ctx.rotate(skew * Math.PI / 180);
  ctx.translate(-(lblX + lblW/2), -(lblY + lblH/2));
  const lblGrad = ctx.createLinearGradient(lblX, lblY, lblX+lblW, lblY+lblH);
  lblGrad.addColorStop(0, palette.label);
  lblGrad.addColorStop(1, shade(palette.label, -.15));
  ctx.fillStyle = lblGrad;
  roundRect(ctx, lblX, lblY, lblW, lblH, 4); ctx.fill();
  ctx.strokeStyle = palette.accent; ctx.lineWidth = 1.5;
  roundRect(ctx, lblX + 4, lblY + 4, lblW - 8, lblH - 8, 3); ctx.stroke();
  ctx.fillStyle = palette.accent;
  ctx.font = "bold 12px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(palette.name, lblX + lblW/2, lblY + lblH*0.35);
  ctx.font = "9px Inter, sans-serif";
  ctx.fillText("50 mL · e", lblX + lblW/2, lblY + lblH*0.55);
  const lotY = lblY + lblH*0.78;
  ctx.font = "8px JetBrains Mono, monospace";
  const lot = "L" + Math.floor(rand() * 900000 + 100000).toString();
  if (plan?.type === "print-blur") {
    ctx.globalAlpha = 0.5;
    for (let dx = -2; dx <= 2; dx += 1) ctx.fillText(lot, lblX + lblW/2 + dx, lotY);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillText(lot, lblX + lblW/2, lotY);
  }
  if (plan?.type === "label-wrinkle") {
    ctx.strokeStyle = "rgba(0,0,0,.28)"; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const yy = lblY + (i+1) * lblH/6;
      ctx.beginPath();
      ctx.moveTo(lblX + 4, yy);
      ctx.bezierCurveTo(lblX + lblW*0.3, yy - 4, lblX + lblW*0.7, yy + 4, lblX + lblW - 4, yy);
      ctx.stroke();
    }
  }
  ctx.restore();

  if (plan?.type === "leak") {
    ctx.fillStyle = "rgba(60,20,10,.75)";
    const lx = bodyX + bodyW*0.35 + rand()*bodyW*0.3;
    const ly = bodyY + 4;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.bezierCurveTo(lx - 4, ly + 10, lx + 4, ly + 12, lx + 1, ly + 18);
    ctx.bezierCurveTo(lx + 8, ly + 14, lx + 6, ly + 6, lx, ly);
    ctx.fill();
  }
  if (plan?.type === "scratch") {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 0.9;
    const sy = bodyY + bodyH*0.25 + rand()*bodyH*0.5;
    ctx.beginPath();
    ctx.moveTo(bodyX + 8, sy);
    ctx.lineTo(bodyX + bodyW - 8, sy + (rand()-0.5)*10);
    ctx.stroke(); ctx.restore();
  }
  if (plan?.type === "foreign") {
    ctx.fillStyle = "#1a1a1a";
    const fx = bodyX + bodyW*0.2 + rand()*bodyW*0.6;
    const fy = bodyY + bodyH*0.4 + rand()*bodyH*0.3;
    ctx.beginPath(); ctx.ellipse(fx, fy, 3.5, 2, rand()*Math.PI, 0, Math.PI*2); ctx.fill();
  }
  return plan;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}
function shade(hex, amt) {
  const c = hex.replace("#", "");
  const num = parseInt(c, 16);
  let r = (num >> 16) + Math.round(255 * amt);
  let g = ((num >> 8) & 0xff) + Math.round(255 * amt);
  let b = (num & 0xff) + Math.round(255 * amt);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

function planFromDemo(seed, criteria) {
  const r = makeDemoResult({ seed, criteria });
  if (!r.defect) return null;
  const b = r.bboxes[0];
  return { type: b.type, bbox: b.bbox, severity: b.severity, reason: b.reason };
}

function generateSample(seed, line) {
  const palette = LINE_PALETTES[line] || LINE_PALETTES.A;
  const c = document.createElement("canvas");
  c.width = state.resolution;
  c.height = state.resolution;
  const ctx = c.getContext("2d");
  const plan = planFromDemo(seed, state.criteria);
  drawPackage(ctx, c.width, c.height, palette, plan, seed);
  return { canvas: c, plan };
}

// ─── Per-source state store ─────────────────────────────────────────
function initSources() {
  state.sources = {
    "sample-images": { scenario: "synthetic-200", images: [], previewIndex: 0 },
    "sample-video":  { scenario: "conveyor-stable", extractedFrames: [], previewIndex: 0 },
    "upload-images": { images: [], previewIndex: 0 },
    "upload-video":  { video: null, extractedFrames: [], previewIndex: 0 },
  };
}
function src() { return state.sources[state.sourceKind]; }

// ─── ROI editor ─────────────────────────────────────────────────────
function renderRoiCanvas() {
  const canvas = $("roiCanvas");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(320, Math.floor(rect.width * dpr));
  const targetH = Math.max(240, Math.floor(rect.height * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW; canvas.height = targetH;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.currentSample) {
    const src = state.currentSample.canvas;
    const s = Math.min(canvas.width / src.width, canvas.height / src.height);
    const dw = src.width * s, dh = src.height * s;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;
    // fill outside with a subtle graphite frame
    ctx.fillStyle = "#0a0d13";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, dx, dy, dw, dh);

    if (state.roiNorm) {
      const px = roiToPixels(state.roiNorm, dw, dh);
      ctx.save();
      ctx.fillStyle = "rgba(11,13,16,.55)";
      ctx.fillRect(dx, dy, dw, px.y);
      ctx.fillRect(dx, dy + px.y + px.h, dw, dh - (px.y + px.h));
      ctx.fillRect(dx, dy + px.y, px.x, px.h);
      ctx.fillRect(dx + px.x + px.w, dy + px.y, dw - (px.x + px.w), px.h);
      ctx.strokeStyle = "#14b8a6"; ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(dx + px.x + 1, dy + px.y + 1, px.w - 2, px.h - 2);
      ctx.setLineDash([]);
      ctx.restore();
      const srcPx = roiToPixels(state.roiNorm, src.width, src.height);
      $("roiInfo").textContent = `${srcPx.w}×${srcPx.h}px`;
    } else {
      $("roiInfo").textContent = `전체 · ${src.width}×${src.height}px`;
    }
  } else {
    ctx.fillStyle = "#0a0d13";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#656d7d";
    ctx.font = "13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(placeholderMessage(), canvas.width/2, canvas.height/2);
    $("roiInfo").textContent = "미리보기 없음";
  }
}

function placeholderMessage() {
  const k = state.sourceKind;
  if (k === "upload-images") return "이미지 파일을 업로드하세요";
  if (k === "upload-video") return src().video ? "▶ 검사 시작 시 프레임을 추출합니다" : "영상 파일을 업로드하세요";
  if (k === "sample-video") return "▶ 검사 시작 시 절차 프레임을 생성합니다";
  return "샘플을 생성하려면 '새 샘플'을 클릭하세요";
}

function canvasCoordFromEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}
function drawableRect(canvas) {
  if (!state.currentSample) return null;
  const src = state.currentSample.canvas;
  const s = Math.min(canvas.width / src.width, canvas.height / src.height);
  const dw = src.width * s, dh = src.height * s;
  return { dx: (canvas.width - dw) / 2, dy: (canvas.height - dh) / 2, dw, dh };
}
function bindRoiEditor() {
  const canvas = $("roiCanvas");
  on(canvas, "mousedown", (e) => {
    if (!state.currentSample) return;
    const dr = drawableRect(canvas); if (!dr) return;
    const p = canvasCoordFromEvent(e, canvas);
    if (p.x < dr.dx || p.x > dr.dx + dr.dw || p.y < dr.dy || p.y > dr.dy + dr.dh) return;
    state.dragging = true; state.dragStart = p;
  });
  on(canvas, "mousemove", (e) => {
    if (!state.dragging) return;
    const dr = drawableRect(canvas);
    const p = canvasCoordFromEvent(e, canvas);
    const x1 = Math.max(dr.dx, Math.min(state.dragStart.x, p.x));
    const y1 = Math.max(dr.dy, Math.min(state.dragStart.y, p.y));
    const x2 = Math.min(dr.dx + dr.dw, Math.max(state.dragStart.x, p.x));
    const y2 = Math.min(dr.dy + dr.dh, Math.max(state.dragStart.y, p.y));
    const px = { x: x1 - dr.dx, y: y1 - dr.dy, w: x2 - x1, h: y2 - y1 };
    state.roiNorm = pixelsToRoi(px, dr.dw, dr.dh);
    renderRoiCanvas();
  });
  const endDrag = () => {
    if (state.dragging && state.roiNorm) {
      if (state.roiNorm.w < 0.03 || state.roiNorm.h < 0.03) state.roiNorm = null;
    }
    state.dragging = false; state.dragStart = null;
    renderRoiCanvas();
    state.lastRoiPixels = null;
  };
  on(canvas, "mouseup", endDrag);
  on(canvas, "mouseleave", endDrag);
}

// ─── ROI application: crop and resize with bounded dimensions ──────
function prepareImage(sampleCanvas) {
  const { width: srcW, height: srcH } = sampleCanvas;
  const roi = state.roiNorm ? roiToPixels(state.roiNorm, srcW, srcH) : { x: 0, y: 0, w: srcW, h: srcH };
  // computePreparedDimensions bounds both the long edge and the aspect ratio
  const { outW, outH } = computePreparedDimensions({
    srcW: roi.w, srcH: roi.h, target: state.resolution,
  });
  const out = document.createElement("canvas");
  out.width = outW; out.height = outH;
  out.getContext("2d").drawImage(sampleCanvas, roi.x, roi.y, roi.w, roi.h, 0, 0, outW, outH);
  return { canvas: out, dataUrl: out.toDataURL("image/jpeg", 0.82), roiPixels: roi };
}

// Video frames are retained as compressed strings, not live canvases. A
// 1024² canvas can hold about 4 MiB of decoded pixels; keeping 200 would
// approach 800 MiB. Decode only the frame currently previewed or inspected.
function compressAndReleaseCanvas(canvas) {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
  const width = canvas.width;
  const height = canvas.height;
  canvas.width = 0;
  canvas.height = 0;
  return { dataUrl, width, height };
}

function dataUrlToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      canvas.getContext("2d").drawImage(image, 0, 0);
      image.onload = null;
      image.onerror = null;
      image.src = "";
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("추출 프레임을 디코딩할 수 없습니다."));
    image.src = dataUrl;
  });
}

async function normalizeReferenceDataUrl(dataUrl, maxSide = 1536) {
  let drawable;
  let close = () => {};
  try {
    const blob = await (await fetch(dataUrl)).blob();
    if (blob.size > MAX_REFERENCE_FILE_BYTES) throw new Error("Reference image file exceeds the 12 MB limit");
    const { width: sourceWidth, height: sourceHeight } = detectRasterDimensions(await blob.arrayBuffer());
    const target = computeBoundedImageDimensions(sourceWidth, sourceHeight, maxSide);
    if (typeof createImageBitmap === "function") {
      try {
        drawable = await createImageBitmap(blob, {
          resizeWidth: target.width,
          resizeHeight: target.height,
          resizeQuality: "high",
        });
      } catch {
        // Safe fallback: header limits cap a native decode at 16 MP / 8192px.
        drawable = await createImageBitmap(blob);
      }
      close = () => drawable.close?.();
    } else {
      // Legacy fallback remains bounded by the validated 16 MP header limit.
      drawable = await dataUrlToCanvas(dataUrl);
    }
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    canvas.getContext("2d").drawImage(drawable, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    close();
  }
}

function roiSignature(sampleCanvas) {
  const srcR = state.roiNorm
    ? roiToPixels(state.roiNorm, sampleCanvas.width, sampleCanvas.height)
    : { x: 0, y: 0, w: sampleCanvas.width, h: sampleCanvas.height };
  const W = 32, H = 32;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.drawImage(sampleCanvas, srcR.x, srcR.y, srcR.w, srcR.h, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114) | 0;
  }
  return gray;
}
function diffChangedPixels(a, b) {
  if (!a || !b || a.length !== b.length) return { changed: b?.length || 0, total: b?.length || 0 };
  const T = 12;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > T) changed++;
  return { changed, total: a.length };
}

// ─── Batch runner ───────────────────────────────────────────────────
async function runBatch(units, signal) {
  const images = units.map(u => u.prepared.dataUrl);
  const unit_ids = units.map(u => u.id);
  const settings = state.activeRunSettings;
  if (!settings) throw new Error("검사 실행 설정이 준비되지 않았습니다");
  const body = { images, settings, unit_ids };
  const t0 = performance.now();
  const r = await fetch("/api/inspect/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await r.json();
  const latency = Math.round(performance.now() - t0);
  if (!r.ok) throw Object.assign(new Error(data.error || "batch failed"), { detail: data });
  return { results: data.results, latency, batchMode: data.mode };
}

async function producerLoop(myToken) {
  const B = state.batchSize;
  while (
    state.running &&
    snapshotEqual(state.runToken, myToken) &&
    state.workIndex < state.workUnits.length
  ) {
    const units = [];
    for (let i = 0; i < B && state.workIndex < state.workUnits.length; i++) {
      const wu = state.workUnits[state.workIndex++];
      const gen = await wu.generate();
      const sample = { canvas: gen.canvas, plan: gen.plan || null };
      state.produced++;

      state.currentSample = { canvas: sample.canvas, seed: wu.id, unitId: wu.id, plan: sample.plan };
      $("serialLabel").textContent = wu.id;
      renderRoiCanvas();

      const sig = roiSignature(sample.canvas);
      const diff = diffChangedPixels(state.lastRoiPixels, sig);
      const gate = eventGateDecision({
        changedPixels: diff.changed, totalPixels: diff.total,
        threshold: state.eventThreshold,
      });
      state.lastRoiPixels = sig;

      if (state.eventGate && !gate.inspect) {
        state.processed++; state.skip++;
        renderSkipCard(wu.id, sample, gate.ratio);
        updateStats();
        continue;
      }

      const prepared = prepareImage(sample.canvas);
      const card = renderPendingCard(wu.id, prepared.canvas);
      units.push({ id: wu.id, sample, prepared, card });
    }
    if (units.length === 0) continue;

    try {
      const { results, latency, batchMode } = await runBatch(units, state.currentAbort?.signal);
      // A restart or Stop between fetch dispatch and resolution invalidates this batch.
      if (!snapshotEqual(state.runToken, myToken)) return;
      state.serverMode = batchMode || state.serverMode;
      applyModeIndicator();
      results.forEach((res, i) => applyResult(units[i], res, Math.round(latency / units.length)));
    } catch (e) {
      if (!snapshotEqual(state.runToken, myToken)) return;
      const aborted = e?.name === "AbortError";
      if (aborted) return;
      units.forEach(u => applyError(u, e.message || "요청 실패"));
    }
    updateStats();
  }
  if (state.running && snapshotEqual(state.runToken, myToken)) stopRun(true);
}

// ─── Card rendering ─────────────────────────────────────────────────
function pruneCards(max = 40) {
  const grid = $("grid");
  while (grid.children.length > max) grid.removeChild(grid.lastChild);
  toggleEmpty();
}
function toggleEmpty() {
  const grid = $("grid");
  $("gridEmpty").hidden = grid.children.length > 0;
}

function renderPendingCard(unitId, preparedCanvas) {
  const grid = $("grid");
  const card = document.createElement("div");
  card.className = "card pending";
  card.dataset.id = unitId;
  const c = document.createElement("canvas");
  c.width = preparedCanvas.width; c.height = preparedCanvas.height;
  c.getContext("2d").drawImage(preparedCanvas, 0, 0);
  card.innerHTML = `
    <span class="badge wait">SCAN</span>
    <div class="scan"></div>
    <div class="card-info">
      <div class="card-title">${escapeText(unitId)}</div>
      <div class="card-meta"><span>—</span><span>— ms</span></div>
    </div>`;
  card.insertBefore(c, card.querySelector(".card-info"));
  grid.prepend(card);
  pruneCards();
  return card;
}
function renderSkipCard(unitId, sample, ratio) {
  const grid = $("grid");
  const card = document.createElement("div");
  card.className = "card skip";
  const c = document.createElement("canvas");
  c.width = 180; c.height = 180;
  c.getContext("2d").drawImage(sample.canvas, 0, 0, 180, 180);
  card.innerHTML = `
    <span class="badge skip">SKIP</span>
    <div class="card-info">
      <div class="card-title">${escapeText(unitId)}</div>
      <div class="card-meta"><span>Δ ${(ratio*100).toFixed(1)}%</span><span>gate</span></div>
    </div>`;
  card.insertBefore(c, card.querySelector(".card-info"));
  grid.prepend(card);
  pruneCards();
}

function applyResult(unit, res, latency) {
  const { card } = unit;
  const boxes = clampBoundingBoxes(res.bboxes || []);
  const c = card.querySelector("canvas");
  drawOverlays(c, boxes, unit.prepared.canvas);

  // Protocol failure = REVIEW, never OK.
  const isReview = !!res.protocol_error || res.defect === null;
  const defect = !!res.defect;
  const confOk = typeof res.confidence === "number" && res.confidence >= state.threshold;
  const finalDefect = defect && confOk && !isReview;

  card.classList.remove("pending");
  card.classList.add(isReview ? "review" : (finalDefect ? "defect" : "ok"));
  const badge = card.querySelector(".badge");
  if (isReview) { badge.className = "badge review"; badge.textContent = "REVIEW"; }
  else if (finalDefect) { badge.className = "badge bad"; badge.textContent = "DEFECT"; }
  else { badge.className = "badge ok"; badge.textContent = "OK"; }

  const scan = card.querySelector(".scan"); if (scan) scan.remove();
  const conf = typeof res.confidence === "number" ? (res.confidence * 100).toFixed(0) + "%" : "—";
  card.querySelector(".card-info").innerHTML = `
    <div class="card-title">${escapeText(unit.id)} · ${escapeText(res.type || "OK")}</div>
    <div class="card-meta"><span>${conf}</span><span>${latency} ms</span></div>`;

  state.processed++;
  if (isReview) state.review++;
  else if (finalDefect) state.bad++;
  else state.ok++;
  state.latencies.push(latency);
  if (state.latencies.length > 200) state.latencies.shift();

  updateSpotlight({ unit, res: { ...res, defect: finalDefect, bboxes: boxes, isReview }, latency });
  addRecent({ id: unit.id, defect: finalDefect, review: isReview, type: res.type, latency });
}

function applyError(unit, msg) {
  const { card } = unit;
  card.classList.remove("pending"); card.classList.add("err");
  const badge = card.querySelector(".badge");
  badge.className = "badge err"; badge.textContent = "ERR";
  const scan = card.querySelector(".scan"); if (scan) scan.remove();
  card.querySelector(".card-info").innerHTML = `
    <div class="card-title">${escapeText(unit.id)}</div>
    <div class="card-meta"><span>API</span><span>${escapeText(msg).slice(0, 40)}</span></div>`;
  state.processed++; state.err++;
  addRecent({ id: unit.id, defect: null, review: false, err: true, type: "오류", latency: 0 });
}

function drawOverlays(destCanvas, boxes, prepared) {
  const ctx = destCanvas.getContext("2d");
  ctx.clearRect(0, 0, destCanvas.width, destCanvas.height);
  ctx.drawImage(prepared, 0, 0, destCanvas.width, destCanvas.height);
  ctx.strokeStyle = "#d94f4f"; ctx.lineWidth = 2;
  ctx.fillStyle = "rgba(217,79,79,.12)";
  ctx.font = "bold 10px Inter, sans-serif";
  for (const b of boxes) {
    const [x1, y1, x2, y2] = b.bbox;
    const px = x1 * destCanvas.width, py = y1 * destCanvas.height;
    const pw = (x2 - x1) * destCanvas.width, ph = (y2 - y1) * destCanvas.height;
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeRect(px, py, pw, ph);
    const label = `${b.type}${b.severity ? " · " + b.severity : ""}`;
    ctx.fillStyle = "rgba(217,79,79,.9)";
    ctx.fillRect(px, Math.max(0, py - 12), Math.min(destCanvas.width - px, ctx.measureText(label).width + 8), 12);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, px + 4, Math.max(9, py - 3));
    ctx.fillStyle = "rgba(217,79,79,.12)";
  }
}

// ─── Spotlight ──────────────────────────────────────────────────────
function updateSpotlight({ unit, res, latency }) {
  const c = $("spotCanvas");
  c.width = 360; c.height = 360;
  drawOverlays(c, res.bboxes, unit.prepared.canvas);
  $("spotEmpty").hidden = true;
  const badge = $("spotBadge");
  if (res.isReview) {
    badge.className = "v-badge v-badge-review"; badge.textContent = "REVIEW";
  } else if (res.defect) {
    badge.className = "v-badge v-badge-bad"; badge.textContent = "DEFECT";
  } else {
    badge.className = "v-badge v-badge-ok"; badge.textContent = "OK";
  }
  $("spotTitle").textContent = `${unit.id} · ${res.type || "OK"}`;
  const cnf = typeof res.confidence === "number" ? (res.confidence * 100).toFixed(0) : "—";
  $("spotSub").textContent = `신뢰도 ${cnf}% · 지연 ${latency} ms · ${state.serverMode.toUpperCase()}`;
  $("spotReason").textContent = res.isReview
    ? "모델 출력이 판정 스키마와 일치하지 않아 리뷰가 필요합니다."
    : (res.bboxes?.[0]?.reason || (res.defect ? "결함 감지됨" : "결함 없음"));
}

// ─── Recent list ────────────────────────────────────────────────────
function addRecent(r) {
  recent.unshift(r);
  if (recent.length > 40) recent.pop();
  const html = recent.map((x) => {
    let cls = "ok";
    if (x.err) cls = "err";
    else if (x.review) cls = "review";
    else if (x.defect === null) cls = "err";
    else if (x.defect) cls = "bad";
    return `<div class="ri">
      <span class="ri-dot ${cls}"></span>
      <span class="ri-type">${escapeText(x.id)} · ${escapeText(x.type || "OK")}</span>
      <span class="ri-lat">${x.latency}ms</span>
    </div>`;
  }).join("");
  $("recentList").innerHTML = html;
  $("recentCount").textContent = recent.length;
}

// ─── Stats ──────────────────────────────────────────────────────────
function updateStats() {
  $("doneCount").textContent = state.processed;
  $("totalCount").textContent = state.totalUnits;
  $("cmdProcessed").textContent = state.processed;
  $("cmdTotal").textContent = state.totalUnits;
  $("okCount").textContent = state.ok;
  $("badCount").textContent = state.bad;
  $("skipCount").textContent = state.skip;
  $("reviewCount").textContent = state.review;
  $("errCount").textContent = state.err;
  const decided = state.ok + state.bad;
  const rate = decided ? Math.round((state.bad / decided) * 100) : 0;
  $("rateLabel").textContent = rate + "%";
  const avg = state.latencies.length
    ? Math.round(state.latencies.reduce((a, b) => a + b, 0) / state.latencies.length)
    : 0;
  $("latLabel").textContent = avg;
  const elapsed = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  const tps = elapsed > 0 ? (state.processed / elapsed).toFixed(1) : "0.0";
  $("tpsLabel").textContent = tps;
  const pct = Math.min(100, (state.processed / Math.max(1, state.totalUnits)) * 100);
  $("progressFill").style.width = pct + "%";
}

// ─── Controls binding ──────────────────────────────────────────────
function bindControls() {
  document.querySelectorAll(".line-btn").forEach(btn => {
    on(btn, "click", () => {
      document.querySelectorAll(".line-btn").forEach(b => {
        b.classList.remove("is-active"); b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-active"); btn.setAttribute("aria-checked", "true");
      state.line = btn.dataset.line;
      if (state.sourceKind === "sample-images" && src().scenario !== "synthetic-200") {
        rebuildSampleImagesScenario();
      }
      updatePreviewForCurrentSource();
    });
  });

  document.querySelectorAll(".src-tab").forEach(t => {
    on(t, "click", () => switchSource(t.dataset.src));
  });

  on($("sampleScenario"), "change", (e) => {
    const s = state.sources["sample-images"];
    s.scenario = e.target.value;
    s.previewIndex = 0;
    if (s.scenario !== "synthetic-200") rebuildSampleImagesScenario();
    else { s.images = []; renderSampleThumbs(); }
    switchSource("sample-images");
  });

  on($("sampleVideoScenario"), "change", (e) => {
    const s = state.sources["sample-video"];
    s.scenario = e.target.value;
    s.extractedFrames = [];
    s.previewIndex = 0;
    refreshSourceMeta();
    updatePreviewForCurrentSource();
  });

  on($("uploadImagesInput"), "change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await handleUploadedImageFiles(files);
    e.target.value = "";
  });
  on($("uploadImagesSelectAll"),  "click", () => { state.sources["upload-images"].images.forEach(it => it.selected = true);  renderUploadThumbs(); refreshSourceMeta(); });
  on($("uploadImagesSelectNone"), "click", () => { state.sources["upload-images"].images.forEach(it => it.selected = false); renderUploadThumbs(); refreshSourceMeta(); });
  on($("uploadImagesClear"),      "click", () => {
    state.sources["upload-images"].images = [];
    state.sources["upload-images"].previewIndex = 0;
    renderUploadThumbs(); refreshSourceMeta();
    updatePreviewForCurrentSource();
  });

  on($("uploadVideoInput"), "change", async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    // Clear immediately so selecting the same file again can supersede a pending decode.
    e.target.value = "";
    await handleUploadedVideoFile(f);
  });
  on($("uploadVideoClear"), "click", () => { clearUploadedVideo(); updatePreviewForCurrentSource(); });

  on($("snapshotFps"), "input", (e) => {
    let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) v = 2;
    v = Math.max(MIN_SNAPSHOT_FPS, Math.min(MAX_SNAPSHOT_FPS, v));
    state.fps = v;
    e.target.value = String(v);
    $("snapshotFpsLabel").textContent = `${v} FPS`;
    if (state.sources["sample-video"].extractedFrames.length) state.sources["sample-video"].extractedFrames = [];
    if (state.sources["upload-video"].extractedFrames.length) state.sources["upload-video"].extractedFrames = [];
    refreshSourceMeta();
  });

  on($("previewPrev"), "click", () => setPreview(src().previewIndex - 1));
  on($("previewNext"), "click", () => setPreview(src().previewIndex + 1));

  on($("modelSelect"), "change", (e) => { state.model = e.target.value; refreshModelLabel(); });

  document.querySelectorAll(".seg-btn").forEach(btn => {
    on(btn, "click", () => {
      document.querySelectorAll(".seg-btn").forEach(b => { b.classList.remove("is-active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("is-active"); btn.setAttribute("aria-selected", "true");
      state.mode = btn.dataset.mode;
      $("fewShotBox").hidden = state.mode !== "few_shot";
    });
  });

  $("criteria").value = state.criteria;
  on($("criteria"), "input", (e) => { state.criteria = e.target.value; });

  on($("batchSize"), "input", (e) => {
    const v = clampBatchSize(e.target.value);
    state.batchSize = v; e.target.value = v;
    $("batchLabel").textContent = v;
  });
  on($("resolution"), "change", (e) => {
    state.resolution = validateResolution(e.target.value);
    $("resLabel").textContent = state.resolution;
    if (state.sourceKind === "sample-images" && src().scenario !== "synthetic-200") rebuildSampleImagesScenario();
    // resolution change makes extracted frames stale for BOTH video kinds
    state.sources["sample-video"].extractedFrames = [];
    state.sources["upload-video"].extractedFrames = [];
    updatePreviewForCurrentSource();
    refreshSourceMeta();
  });
  on($("threshold"), "input", (e) => {
    state.threshold = parseFloat(e.target.value);
    $("thresholdLabel").textContent = state.threshold.toFixed(2);
  });
  on($("totalUnits"), "input", (e) => {
    const v = Math.max(1, Math.min(200, Number(e.target.value) || 1));
    state.totalUnits = v; e.target.value = v;
    refreshSourceMeta();
    updateStats();
  });
  on($("eventGate"), "change", (e) => { state.eventGate = e.target.checked; });
  on($("eventThreshold"), "input", (e) => {
    state.eventThreshold = parseFloat(e.target.value);
    $("eventThresholdLabel").textContent = `${(state.eventThreshold * 100).toFixed(1)}%`;
  });

  bindFewShot();

  on($("roiReset"), "click", () => { state.roiNorm = null; state.lastRoiPixels = null; renderRoiCanvas(); });
  on($("roiNew"), "click", newSampleAction);

  on($("startBtn"), "click", startRun);
  on($("stopBtn"),  "click", () => stopRun(false));
  on($("resetBtn"), "click", resetAll);

  window.addEventListener("resize", renderRoiCanvas);
}

function refreshModelLabel() {
  $("modelLabel").textContent = `${state.model} · OpenGateway Vision`;
}

function renderReferencePreview(slotKey) {
  const previewId = slotKey === "OK" ? "fsOKPreview" : "fsBadPreview";
  const focusId = slotKey === "OK" ? "fsOKFocus" : "fsBadFocus";
  const el = $(previewId);
  el.innerHTML = "";
  if (state.references[slotKey]) {
    const img = document.createElement("img");
    img.src = state.references[slotKey];
    img.alt = `${slotKey} few-shot reference${state.referenceRois[slotKey] ? " with focus ROI" : ""}`;
    el.appendChild(img);
  } else {
    const hint = document.createElement("span");
    hint.className = "hint"; hint.textContent = "이미지 없음";
    el.appendChild(hint);
  }
  $(focusId).disabled = !state.referenceSources[slotKey] || state.running;
}

function markFewShotFilled() {
  for (const slotKey of ["OK", "DEFECT"]) {
    const slot = document.querySelector(`.fs-slot[data-slot="${slotKey}"]`);
    if (!slot) continue;
    slot.classList.toggle("is-filled", !!state.references[slotKey]);
    slot.classList.toggle("has-focus", !!state.referenceRois[slotKey]);
    const req = slot.querySelector(".fs-req");
    if (req) req.textContent = state.referenceRois[slotKey] ? "ROI" : (state.references[slotKey] ? "준비" : "필수");
  }
}

function setReferenceSlot(slotKey, dataUrl) {
  referenceGates[slotKey].invalidate();
  if (state.refEditor.slot === slotKey) closeReferenceEditor();
  state.referenceSources[slotKey] = dataUrl;
  state.referenceRois[slotKey] = null;
  state.references[slotKey] = dataUrl;
  renderReferencePreview(slotKey);
  markFewShotFilled();
}

function renderReferenceFocusComposite(source, roi) {
  const plan = buildReferenceFocusPlan(roi, source.width, source.height);
  const c = document.createElement("canvas");
  c.width = plan.width; c.height = plan.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#080b10"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#dce3ee"; ctx.font = "700 18px Inter, sans-serif";
  ctx.fillText("FULL CONTEXT", 24, 28);
  ctx.fillText("FOCUS REGION × ZOOM", c.width / 2 + 24, 28);
  const a = plan.contextDest, b = plan.cropDest, s = plan.cropSource;
  ctx.drawImage(source, a.x, a.y, a.w, a.h);
  ctx.drawImage(source, s.x, s.y, s.w, s.h, b.x, b.y, b.w, b.h);
  const rx = a.x + roi[0] * a.w, ry = a.y + roi[1] * a.h;
  const rw = roi[2] * a.w, rh = roi[3] * a.h;
  // Keep evidence pixels untouched: draw the cue just outside the selected edge.
  ctx.strokeStyle = "#14b8a6"; ctx.lineWidth = 3;
  ctx.strokeRect(rx - 3, ry - 3, rw + 6, rh + 6);
  ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 1;
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  return c.toDataURL("image/jpeg", 0.9);
}

function renderReferenceEditor() {
  const ed = state.refEditor, canvas = $("refRoiCanvas");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#080b10"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!ed.canvas) return;
  const scale = Math.min(canvas.width / ed.canvas.width, canvas.height / ed.canvas.height);
  const dr = {
    x: (canvas.width - ed.canvas.width * scale) / 2,
    y: (canvas.height - ed.canvas.height * scale) / 2,
    w: ed.canvas.width * scale,
    h: ed.canvas.height * scale,
  };
  ed.drawRect = dr;
  ctx.drawImage(ed.canvas, dr.x, dr.y, dr.w, dr.h);
  if (ed.roi) {
    const [x, y, w, h] = ed.roi;
    const px = { x: dr.x + x * dr.w, y: dr.y + y * dr.h, w: w * dr.w, h: h * dr.h };
    ctx.save();
    ctx.fillStyle = "rgba(4,7,10,.58)";
    ctx.fillRect(dr.x, dr.y, dr.w, px.y - dr.y);
    ctx.fillRect(dr.x, px.y + px.h, dr.w, dr.y + dr.h - px.y - px.h);
    ctx.fillRect(dr.x, px.y, px.x - dr.x, px.h);
    ctx.fillRect(px.x + px.w, px.y, dr.x + dr.w - px.x - px.w, px.h);
    ctx.strokeStyle = "#14b8a6"; ctx.lineWidth = 3; ctx.setLineDash([10, 6]);
    ctx.strokeRect(px.x, px.y, px.w, px.h); ctx.restore();
    $("refRoiInfo").textContent = `ROI ${(x * 100).toFixed(1)}%, ${(y * 100).toFixed(1)}% · ${(w * 100).toFixed(1)}% × ${(h * 100).toFixed(1)}%`;
  } else {
    $("refRoiInfo").textContent = "전체 이미지 사용";
  }
}

async function openReferenceEditor(slotKey) {
  const dataUrl = state.referenceSources[slotKey];
  if (!dataUrl) return showStartError("먼저 참조 이미지를 준비하세요.");
  const generation = referenceEditorGate.issue();
  try {
    const canvas = await dataUrlToCanvas(dataUrl);
    if (!referenceEditorGate.isCurrent(generation) || state.referenceSources[slotKey] !== dataUrl) return;
    state.refEditor = {
      slot: slotKey, canvas,
      sourceDataUrl: dataUrl,
      roi: state.referenceRois[slotKey] ? [...state.referenceRois[slotKey]] : null,
      dragging: false, start: null, drawRect: null,
    };
    $("refRoiTitle").textContent = `${slotKey} 참조 · 집중 영역`;
    $("refRoiModal").hidden = false;
    renderReferenceEditor();
  } catch (e) {
    if (referenceEditorGate.isCurrent(generation) && state.referenceSources[slotKey] === dataUrl) {
      showStartError(e.message || "참조 이미지를 열 수 없습니다.");
    }
  }
}

function closeReferenceEditor() {
  referenceEditorGate.invalidate();
  $("refRoiModal").hidden = true;
  state.refEditor = { slot: null, canvas: null, sourceDataUrl: null, roi: null, dragging: false, start: null, drawRect: null };
}

function bindReferenceEditor() {
  const canvas = $("refRoiCanvas");
  const point = (e) => canvasCoordFromEvent(e, canvas);
  on(canvas, "pointerdown", (e) => {
    const ed = state.refEditor, dr = ed.drawRect; if (!ed.canvas || !dr) return;
    const p = point(e);
    if (p.x < dr.x || p.x > dr.x + dr.w || p.y < dr.y || p.y > dr.y + dr.h) return;
    ed.dragging = true; ed.start = p; canvas.setPointerCapture?.(e.pointerId);
  });
  on(canvas, "pointermove", (e) => {
    const ed = state.refEditor, dr = ed.drawRect; if (!ed.dragging || !dr) return;
    const p = point(e);
    const x1 = Math.max(dr.x, Math.min(ed.start.x, p.x));
    const y1 = Math.max(dr.y, Math.min(ed.start.y, p.y));
    const x2 = Math.min(dr.x + dr.w, Math.max(ed.start.x, p.x));
    const y2 = Math.min(dr.y + dr.h, Math.max(ed.start.y, p.y));
    ed.roi = [(x1 - dr.x) / dr.w, (y1 - dr.y) / dr.h, (x2 - x1) / dr.w, (y2 - y1) / dr.h];
    renderReferenceEditor();
  });
  const end = () => {
    const ed = state.refEditor;
    if (ed.dragging && ed.roi && (ed.roi[2] < 0.03 || ed.roi[3] < 0.03)) ed.roi = null;
    ed.dragging = false; ed.start = null; renderReferenceEditor();
  };
  on(canvas, "pointerup", end); on(canvas, "pointercancel", end);
  on($("refRoiReset"), "click", () => { state.refEditor.roi = null; renderReferenceEditor(); });
  on($("refRoiCancel"), "click", closeReferenceEditor);
  on($("refRoiClose"), "click", closeReferenceEditor);
  on($("refRoiSave"), "click", () => {
    const ed = state.refEditor; if (!ed.slot || !ed.canvas) return;
    if (state.referenceSources[ed.slot] !== ed.sourceDataUrl) {
      closeReferenceEditor();
      showStartError("참조 이미지가 변경되었습니다. 새 이미지에서 영역을 다시 지정하세요.");
      return;
    }
    state.referenceRois[ed.slot] = ed.roi ? [...ed.roi] : null;
    state.references[ed.slot] = ed.roi
      ? renderReferenceFocusComposite(ed.canvas, ed.roi)
      : state.referenceSources[ed.slot];
    renderReferencePreview(ed.slot); markFewShotFilled(); closeReferenceEditor();
  });
  on($("refRoiModal"), "click", (e) => { if (e.target === $("refRoiModal")) closeReferenceEditor(); });
  on(document, "keydown", (e) => { if (e.key === "Escape" && !$("refRoiModal").hidden) closeReferenceEditor(); });
}

function bindFewShot() {
  const genFor = (slotKey) => {
    const isDefect = slotKey === "DEFECT";
    const palette = LINE_PALETTES[state.line] || LINE_PALETTES.A;
    const c = document.createElement("canvas");
    c.width = 320; c.height = 320;
    const plan = isDefect
      ? { type: "cap-tilt", magnitude: 12, bbox: [0.34, 0.18, 0.66, 0.35], severity: "high" }
      : null;
    drawPackage(c.getContext("2d"), c.width, c.height, palette, plan, `ref-${slotKey}-${state.line}`);
    setReferenceSlot(slotKey, c.toDataURL("image/jpeg", 0.85));
  };
  on($("fsOKGen"),  "click", () => genFor("OK"));
  on($("fsBadGen"), "click", () => genFor("DEFECT"));

  const bindFile = (inputId, slotKey) => {
    on($(inputId), "change", (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      // Issue first: a rejected newer selection must invalidate older work.
      const selection = beginBoundedFileGeneration(referenceGates[slotKey], f.size, MAX_REFERENCE_FILE_BYTES);
      if (!selection.accepted) {
        e.target.value = "";
        showStartError("참조 이미지는 12 MB 이하여야 합니다.");
        return;
      }
      const generation = selection.generation;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const normalized = await normalizeReferenceDataUrl(reader.result);
          if (!referenceGates[slotKey].isCurrent(generation)) return;
          setReferenceSlot(slotKey, normalized);
        } catch (error) {
          if (referenceGates[slotKey].isCurrent(generation)) {
            showStartError(error.message || "참조 이미지를 준비할 수 없습니다.");
          }
        }
      };
      reader.onerror = () => {
        if (referenceGates[slotKey].isCurrent(generation)) showStartError("참조 이미지 파일을 읽을 수 없습니다.");
      };
      reader.readAsDataURL(f);
      e.target.value = "";
    });
  };
  bindFile("fsOKFile", "OK");
  bindFile("fsBadFile", "DEFECT");

  const useCurrent = (slotKey) => {
    if (!state.currentSample?.canvas) return showStartError("먼저 이미지 또는 영상 프레임을 미리보기에 표시하세요.");
    setReferenceSlot(slotKey, state.currentSample.canvas.toDataURL("image/jpeg", 0.9));
  };
  on($("fsOKCurrent"), "click", () => useCurrent("OK"));
  on($("fsBadCurrent"), "click", () => useCurrent("DEFECT"));
  on($("fsOKFocus"), "click", () => openReferenceEditor("OK"));
  on($("fsBadFocus"), "click", () => openReferenceEditor("DEFECT"));
  bindReferenceEditor();
}

// ─── New sample action ─────────────────────────────────────────────
function newSampleAction() {
  const k = state.sourceKind;
  if (k === "sample-images" && src().scenario !== "synthetic-200") {
    rebuildSampleImagesScenario();
    setPreview(0);
    return;
  }
  if (k === "upload-images" || k === "sample-video" || k === "upload-video") {
    const total = previewableCount();
    if (total) setPreview((src().previewIndex + 1) % total);
    return;
  }
  newSampleSynthetic();
}

function newSampleSynthetic() {
  const uid = buildUnitId({ line: state.line, index: state.produced });
  const sample = generateSample(uid + "-preview", state.line);
  state.currentSample = { canvas: sample.canvas, seed: uid, unitId: uid, plan: sample.plan };
  $("serialLabel").textContent = uid;
  state.lastRoiPixels = null;
  renderRoiCanvas();
  renderPreviewNav();
}

// ─── Start / Stop / Reset ──────────────────────────────────────────
async function startRun() {
  if (state.running) return;

  const v = validateStart();
  if (!v.ok) { showStartError(v.error); return; }
  showStartError("");

  // Cancel pending reference decodes/editor opens, then freeze one immutable
  // reference/settings snapshot so every batch in this run sees identical input.
  referenceGates.OK.invalidate();
  referenceGates.DEFECT.invalidate();
  closeReferenceEditor();
  try {
    state.activeRunSettings = buildInspectionSettingsSnapshot({
      line: `Line-${state.line}`,
      model: state.model,
      mode: state.mode,
      resolution: state.resolution,
      threshold: state.threshold,
      criteria: state.criteria,
      references: state.references,
      referenceRois: state.referenceRois,
    });
  } catch (e) {
    showStartError(e.message || String(e));
    return;
  }

  // Every run gets a fresh token + AbortController. Extractor and producer
  // capture the token; Stop invalidates them all at once.
  state.runToken = makeRunToken();
  state.currentAbort = new AbortController();
  const myToken = state.runToken;

  $("startBtn").hidden = true;
  $("stopBtn").hidden = false;
  setControlsDisabled(true);
  setStatus("추출/실행 준비 중", true);

  // Video kinds: extract first, honoring Stop and cancellation.
  if (state.sourceKind === "sample-video" || state.sourceKind === "upload-video") {
    try {
      state.extracting = true;
      await extractFramesForVideoSource(myToken);
    } catch (e) {
      state.extracting = false;
      if (snapshotEqual(state.runToken, myToken)) {
        showStartError(e.message || String(e));
        stopRun(false);
      }
      return;
    } finally {
      state.extracting = false;
      hideExtractProgress();
    }
    if (!snapshotEqual(state.runToken, myToken)) return;
  }

  try {
    state.workUnits = buildWorkUnits();
  } catch (e) {
    showStartError(e.message || String(e));
    stopRun(false);
    return;
  }
  if (!state.workUnits.length) {
    showStartError("검사할 항목이 없습니다.");
    stopRun(false);
    return;
  }

  state.running = true;
  state.workIndex = 0;
  state.produced = 0; state.processed = 0;
  state.ok = 0; state.bad = 0; state.skip = 0; state.review = 0; state.err = 0;
  state.latencies = []; state.lastRoiPixels = null;
  state.startedAt = Date.now();
  state.totalUnits = state.workUnits.length;
  recent.length = 0;
  $("recentList").innerHTML = `<div class="hint">진행 중…</div>`;
  $("recentCount").textContent = "0";
  $("grid").innerHTML = "";
  toggleEmpty();
  updateStats();
  setStatus("검사 중", true);
  producerLoop(myToken).catch(e => {
    if (!snapshotEqual(state.runToken, myToken)) return;
    console.error(e);
    setStatus("오류: " + (e.message || e), false, true);
    stopRun(false);
  });
}

function stopRun(finished) {
  // Invalidate token first so any in-flight loop no-ops on wake.
  state.running = false;
  state.runToken = null;
  state.activeRunSettings = null;
  try { state.currentAbort?.abort(); } catch { /* noop */ }
  state.currentAbort = null;
  state.extracting = false;
  hideExtractProgress();
  $("startBtn").hidden = false;
  $("stopBtn").hidden = true;
  setControlsDisabled(false);
  setStatus(finished ? "완료" : "정지", false);
}

function resetAll() {
  if (state.running) stopRun(false);
  state.produced = state.processed = state.ok = state.bad = state.skip = state.review = state.err = 0;
  state.latencies = [];
  $("grid").innerHTML = ""; toggleEmpty();
  recent.length = 0;
  $("recentList").innerHTML = `<div class="hint">아직 없음</div>`;
  $("recentCount").textContent = "0";
  $("spotEmpty").hidden = false;
  $("spotBadge").className = "v-badge v-badge-wait"; $("spotBadge").textContent = "대기";
  $("spotTitle").textContent = "—"; $("spotSub").textContent = "—"; $("spotReason").textContent = "";
  const c = $("spotCanvas"); c.getContext("2d").clearRect(0, 0, c.width, c.height);
  updateStats();
  setStatus("대기", false);
  showStartError("");
}

// ─── Source panel switching ────────────────────────────────────────
function switchSource(kind) {
  state.sourceKind = kind;
  document.querySelectorAll(".src-tab").forEach(t => {
    const active = t.dataset.src === kind;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".src-panel").forEach(p => {
    p.hidden = p.dataset.srcPanel !== kind;
  });
  const isVideo = kind === "sample-video" || kind === "upload-video";
  $("videoRateWrap").hidden = !isVideo;
  const totalLbl = $("totalUnitsLbl");
  const totalInp = $("totalUnits");
  const usesTotal = kind === "sample-images" && src().scenario === "synthetic-200";
  totalLbl.classList.toggle("is-off", !usesTotal);
  totalInp.disabled = !usesTotal;

  if (kind === "upload-images") renderUploadThumbs();
  if (kind === "sample-images") renderSampleThumbs();

  refreshSourceMeta();
  refreshSnapshotEstimate();
  updatePreviewForCurrentSource();
}

// ─── Sample images scenarios ───────────────────────────────────────
const SAMPLE_IMAGE_SCENARIOS = {
  "synthetic-200":   { count: 0,  seedPrefix: "SYN" },
  "line-mixed-24":   { count: 24, seedPrefix: "MIX" },
  "line-defects-12": { count: 12, seedPrefix: "DEF", forceDefectSeed: true },
};

function rebuildSampleImagesScenario() {
  const s = state.sources["sample-images"];
  const meta = SAMPLE_IMAGE_SCENARIOS[s.scenario];
  if (!meta) return;
  if (s.scenario === "synthetic-200") { s.images = []; refreshSourceMeta(); return; }
  const images = [];
  let attempted = 0;
  for (let i = 0; images.length < meta.count && attempted < meta.count * 6; i++, attempted++) {
    const seed = `${meta.seedPrefix}-${state.line}-${String(i + 1).padStart(3, "0")}`;
    const plan = planFromDemo(seed, state.criteria);
    if (meta.forceDefectSeed && !plan) continue;
    const canvas = document.createElement("canvas");
    canvas.width = state.resolution; canvas.height = state.resolution;
    const palette = LINE_PALETTES[state.line] || LINE_PALETTES.A;
    drawPackage(canvas.getContext("2d"), canvas.width, canvas.height, palette, plan, seed);
    images.push({ id: seed, canvas, name: seed, selected: true, plan });
  }
  s.images = images;
  refreshSourceMeta();
  renderSampleThumbs();
}

function renderSampleThumbs() {
  const grid = $("sampleThumbs");
  if (!grid) return;
  const s = state.sources["sample-images"];
  if (s.scenario === "synthetic-200") { grid.hidden = true; grid.innerHTML = ""; return; }
  grid.hidden = false;
  grid.innerHTML = "";
  s.images.forEach((it, idx) => {
    const el = renderThumb(it, idx, false, "sample-images");
    el.addEventListener("click", () => setPreview(idx));
    grid.appendChild(el);
  });
}

// ─── Upload images ─────────────────────────────────────────────────
async function handleUploadedImageFiles(files) {
  const store = state.sources["upload-images"];
  const added = [];
  for (const f of files) {
    try {
      const url = URL.createObjectURL(f);
      const img = await loadImage(url);
      const canvas = document.createElement("canvas");
      canvas.width = state.resolution; canvas.height = state.resolution;
      const ctx = canvas.getContext("2d");
      const s = Math.max(canvas.width / img.width, canvas.height / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.fillStyle = "#0a0d13"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      URL.revokeObjectURL(url);
      const id = `UP-${(store.images.length + added.length + 1).toString().padStart(4, "0")}`;
      added.push({ id, canvas, name: f.name, selected: true });
    } catch (e) {
      console.warn("Failed to load", f.name, e);
    }
  }
  store.images = store.images.concat(added);
  renderUploadThumbs();
  refreshSourceMeta();
  updatePreviewForCurrentSource();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

function renderUploadThumbs() {
  const grid = $("uploadThumbs");
  const actions = $("uploadImagesActions");
  if (!grid) return;
  const store = state.sources["upload-images"];
  grid.innerHTML = "";
  if (!store.images.length) { grid.hidden = true; actions.hidden = true; return; }
  grid.hidden = false; actions.hidden = false;
  store.images.forEach((it, idx) => {
    grid.appendChild(renderThumb(it, idx, true, "upload-images"));
  });
}

function renderThumb(item, idx, selectable, kind) {
  const el = document.createElement("div");
  const activePreview = state.sourceKind === kind && idx === state.sources[kind].previewIndex;
  el.className = "thumb" +
    (item.selected ? " is-selected" : " is-off") +
    (activePreview ? " is-preview" : "");
  const c = document.createElement("canvas");
  c.width = 72; c.height = 72;
  c.getContext("2d").drawImage(item.canvas, 0, 0, 72, 72);
  el.appendChild(c);
  const label = document.createElement("div");
  label.className = "thumb-lbl";
  label.textContent = item.name || item.id;
  el.appendChild(label);
  if (selectable) {
    el.addEventListener("click", (e) => {
      if (e.altKey || e.shiftKey) {
        setPreview(idx);
      } else {
        item.selected = !item.selected;
        renderUploadThumbs();
        refreshSourceMeta();
        setPreview(idx);
      }
    });
    el.title = "클릭: 선택 토글 · Alt+클릭: 미리보기";
  }
  return el;
}

// ─── Upload video ──────────────────────────────────────────────────
async function handleUploadedVideoFile(file) {
  clearUploadedVideo();
  const generation = uploadedVideoGate.issue();
  $("uploadVideoMeta").textContent = `${file.name} · 영상 메타데이터 확인 중…`;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForVideoMetadata(video);
  } catch (e) {
    URL.revokeObjectURL(url);
    if (!uploadedVideoGate.isCurrent(generation)) return;
    $("uploadVideoMeta").textContent = `${file.name} · 영상 읽기 실패`;
    showStartError(e.message.includes("timeout")
      ? "영상 메타데이터를 불러오는 시간이 초과되었습니다. 다른 코덱 또는 파일을 사용해 주세요."
      : "영상 디코딩 실패 — 브라우저가 지원하지 않는 코덱일 수 있습니다.");
    return;
  }
  if (!uploadedVideoGate.isCurrent(generation)) {
    URL.revokeObjectURL(url);
    return;
  }
  const store = state.sources["upload-video"];
  store.video = { name: file.name, duration: video.duration || 0, url, videoEl: video, procedural: false };
  store.extractedFrames = [];
  store.previewIndex = 0;
  $("uploadVideoActions").hidden = false;
  refreshSourceMeta();
  refreshSnapshotEstimate();
  updatePreviewForCurrentSource();
}

function clearUploadedVideo() {
  uploadedVideoGate.invalidate();
  uploadedVideoPreviewGate.invalidate();
  const store = state.sources["upload-video"];
  const v = store.video;
  if (v && v.url) { try { URL.revokeObjectURL(v.url); } catch { /* noop */ } }
  store.video = null;
  store.extractedFrames = [];
  store.previewIndex = 0;
  $("uploadVideoActions").hidden = true;
  refreshSourceMeta();
  refreshSnapshotEstimate();
}

// ─── Procedural sample video ───────────────────────────────────────
const SAMPLE_VIDEO_SCENARIOS = {
  "conveyor-stable":  { duration: 6,  label: "안정 컨베이어" },
  "conveyor-events":  { duration: 10, label: "간헐 패키징 이벤트" },
};

function drawSampleVideoFrame(scenarioKey, t, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  const palette = LINE_PALETTES[state.line] || LINE_PALETTES.A;
  if (scenarioKey === "conveyor-stable") {
    const seed = `SVID-STABLE-${state.line}-${Math.floor(t * 10)}`;
    const plan = (Math.floor(t * 10) % 8 === 3) ? planFromDemo(seed, state.criteria) : null;
    drawPackage(ctx, size, size, palette, plan, seed);
  } else {
    const window = Math.floor(t / 2);
    const inEvent = (t - window * 2) < 1.2;
    if (inEvent) {
      const seed = `SVID-EVT-${state.line}-${window}`;
      const plan = planFromDemo(seed, state.criteria);
      drawPackage(ctx, size, size, palette, plan, seed);
    } else {
      drawEmptyConveyor(ctx, size, size);
    }
  }
  return canvas;
}
function drawEmptyConveyor(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#eee7d8"); g.addColorStop(1, "#d5cdbc");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(60,50,40,.06)"; ctx.lineWidth = 1;
  for (let y = 0; y < h; y += 14) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.fillStyle = "rgba(40,40,40,.55)";
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("empty conveyor", w/2, h/2);
}

// ─── Frame extraction ──────────────────────────────────────────────
async function extractFramesForVideoSource(myToken) {
  const kind = state.sourceKind;
  const store = state.sources[kind];
  store.extractedFrames = [];
  const durationSec = getSourceDuration();
  const times = buildSnapshotTimes(durationSec, state.fps, MAX_EXTRACTED_FRAMES);
  if (!times.length) throw new Error("영상 길이 또는 스냅샷 속도가 유효하지 않습니다.");
  showExtractProgress(0, times.length);

  const cancelled = () =>
    !snapshotEqual(state.runToken, myToken) ||
    state.currentAbort?.signal?.aborted;

  if (kind === "sample-video") {
    for (let i = 0; i < times.length; i++) {
      if (cancelled()) return;
      const canvas = drawSampleVideoFrame(store.scenario, times[i], state.resolution);
      const encoded = compressAndReleaseCanvas(canvas);
      store.extractedFrames.push({ ...encoded, timestamp: times[i], name: `t=${times[i].toFixed(2)}s` });
      showExtractProgress(i + 1, times.length);
      if ((i % 4) === 3) await new Promise(r => setTimeout(r, 0));
    }
  } else {
    // upload-video: seek + drawImage, robust to same-currentTime and abort.
    uploadedVideoPreviewGate.invalidate();
    const video = store.video?.videoEl;
    if (!video) throw new Error("영상 소스가 유효하지 않습니다.");
    try { await video.play().catch(() => {}); video.pause(); } catch { /* noop */ }
    for (let i = 0; i < times.length; i++) {
      if (cancelled()) return;
      try {
        await seekVideo(video, times[i], state.currentAbort?.signal);
      } catch (e) {
        if (cancelled()) return;
        throw new Error(`t=${times[i]}s 위치를 탐색할 수 없습니다: ${e.message}`);
      }
      if (cancelled()) return;
      const canvas = document.createElement("canvas");
      canvas.width = state.resolution; canvas.height = state.resolution;
      const ctx = canvas.getContext("2d");
      const vw = video.videoWidth || state.resolution;
      const vh = video.videoHeight || state.resolution;
      const s = Math.max(canvas.width / vw, canvas.height / vh);
      const dw = vw * s, dh = vh * s;
      ctx.fillStyle = "#0a0d13"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      } catch (e) {
        throw new Error(`프레임 렌더링 실패: ${e.message}`);
      }
      const encoded = compressAndReleaseCanvas(canvas);
      store.extractedFrames.push({ ...encoded, timestamp: times[i], name: `t=${times[i].toFixed(2)}s` });
      showExtractProgress(i + 1, times.length);
    }
  }
  hideExtractProgress();
  updatePreviewForCurrentSource();
  refreshSourceMeta();
}

function seekVideo(video, t, abortSignal) {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(video.duration || t, t));
    const EPS = 1e-3;

    // Same-currentTime seek: some browsers never fire 'seeked' if the
    // requested time is already the current time. Resolve synchronously.
    if (Math.abs((video.currentTime || 0) - target) < EPS) {
      // Nudge a repaint by re-issuing the same currentTime (idempotent).
      try { video.currentTime = target; } catch { /* noop */ }
      queueMicrotask(resolve);
      return;
    }

    const cleanup = () => {
      clearTimeout(to);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError  = () => { cleanup(); reject(new Error("seek error")); };
    const onAbort  = () => { cleanup(); reject(new Error("aborted")); };
    const to = setTimeout(() => { cleanup(); reject(new Error("seek timeout")); }, 5000);

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    if (abortSignal) {
      if (abortSignal.aborted) { cleanup(); reject(new Error("aborted")); return; }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    try { video.currentTime = target; }
    catch (e) { cleanup(); reject(e); }
  });
}

function showExtractProgress(done, total) {
  $("extractProgress").hidden = false;
  $("extractLabel").textContent = `프레임 추출 중… ${done} / ${total}`;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("extractFill").style.width = pct + "%";
}
function hideExtractProgress() {
  $("extractProgress").hidden = true;
  $("extractFill").style.width = "0%";
}

// ─── Work-unit builder ─────────────────────────────────────────────
function buildWorkUnits() {
  const kind = state.sourceKind;
  const s = src();
  if (kind === "sample-images" && s.scenario === "synthetic-200") {
    const n = Math.max(1, Math.min(200, state.totalUnits || 200));
    const units = [];
    for (let i = 0; i < n; i++) {
      const id = buildUnitId({ line: state.line, index: i });
      units.push({ id, generate: () => generateSample(id, state.line) });
    }
    return units;
  }
  if (kind === "sample-images" || kind === "upload-images") {
    return s.images.filter(it => it.selected).map(it => ({
      id: it.id,
      generate: () => ({ canvas: it.canvas, plan: it.plan || null }),
    }));
  }
  if (kind === "sample-video" || kind === "upload-video") {
    return s.extractedFrames.map((f, i) => ({
      id: `FRM-${String(i + 1).padStart(3, "0")}·${f.name}`,
      generate: async () => ({ canvas: await dataUrlToCanvas(f.dataUrl), plan: null }),
    }));
  }
  return [];
}

// ─── Start-time validation ─────────────────────────────────────────
function validateStart() {
  const kind = state.sourceKind;
  const s = src();
  if (state.mode === "few_shot") {
    if (!state.references.OK)     return { ok: false, error: "Few-shot 모드에서 OK 참조 이미지가 필요합니다." };
    if (!state.references.DEFECT) return { ok: false, error: "Few-shot 모드에서 DEFECT 참조 이미지가 필요합니다." };
  }
  if (kind === "sample-images") {
    if (s.scenario !== "synthetic-200" && countSelectedItems(s.images) === 0) {
      return { ok: false, error: "선택된 샘플 이미지가 없습니다." };
    }
    return { ok: true };
  }
  if (kind === "upload-images") {
    if (!s.images.length) return { ok: false, error: "업로드된 이미지가 없습니다. 파일을 선택하세요." };
    if (countSelectedItems(s.images) === 0) return { ok: false, error: "이미지가 하나 이상 선택되어야 합니다." };
    return { ok: true };
  }
  if (kind === "sample-video")  return { ok: true };
  if (kind === "upload-video") {
    if (!s.video || !s.video.videoEl) return { ok: false, error: "업로드된 영상이 없습니다." };
    if (!(s.video.duration > 0)) return { ok: false, error: "영상 길이를 읽을 수 없습니다." };
    return { ok: true };
  }
  return { ok: false, error: "알 수 없는 소스입니다." };
}

function showStartError(msg) {
  const el = $("startError");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}

// ─── Preview helpers ───────────────────────────────────────────────
function previewables() {
  const kind = state.sourceKind;
  const s = src();
  if (kind === "sample-images" && s.scenario === "synthetic-200") return [];
  if (kind === "sample-images" || kind === "upload-images") return s.images;
  if (kind === "sample-video"  || kind === "upload-video")  return s.extractedFrames;
  return [];
}
function previewableCount() { return previewables().length; }

async function setPreview(idx) {
  const list = previewables();
  if (!list.length) { renderPreviewNav(); return; }
  const i = Math.max(0, Math.min(list.length - 1, idx));
  const sourceKind = state.sourceKind;
  const sourceStore = src();
  sourceStore.previewIndex = i;
  const it = list[i];
  const id = it.id || it.name || `preview-${i}`;
  let canvas = it.canvas;
  if (!canvas && it.dataUrl) {
    state.currentSample = null;
    renderPreviewNav();
    try { canvas = await dataUrlToCanvas(it.dataUrl); }
    catch (e) { showStartError(e.message); return; }
  }
  // Ignore a late decode if the user switched source or preview meanwhile.
  if (state.sourceKind !== sourceKind || sourceStore.previewIndex !== i) return;
  state.currentSample = { canvas, seed: id, unitId: id, plan: it.plan || null };
  $("serialLabel").textContent = id;
  state.lastRoiPixels = null;
  renderRoiCanvas();
  renderPreviewNav();
  if (state.sourceKind === "upload-images") renderUploadThumbs();
  if (state.sourceKind === "sample-images") renderSampleThumbs();
}

async function previewUploadedVideoFrame(store) {
  const storedVideo = store.video;
  if (!storedVideo?.url || !(storedVideo.duration > 0)) return;
  const generation = uploadedVideoPreviewGate.issue();
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = storedVideo.url;
  const target = Math.min(Math.max(0, storedVideo.duration / 2), Math.max(0, storedVideo.duration - 0.01));
  try {
    await waitForVideoMetadata(video);
    await seekVideo(video, target);
    if (!uploadedVideoPreviewGate.isCurrent(generation) ||
        state.sourceKind !== "upload-video" ||
        state.sources["upload-video"] !== store ||
        store.video !== storedVideo) return;
    const canvas = document.createElement("canvas");
    canvas.width = state.resolution;
    canvas.height = state.resolution;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#080c12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Match the center-crop used by extractFramesForVideoSource exactly.
    const fit = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const w = video.videoWidth * fit, h = video.videoHeight * fit;
    ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    state.currentSample = { canvas, seed: `${storedVideo.name}-preview`, unitId: `${storedVideo.name} · 중간 프레임`, plan: null };
    $("serialLabel").textContent = `${storedVideo.name} · 중간 프레임`;
    state.lastRoiPixels = null;
    renderRoiCanvas();
    renderPreviewNav();
  } catch (e) {
    if (uploadedVideoPreviewGate.isCurrent(generation) &&
        state.sourceKind === "upload-video" && store.video === storedVideo) {
      showStartError(`영상 미리보기 실패: ${e.message}`);
    }
  } finally {
    try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* noop */ }
  }
}

function updatePreviewForCurrentSource() {
  const kind = state.sourceKind;
  const s = src();
  if (kind === "sample-images" && s.scenario === "synthetic-200") { newSampleSynthetic(); return; }
  if (kind === "sample-video" && !s.extractedFrames.length) {
    const meta = SAMPLE_VIDEO_SCENARIOS[s.scenario] || SAMPLE_VIDEO_SCENARIOS["conveyor-stable"];
    const canvas = drawSampleVideoFrame(s.scenario, meta.duration / 2, state.resolution);
    state.currentSample = { canvas, seed: `${s.scenario}-preview`, unitId: `${meta.label} · 미리보기`, plan: null };
    $("serialLabel").textContent = `${meta.label} · 미리보기`;
    state.lastRoiPixels = null;
    renderRoiCanvas();
    renderPreviewNav();
    return;
  }
  if (kind === "upload-video" && s.video && !s.extractedFrames.length) {
    state.currentSample = null;
    $("serialLabel").textContent = "영상 프레임 준비 중…";
    renderRoiCanvas();
    renderPreviewNav();
    previewUploadedVideoFrame(s);
    return;
  }
  const list = previewables();
  if (!list.length) {
    state.currentSample = null;
    $("serialLabel").textContent = "—";
    renderRoiCanvas();
    renderPreviewNav();
    return;
  }
  setPreview(Math.min(s.previewIndex, list.length - 1));
}

function renderPreviewNav() {
  const total = previewableCount();
  const el = $("previewCounter");
  const prev = $("previewPrev"), next = $("previewNext");
  const kind = state.sourceKind;
  const s = src();
  const captureDisabled = !state.currentSample || state.running || state.extracting;
  $("fsOKCurrent").disabled = captureDisabled;
  $("fsBadCurrent").disabled = captureDisabled;
  if (!total) {
    if (kind === "sample-images" && s.scenario === "synthetic-200") el.textContent = "합성 200";
    else if (kind === "sample-video") el.textContent = "샘플 영상 · 추출 전";
    else if (kind === "upload-video") el.textContent = s.video ? "업로드 영상 · 추출 전" : "영상 미선택";
    else el.textContent = "—";
    prev.disabled = true; next.disabled = true;
    return;
  }
  el.textContent = `${s.previewIndex + 1} / ${total}`;
  prev.disabled = s.previewIndex <= 0;
  next.disabled = s.previewIndex >= total - 1;
}

// ─── Source meta / snapshot estimate ───────────────────────────────
function refreshSourceMeta() {
  const kind = state.sourceKind;
  const sMeta = $("sampleImagesMeta");
  if (sMeta) {
    const s = state.sources["sample-images"];
    if (s.scenario === "synthetic-200") sMeta.textContent = `합성 데이터 · ${state.totalUnits}개 (실행 시 동적 생성)`;
    else sMeta.textContent = `${s.images.length}개 준비됨 · ${countSelectedItems(s.images)}개 선택`;
  }
  const svMeta = $("sampleVideoMeta");
  if (svMeta) {
    const s = state.sources["sample-video"];
    const meta = SAMPLE_VIDEO_SCENARIOS[s.scenario] || SAMPLE_VIDEO_SCENARIOS["conveyor-stable"];
    const times = buildSnapshotTimes(meta.duration, state.fps, MAX_EXTRACTED_FRAMES);
    svMeta.textContent = `${meta.label} · 길이 ${meta.duration}s · 예상 ${times.length} 프레임`;
  }
  const upMeta = $("uploadImagesMeta");
  if (upMeta) {
    const s = state.sources["upload-images"];
    if (!s.images.length) upMeta.textContent = "파일이 선택되지 않았습니다.";
    else upMeta.textContent = `${s.images.length}개 업로드됨 · ${countSelectedItems(s.images)}개 선택`;
  }
  const uvMeta = $("uploadVideoMeta");
  if (uvMeta) {
    const s = state.sources["upload-video"];
    if (!s.video) uvMeta.textContent = "파일이 선택되지 않았습니다.";
    else {
      const d = s.video.duration || 0;
      const times = buildSnapshotTimes(d, state.fps, MAX_EXTRACTED_FRAMES);
      const framesInfo = s.extractedFrames.length ? ` · 추출 ${s.extractedFrames.length}` : "";
      uvMeta.textContent = `${s.video.name} · 길이 ${d.toFixed(2)}s · 예상 ${times.length}${framesInfo}`;
    }
  }
  refreshSnapshotEstimate();
}

function refreshSnapshotEstimate() {
  const wrap = $("videoRateWrap"); if (!wrap || wrap.hidden) return;
  const d = getSourceDuration();
  const times = buildSnapshotTimes(d, state.fps, MAX_EXTRACTED_FRAMES);
  const capNote = times.length >= MAX_EXTRACTED_FRAMES ? ` (상한 ${MAX_EXTRACTED_FRAMES} 프레임 도달)` : "";
  $("snapshotEstimate").textContent = d > 0
    ? `예상 프레임: ${times.length}${capNote}`
    : "예상 프레임: — (영상을 먼저 선택하세요)";
}

function getSourceDuration() {
  const kind = state.sourceKind;
  if (kind === "sample-video") {
    return SAMPLE_VIDEO_SCENARIOS[state.sources["sample-video"].scenario]?.duration || 0;
  }
  if (kind === "upload-video") {
    const v = state.sources["upload-video"].video;
    return v ? (v.duration || 0) : 0;
  }
  return 0;
}

// ─── Enable/disable controls ───────────────────────────────────────
function setControlsDisabled(disabled) {
  const ids = [
    "sampleScenario", "sampleVideoScenario",
    "uploadImagesInput", "uploadImagesSelectAll", "uploadImagesSelectNone", "uploadImagesClear",
    "uploadVideoInput", "uploadVideoClear",
    "snapshotFps",
    "batchSize", "resolution", "threshold",
    "eventGate", "eventThreshold",
    "modelSelect", "criteria",
    "fsOKGen", "fsBadGen", "fsOKFile", "fsBadFile",
  ];
  ids.forEach(id => { const el = $(id); if (el) el.disabled = disabled; });
  $("fsOKCurrent").disabled = disabled || !state.currentSample;
  $("fsBadCurrent").disabled = disabled || !state.currentSample;
  $("fsOKFocus").disabled = disabled || !state.referenceSources.OK;
  $("fsBadFocus").disabled = disabled || !state.referenceSources.DEFECT;
  document.querySelectorAll(".src-tab, .line-btn, .seg-btn").forEach(el => { el.disabled = disabled; });
  const reset = $("resetBtn"); if (reset) reset.disabled = disabled;
  const totalInp = $("totalUnits");
  if (totalInp) {
    const usesTotal = state.sourceKind === "sample-images" && src().scenario === "synthetic-200";
    totalInp.disabled = disabled || !usesTotal;
  }
}

function setStatus(text, running, error) {
  const pill = $("statusPill");
  pill.setAttribute("data-run", error ? "err" : running ? "running" : (text === "완료" ? "done" : "idle"));
  $("statusText").textContent = text;
}

// ─── Utilities ──────────────────────────────────────────────────────
function escapeText(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

// ─── Bootstrap ──────────────────────────────────────────────────────
function boot() {
  initSources();
  bindControls();
  bindRoiEditor();
  $("batchLabel").textContent = state.batchSize;
  $("resLabel").textContent = state.resolution;
  $("thresholdLabel").textContent = state.threshold.toFixed(2);
  $("eventThresholdLabel").textContent = `${(state.eventThreshold * 100).toFixed(1)}%`;
  $("snapshotFpsLabel").textContent = `${state.fps} FPS`;
  refreshModelLabel();
  markFewShotFilled();
  newSampleSynthetic();
  renderPreviewNav();
  toggleEmpty();
  loadConfig();
  updateStats();
}
boot();
