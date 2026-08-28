// ═══════════════════════════════════════════════════════════════
//  COSMAX Cosmetic QA Inspector — Frontend
//  지속적인 이미지 검사 + 실시간 불량 판정 결과 표시
// ═══════════════════════════════════════════════════════════════

const API = "/api/inspect";

// ── State ──────────────────────────────────────────────────────
let running = false;
let speed = 4;
let uploadedImages = [];
let useDemo = true;

let total = 0, okCount = 0, badCount = 0, errCount = 0;
let latencies = [];
let tpsHistory = [];
let recentItems = [];
let startTime = 0;
let activeReqs = 0;
let maxConcurrent = 0;
let lastSecCount = 0;

// ── DOM ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const grid = $("grid");
const statusPill = $("statusPill");
const spotlight = $("spotlight");

// ── Demo images (canvas PNG) ───────────────────────────────────
function makeDemoImages() {
  const variants = [
    { label: "CAP-OK",   defect: false, desc: "정상 뚜껑",     color: "#4ade80" },
    { label: "LBL-OK",   defect: false, desc: "정상 라벨",     color: "#4ade80" },
    { label: "SCRATCH",  defect: true,  desc: "표면 스크래치", color: "#fca5a5" },
    { label: "MISALIGN", defect: true,  desc: "라벨 정렬 불량",color: "#fca5a5" },
    { label: "LEAK",     defect: true,  desc: "내용물 누수",   color: "#fca5a5" },
    { label: "BOTTLE-OK",defect: false, desc: "정상 용기",     color: "#4ade80" },
    { label: "COLOR",    defect: true,  desc: "색편차",        color: "#fca5a5" },
    { label: "OK",       defect: false, desc: "양호",          color: "#4ade80" },
  ];
  return variants.map((v, i) => {
    const c = document.createElement("canvas");
    c.width = 300; c.height = 300;
    const ctx = c.getContext("2d");

    const grad = ctx.createLinearGradient(0, 0, 300, 300);
    grad.addColorStop(0, "#1e293b"); grad.addColorStop(1, "#0f172a");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 300, 300);

    ctx.fillStyle = "#64748b"; ctx.fillRect(120, 55, 60, 30);
    ctx.fillStyle = "#e2e8f0"; ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(95, 85, 110, 145, 12); ctx.fill(); ctx.stroke();

    ctx.fillStyle = v.color; ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.roundRect(100, 110, 100, 75, 6); ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 13px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(v.label, 150, 150);
    ctx.font = "10px Inter, sans-serif";
    ctx.fillStyle = v.defect ? "#dc2626" : "#16a34a";
    ctx.fillText(v.defect ? "⚠ DEFECT" : "✓ OK", 150, 170);

    ctx.fillStyle = "#64748b"; ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillText("COSMAX-SKU-" + (1000 + i).toString().padStart(4, "0"), 150, 250);
    ctx.fillStyle = "#475569"; ctx.font = "8px JetBrains Mono, monospace";
    ctx.fillText(v.desc, 150, 265);

    return c.toDataURL("image/png");
  });
}
const demoImages = makeDemoImages();

// ── File upload ────────────────────────────────────────────────
$("fileInput").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  uploadedImages = [];
  for (const f of files) uploadedImages.push(await fileToDataUrl(f));
  useDemo = false;
  flash("이미지 " + files.length + "장 로드됨 — 시작 버튼을 누르세요");
});

function fileToDataUrl(file) {
  return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
}

$("demoBtn").addEventListener("click", () => {
  useDemo = true; uploadedImages = [];
  flash("데모 이미지 모드");
});

// ── Speed ──────────────────────────────────────────────────────
$("speedSlider").addEventListener("input", (e) => {
  speed = parseFloat(e.target.value);
  $("speedLabel").textContent = speed + "/s";
  $("targetTps").textContent = speed.toFixed(1);
});

// ── Start / Stop ────────────────────────────────────────────────
$("startBtn").addEventListener("click", () => { if (!running) startRun(); });
$("stopBtn").addEventListener("click", () => stopRun());

function startRun() {
  running = true;
  startTime = Date.now();
  total = okCount = badCount = errCount = 0;
  latencies = []; tpsHistory = []; recentItems = [];
  activeReqs = 0; maxConcurrent = 0; lastSecCount = 0;
  grid.innerHTML = "";
  renderRecent(); updateStats(); updateSpotlight(null);
  $("startBtn").style.display = "none";
  $("stopBtn").style.display = "";
  updatePill("검사 중", "var(--ok)", true);

  let lastTick = Date.now();
  tpsIntervalId = setInterval(() => {
    if (!running) return;
    const now = Date.now();
    const elapsed = (now - lastTick) / 1000;
    const inst = lastSecCount / elapsed;
    lastSecCount = 0; lastTick = now;
    tpsHistory.push({ t: now, v: inst });
    if (tpsHistory.length > 60) tpsHistory.shift();
    $("tpsVal").textContent = inst.toFixed(1);
    drawSpark();
  }, 1000);

  scheduleNext();
}

let tpsIntervalId = null;

function stopRun() {
  running = false;
  if (tpsIntervalId) { clearInterval(tpsIntervalId); tpsIntervalId = null; }
  updatePill("정지", "var(--dim)");
  $("startBtn").style.display = "";
  $("stopBtn").style.display = "none";
}

// ── Producer: fire images at target rate ───────────────────────
let nextId = 0;
let timerId = null;

function scheduleNext() {
  if (!running) return;
  enqueueImage();
  lastSecCount++;
  timerId = setTimeout(scheduleNext, 1000 / speed);
}

function getImagePool() {
  if (!useDemo && uploadedImages.length > 0) return uploadedImages;
  return demoImages;
}

function enqueueImage() {
  const pool = getImagePool();
  const dataUrl = pool[nextId % pool.length];
  const id = nextId++;

  const card = document.createElement("div");
  card.className = "card pending";
  card.id = "card-" + id;
  card.innerHTML = `
    <div class="img-wrap">
      <img src="${dataUrl}" alt="sample">
      <div class="scanline"></div>
      <div class="overlay">
        <span class="badge wait">판정 중...</span>
      </div>
    </div>
    <div class="info">
      <div class="type">#${id} 검사 대기</div>
      <div class="meta"><span class="conf">—</span><span>— ms</span></div>
    </div>`;
  grid.prepend(card);
  while (grid.children.length > 80) grid.removeChild(grid.lastChild);

  inspectImage(id, dataUrl, card);
}

// ── API call ───────────────────────────────────────────────────
async function inspectImage(id, dataUrl, card) {
  activeReqs++;
  if (activeReqs > maxConcurrent) maxConcurrent = activeReqs;
  const t0 = performance.now();
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
    });
    const data = await res.json();
    const latency = Math.round(performance.now() - t0);
    activeReqs--;
    if (data.error) {
      renderError(card, id, data, latency);
    } else {
      renderResult(card, id, data, latency, dataUrl);
    }
  } catch (e) {
    activeReqs--;
    renderError(card, id, { error: String(e) }, Math.round(performance.now() - t0));
  }
}

function renderResult(card, id, data, latency, dataUrl) {
  const defect = data.defect === true;
  card.className = "card " + (defect ? "defect" : "ok");
  const conf = typeof data.confidence === "number" ? data.confidence : null;
  const confPct = conf !== null ? (conf * 100).toFixed(0) + "%" : "—";
  const type = data.type || (defect ? "DEFECT" : "OK");

  card.querySelector(".overlay").innerHTML =
    `<span class="badge ${defect ? "bad" : "ok"}">${defect ? "⚠ 불량" : "✓ 정상"}</span>`;
  const sl = card.querySelector(".scanline"); if (sl) sl.remove();
  card.querySelector(".info").innerHTML = `
    <div class="type">#${id} ${type}</div>
    <div class="meta"><span class="conf">${confPct}</span><span>${latency} ms</span></div>`;

  total++;
  if (defect) badCount++; else okCount++;
  latencies.push(latency);
  if (latencies.length > 200) latencies.shift();

  updateSpotlight({ id, defect, type, confPct, latency, dataUrl });
  addRecent(defect, type, latency, id);
  updateStats();
}

function renderError(card, id, data, latency) {
  card.className = "card";
  card.style.borderColor = "var(--warn)";
  const sl = card.querySelector(".scanline"); if (sl) sl.remove();
  card.querySelector(".overlay").innerHTML =
    `<span class="badge err">오류</span>`;
  card.querySelector(".info").innerHTML = `
    <div class="type">#${id} API 오류</div>
    <div class="meta"><span class="conf">—</span><span>${latency} ms</span></div>`;

  total++; errCount++;
  addRecent(null, "API 오류", latency, id);
  updateStats();
}

// ── Spotlight (latest result) ──────────────────────────────────
function updateSpotlight(r) {
  if (!r) {
    spotlight.innerHTML = `
      <div class="sl-badge wait">대기 중</div>
      <div class="sl-text">
        <div class="sl-title">검사를 시작하면 최신 결과가 여기에 표시됩니다</div>
        <div class="sl-sub">—</div>
      </div>`;
    return;
  }
  const { id, defect, type, confPct, latency, dataUrl } = r;
  const badge = defect ? "bad" : "ok";
  const label = defect ? "⚠ 불량" : "✓ 정상";
  spotlight.innerHTML = `
    <img class="sl-img ${badge}" src="${dataUrl}" alt="latest">
    <div class="sl-text">
      <div class="sl-title">#${id} ${type}</div>
      <div class="sl-sub">신뢰도 ${confPct} · 지연 ${latency}ms</div>
    </div>
    <div class="sl-badge ${badge}">${label}</div>`;
}

// ── Recent list ────────────────────────────────────────────────
function addRecent(defect, type, latency, id) {
  recentItems.unshift({ defect, type, latency, id });
  if (recentItems.length > 40) recentItems.pop();
  renderRecent();
}
function renderRecent() {
  $("recentList").innerHTML = recentItems.map(r => {
    const cls = r.defect === null ? "err" : (r.defect ? "bad" : "ok");
    return `<div class="recent-item">
      <span class="ri-badge ${cls}"></span>
      <span class="ri-type">#${r.id} ${r.type}</span>
      <span class="ri-lat">${r.latency}ms</span>
    </div>`;
  }).join("");
}

// ── Stats ──────────────────────────────────────────────────────
function updateStats() {
  $("totalCnt").textContent = total;
  $("okCnt").textContent = okCount;
  $("badCnt").textContent = badCount;
  const elapsed = (Date.now() - startTime) / 1000;
  const avg = elapsed > 0 ? (total / elapsed).toFixed(1) : "0.0";
  $("avgTps").textContent = avg;

  const judged = okCount + badCount;
  const okPct = judged > 0 ? Math.round(okCount / judged * 100) : 0;
  const badPct = judged > 0 ? 100 - okPct : 0;
  $("okPct").textContent = okPct + "%";
  $("badPct").textContent = badPct + "%";
  $("barOk").style.width = okPct + "%";
  $("barBad").style.width = badPct + "%";
}

// ── Sparkline ──────────────────────────────────────────────────
function drawSpark() {
  const c = $("spark");
  const ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 48;
  c.width = w * dpr; c.height = h * dpr;
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  if (tpsHistory.length < 2) return;
  const max = Math.max(speed, ...tpsHistory.map(p => p.v), 1);
  const step = w / Math.max(tpsHistory.length - 1, 1);

  ctx.beginPath(); ctx.moveTo(0, h);
  tpsHistory.forEach((p, i) => {
    ctx.lineTo(i * step, h - (p.v / max) * (h - 4) - 2);
  });
  ctx.lineTo((tpsHistory.length - 1) * step, h);
  ctx.closePath();
  ctx.fillStyle = "rgba(110,231,240,.12)"; ctx.fill();

  ctx.beginPath();
  tpsHistory.forEach((p, i) => {
    const x = i * step, y = h - (p.v / max) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#6ee7f0"; ctx.lineWidth = 1.5; ctx.stroke();

  const ty = h - (speed / max) * (h - 4) - 2;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty);
  ctx.strokeStyle = "rgba(245,158,11,.5)"; ctx.stroke();
  ctx.setLineDash([]);
}

// ── UI helpers ─────────────────────────────────────────────────
function updatePill(text, color, live) {
  statusPill.className = "pill" + (live ? " live" : "");
  statusPill.innerHTML = `<span class="dot" style="background:${color}"></span> ${text}`;
}

let flashTimer;
function flash(msg) {
  clearTimeout(flashTimer);
  statusPill.className = "pill";
  statusPill.innerHTML = `<span class="dot" style="background:var(--accent)"></span> ${msg}`;
  flashTimer = setTimeout(() => { if (!running) updatePill("대기", "var(--dim)"); }, 2500);
}

window.addEventListener("resize", drawSpark);
$("speedLabel").textContent = speed + "/s";
$("targetTps").textContent = speed.toFixed(1);
