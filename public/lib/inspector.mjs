// ═══════════════════════════════════════════════════════════════════
//  COSMAX QA Inspector — pure logic shared by server, browser, tests
//  No DOM, no fs, no network. Safe to import from Node and browser.
// ═══════════════════════════════════════════════════════════════════

export const BATCH_MIN = 4;
export const BATCH_MAX = 8;
export const TRANSPORT_MIN = 1;   // server accepts down to 1 (final partial group)
export const TRANSPORT_MAX = 8;
export const ALLOWED_RESOLUTIONS = [512, 768, 1024];
export const MAX_PAYLOAD_BYTES = 6_000_000; // hard cap: full effective serialized payload (decimal 6 MB)
export const ALLOWED_MODES = ["zero_shot", "few_shot"];
export const MAX_REFERENCES = 6;              // hard cap on few-shot reference count
export const MAX_PREPARED_SIDE = 2048;        // hard cap on prepared canvas long edge (px)
export const MAX_PREPARED_ASPECT = 3;         // long-edge / short-edge ceiling for prepared canvas

// Per-field string caps. Applied before we even touch the payload cap so a
// runaway single value cannot lengthen the effective prompt indefinitely.
export const MAX_LINE_LEN = 64;
export const MAX_MODEL_LEN = 128;
export const MAX_UNIT_ID_LEN = 64;
export const MAX_CRITERIA_LEN = 4000;
export const MAX_REFERENCE_NOTE_LEN = 500;
const ROI_EPSILON = 1e-9;
const REFERENCE_CROP_PADDING = 0.12;

function normalizedReferenceRoi(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some(v => typeof v !== "number" || !Number.isFinite(v))) return null;
  const [x, y, w, h] = value;
  if (x < -ROI_EPSILON || y < -ROI_EPSILON || w <= 0 || h <= 0 || x + w > 1 + ROI_EPSILON || y + h > 1 + ROI_EPSILON) return null;
  const left = Math.max(0, Math.min(1, x));
  const top = Math.max(0, Math.min(1, y));
  const normalized = [left, top, Math.min(1, x + w) - left, Math.min(1, y + h) - top];
  return normalized[2] > 0 && normalized[3] > 0 ? normalized : null;
}

export const DEFAULT_CRITERIA =
  "cap seating; label skew/wrinkle; seal damage; leakage/contamination; " +
  "print or lot-code quality; container scratch/dent; foreign material";

// ─── Batch size (UI: 4..8) ──────────────────────────────────────────
export function clampBatchSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return BATCH_MIN;
  return Math.max(BATCH_MIN, Math.min(BATCH_MAX, Math.round(v)));
}

// ─── Resolution ─────────────────────────────────────────────────────
export function validateResolution(r) {
  const v = Number(r);
  if (!ALLOWED_RESOLUTIONS.includes(v)) {
    throw new Error(`Invalid resolution ${r}. Allowed: ${ALLOWED_RESOLUTIONS.join(", ")}`);
  }
  return v;
}

// ─── Batch request validation (server transport) ────────────────────
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;

export function validateBatchRequest(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be an object" };
  const onlyKeys = (obj, allowed) => Object.keys(obj).every((key) => allowed.has(key));
  if (!onlyKeys(body, new Set(["images", "settings", "unit_ids"]))) {
    return { ok: false, error: "Body contains unknown fields" };
  }
  let serializedBytes;
  try { serializedBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength; }
  catch { return { ok: false, error: "Body must be JSON serializable" }; }
  if (serializedBytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: `payload too large (>${MAX_PAYLOAD_BYTES} bytes)` };
  }
  const { images, settings } = body;

  if (!Array.isArray(images) || images.length < TRANSPORT_MIN || images.length > TRANSPORT_MAX) {
    return { ok: false, error: `images must be an array of ${TRANSPORT_MIN}..${TRANSPORT_MAX}` };
  }

  let bytes = 0;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (typeof img !== "string" || !DATA_URL_RE.test(img)) {
      return { ok: false, error: `images[${i}] is not a valid data:image/*;base64 URL` };
    }
    bytes += img.length;
  }

  if (!settings || typeof settings !== "object") return { ok: false, error: "settings missing" };
  if (!onlyKeys(settings, new Set(["line", "model", "mode", "resolution", "threshold", "criteria", "references", "mode_override"]))) {
    return { ok: false, error: "settings contains unknown fields" };
  }
  const { line, model, mode, resolution, threshold, criteria, references } = settings;
  if (typeof line !== "string" || !line) return { ok: false, error: "settings.line required" };
  if (line.length > MAX_LINE_LEN) return { ok: false, error: `settings.line too long (>${MAX_LINE_LEN})` };
  if (typeof model !== "string" || !model) return { ok: false, error: "settings.model required" };
  if (model.length > MAX_MODEL_LEN) return { ok: false, error: `settings.model too long (>${MAX_MODEL_LEN})` };
  if (!ALLOWED_MODES.includes(mode)) return { ok: false, error: `settings.mode must be one of ${ALLOWED_MODES.join(",")}` };
  try { validateResolution(resolution); } catch (e) { return { ok: false, error: e.message }; }
  const th = Number(threshold);
  if (!Number.isFinite(th) || th < 0 || th > 1) return { ok: false, error: "settings.threshold must be 0..1" };
  if (typeof criteria !== "string" || !criteria.trim()) return { ok: false, error: "settings.criteria required" };
  if (criteria.length > MAX_CRITERIA_LEN) return { ok: false, error: `settings.criteria too long (>${MAX_CRITERIA_LEN})` };
  bytes += line.length + model.length + criteria.length;

  if (Array.isArray(body.unit_ids)) {
    if (body.unit_ids.length !== images.length) return { ok: false, error: "unit_ids length must match images" };
    for (let i = 0; i < body.unit_ids.length; i++) {
      const u = body.unit_ids[i];
      if (typeof u !== "string") return { ok: false, error: `unit_ids[${i}] must be a string` };
      if (u.length > MAX_UNIT_ID_LEN) return { ok: false, error: `unit_ids[${i}] too long (>${MAX_UNIT_ID_LEN})` };
      bytes += u.length;
    }
  }

  if (mode === "few_shot") {
    if (!Array.isArray(references) || references.length < 2) {
      return { ok: false, error: "few_shot mode requires at least one OK and one DEFECT reference image" };
    }
    if (references.length > MAX_REFERENCES) {
      return { ok: false, error: `too many references (>${MAX_REFERENCES})` };
    }
    let okCount = 0, defCount = 0;
    for (let i = 0; i < references.length; i++) {
      const r = references[i];
      if (!r || typeof r !== "object") return { ok: false, error: `references[${i}] invalid` };
      if (!onlyKeys(r, new Set(["label", "image", "note", "focus_roi"]))) return { ok: false, error: `references[${i}] contains unknown fields` };
      if (!["OK", "DEFECT"].includes(r.label)) return { ok: false, error: `references[${i}].label must be OK or DEFECT` };
      if (typeof r.image !== "string" || !DATA_URL_RE.test(r.image)) {
        return { ok: false, error: `references[${i}].image must be a valid data URL` };
      }
      if (r.note !== undefined && r.note !== null) {
        if (typeof r.note !== "string") return { ok: false, error: `references[${i}].note must be a string` };
        if (r.note.length > MAX_REFERENCE_NOTE_LEN) {
          return { ok: false, error: `references[${i}].note too long (>${MAX_REFERENCE_NOTE_LEN})` };
        }
        bytes += r.note.length;
      }
      if (r.focus_roi !== undefined) {
        if (!normalizedReferenceRoi(r.focus_roi)) {
          return { ok: false, error: `references[${i}].focus_roi must fit normalized 0..1 bounds` };
        }
      }
      if (r.label === "OK") okCount++; else defCount++;
      bytes += r.image.length + r.label.length;
    }
    if (okCount < 1) return { ok: false, error: "few_shot mode requires at least one OK reference image" };
    if (defCount < 1) return { ok: false, error: "few_shot mode requires at least one DEFECT reference image" };
  }

  // Full effective payload cap: images + references + all string fields (line,
  // model, criteria, unit_ids, reference notes). Prevents runaway strings from
  // ballooning the prompt/payload even when individual bytes stay bounded.
  if (bytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: `payload too large (>${MAX_PAYLOAD_BYTES} bytes)` };
  }

  return { ok: true, value: { images, settings } };
}

// ─── Prompt construction ────────────────────────────────────────────
const SCHEMA_LINE =
  'Respond ONLY with compact JSON of shape: ' +
  '{"defect": boolean, "type": string, "confidence": number, "items": [{"type": string, "bbox": [x1,y1,x2,y2], "severity": "low"|"medium"|"high", "reason": string}]}. ' +
  'bbox coordinates are normalized 0..1. If no defect, items may be []. No markdown, no prose.';

export function buildPromptMessages({ images, settings }) {
  const { mode, criteria, line, threshold, references = [] } = settings;
  const parts = [];

  const isFew = mode === "few_shot" && references.length > 0;
  const refBlock = isFew
    ? "\nReference examples follow (order preserved). Labels:\n" +
      references.map((r, i) => {
        const focus = r.focus_roi
          ? ` — user-selected focus region [${r.focus_roi.map(v => Number(v).toFixed(3)).join(", ")}]; supplied visual prompt shows full context with a marked box and a magnified crop`
          : "";
        return `  #${i + 1} ${r.label}${r.note ? " — " + r.note : ""}${focus}`;
      }).join("\n") +
      "\nLearn the visual difference between OK and DEFECT references before judging the target image(s). When a focus region is supplied, treat it as visual guidance, not a coordinate-based hard rule. Prioritize corresponding visual evidence and ignore unrelated background differences. Use the full-image context to assess product identity, position, orientation, and alignment; the box itself must not determine the verdict."
    : "\nJudge in zero-shot mode from the criteria alone.";

  const header =
`You are a cosmetic packaging QA inspector for COSMAX line "${line}".
Evaluate the target image(s) for these defect categories:
  ${criteria}
Confidence threshold for a positive call: ${Number(threshold).toFixed(2)}.${refBlock}
${SCHEMA_LINE}`;

  parts.push({ type: "text", text: header });

  if (isFew) {
    for (const r of references) {
      parts.push({ type: "image_url", image_url: { url: r.image } });
    }
  }

  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img } });
  }

  return [{ role: "user", content: parts }];
}

// ─── Normalize model output ─────────────────────────────────────────
function stripFences(s) {
  return String(s || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|1|yes|defect)$/i.test(v.trim());
  return !!v;
}
function normalizeSeverity(s) {
  const v = String(s || "").toLowerCase();
  if (["high", "critical", "severe"].includes(v)) return "high";
  if (["low", "minor"].includes(v)) return "low";
  return "medium";
}
function normalizeItem(it) {
  if (!it || typeof it !== "object") return null;
  const bb = Array.isArray(it.bbox) && it.bbox.length === 4 ? it.bbox.map(Number) : null;
  if (!bb || bb.some(n => !Number.isFinite(n))) return null;
  return {
    type: String(it.type || "defect"),
    bbox: bb,
    severity: normalizeSeverity(it.severity),
    reason: it.reason ? String(it.reason).slice(0, 200) : "",
  };
}

// Strict schema for LIVE model output:
//   { "defect": boolean, "type": string, "confidence": number 0..1,
//     "items": [{ "type": string, "bbox": [x1,y1,x2,y2],
//                 "severity": "low"|"medium"|"high", "reason": string }] }
// Anything that fails these constraints — including {}, missing required fields,
// nonnumeric confidence, or an unrecognised defect value — becomes a
// protocol_error/REVIEW result. It must NEVER be silently reported as OK.
function protocolErrorResult(raw) {
  return {
    defect: null,
    type: "UNPARSED",
    confidence: 0,
    bboxes: [],
    protocol_error: true,
    raw: String(raw).slice(0, 500),
  };
}

export function normalizeModelOutput(raw) {
  const text = stripFences(raw);
  let parsed = null;
  try { parsed = JSON.parse(text); }
  catch {
    // try to extract the first {...} block
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* keep null */ } }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return protocolErrorResult(raw);
  }

  if (typeof parsed.defect !== "boolean") return protocolErrorResult(raw);
  const defect = parsed.defect;

  // Required: confidence must be a finite number literal (not string, not null)
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)) {
    return protocolErrorResult(raw);
  }
  if (parsed.confidence < 0 || parsed.confidence > 1) return protocolErrorResult(raw);
  const confidence = parsed.confidence;

  if (typeof parsed.type !== "string" || !parsed.type.trim()) return protocolErrorResult(raw);
  const type = parsed.type;

  if (!Array.isArray(parsed.items)) return protocolErrorResult(raw);
  const items = [];
  for (const item of parsed.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return protocolErrorResult(raw);
    if (typeof item.type !== "string" || !item.type.trim()) return protocolErrorResult(raw);
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4 || item.bbox.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)) return protocolErrorResult(raw);
    if (!["low", "medium", "high"].includes(item.severity)) return protocolErrorResult(raw);
    if (typeof item.reason !== "string") return protocolErrorResult(raw);
    const normalized = normalizeItem(item);
    if (!normalized) return protocolErrorResult(raw);
    items.push(normalized);
  }

  return { defect, type, confidence, bboxes: clampBoundingBoxes(items) };
}

// ─── Clamp/sanitize bounding boxes ──────────────────────────────────
export function clampBoundingBoxes(items) {
  const out = [];
  for (const raw of items || []) {
    if (!raw || !Array.isArray(raw.bbox) || raw.bbox.length !== 4) continue;
    let [x1, y1, x2, y2] = raw.bbox.map(Number);
    if ([x1, y1, x2, y2].some(n => !Number.isFinite(n))) continue;
    x1 = Math.max(0, Math.min(1, x1));
    y1 = Math.max(0, Math.min(1, y1));
    x2 = Math.max(0, Math.min(1, x2));
    y2 = Math.max(0, Math.min(1, y2));
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({ ...raw, bbox: [x1, y1, x2, y2] });
  }
  return out;
}

// ─── Deterministic demo result ──────────────────────────────────────
// FNV-1a 32-bit hash for stable seeding across runtimes.
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
function seededRandom(seed) {
  let state = hashString(String(seed)) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17; state >>>= 0;
    state ^= state << 5;  state >>>= 0;
    return (state >>> 0) / 0xffffffff;
  };
}

const DEMO_DEFECT_TYPES = [
  { type: "cap-tilt",     reason: "cap not fully seated", severity: "high" },
  { type: "label-skew",   reason: "label rotated beyond tolerance", severity: "medium" },
  { type: "label-wrinkle",reason: "label surface wrinkled", severity: "low" },
  { type: "seal-damage",  reason: "seal shows a tear", severity: "high" },
  { type: "leak",         reason: "residue near neck", severity: "high" },
  { type: "print-blur",   reason: "lot code smeared", severity: "medium" },
  { type: "scratch",      reason: "surface scratch", severity: "low" },
  { type: "foreign",      reason: "foreign particle", severity: "medium" },
];

export function makeDemoResult({ seed, criteria }) {
  const rand = seededRandom(seed + "|" + criteria);
  const isDefect = rand() < 0.35;
  if (!isDefect) {
    return {
      defect: false,
      type: "OK",
      confidence: 0.80 + rand() * 0.19,
      bboxes: [],
      demo: true,
    };
  }
  const kind = DEMO_DEFECT_TYPES[Math.floor(rand() * DEMO_DEFECT_TYPES.length)];
  const w = 0.15 + rand() * 0.35;
  const h = 0.15 + rand() * 0.35;
  const x = rand() * (1 - w);
  const y = rand() * (1 - h);
  return {
    defect: true,
    type: kind.type,
    confidence: 0.55 + rand() * 0.44,
    bboxes: [{
      type: kind.type,
      bbox: [x, y, x + w, y + h],
      severity: kind.severity,
      reason: kind.reason,
    }],
    demo: true,
  };
}

// ─── Static path traversal guard ────────────────────────────────────
export function resolveStaticPath(urlPath, root) {
  try {
    let p = urlPath;
    if (typeof p !== "string" || p.length === 0) return { ok: false, error: "empty path" };
    if (p === "/") p = "/index.html";

    // Decode percent-escapes then reject any traversal segments.
    let decoded;
    try { decoded = decodeURIComponent(p); } catch { return { ok: false, error: "bad encoding" }; }
    if (decoded.includes("\0")) return { ok: false, error: "null byte" };

    // Normalize slashes and reject '..'
    const parts = decoded.split(/[\\/]+/);
    for (const seg of parts) if (seg === "..") return { ok: false, error: "traversal" };

    const rel = parts.filter(Boolean).join("/");
    const full = root.replace(/\/+$/, "") + "/" + rel;
    // Final safety: full must remain within root.
    if (!full.startsWith(root.replace(/\/+$/, "") + "/")) {
      return { ok: false, error: "escapes root" };
    }
    return { ok: true, path: full };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ─── ROI coordinate helpers ─────────────────────────────────────────
export function roiToPixels(norm, canvasW, canvasH) {
  const width = Math.max(1, Math.round(Number(canvasW) || 1));
  const height = Math.max(1, Math.round(Number(canvasH) || 1));
  const nx = clamp01(norm.x), ny = clamp01(norm.y);
  const nw = clamp01(norm.w), nh = clamp01(norm.h);
  const x = Math.floor(nx * width);
  const y = Math.floor(ny * height);
  const right = nw > 0 ? Math.min(width, Math.ceil(clamp01(nx + nw) * width)) : x;
  const bottom = nh > 0 ? Math.min(height, Math.ceil(clamp01(ny + nh) * height)) : y;
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}
export function pixelsToRoi(px, canvasW, canvasH) {
  return {
    x: px.x / canvasW,
    y: px.y / canvasH,
    w: px.w / canvasW,
    h: px.h / canvasH,
  };
}

function fitRect(sourceW, sourceH, box) {
  const scale = Math.min(box.w / sourceW, box.h / sourceH);
  const w = sourceW * scale, h = sourceH * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

// Plan a model-agnostic visual prompt: full context with a marked ROI on the
// left, and an enlarged crop on the right. Rendering stays in the browser.
export function buildReferenceFocusPlan(roi, sourceW, sourceH) {
  const normalized = normalizedReferenceRoi(roi);
  if (!normalized) throw new Error("Reference ROI must fit normalized 0..1 bounds");
  if (!(sourceW > 0) || !(sourceH > 0)) throw new Error("Reference image dimensions are invalid");
  const [x, y, w, h] = normalized;
  const padX = w * REFERENCE_CROP_PADDING, padY = h * REFERENCE_CROP_PADDING;
  const cropLeft = Math.max(0, x - padX), cropTop = Math.max(0, y - padY);
  const cropRight = Math.min(1, x + w + padX), cropBottom = Math.min(1, y + h + padY);
  const cropSource = roiToPixels({ x: cropLeft, y: cropTop, w: cropRight - cropLeft, h: cropBottom - cropTop }, sourceW, sourceH);
  const width = 1024, height = 512, pad = 24, labelH = 40;
  const contextDest = fitRect(sourceW, sourceH, { x: pad, y: labelH, w: width / 2 - pad * 2, h: height - labelH - pad });
  const cropDest = fitRect(cropSource.w, cropSource.h, { x: width / 2 + pad, y: labelH, w: width / 2 - pad * 2, h: height - labelH - pad });
  return { width, height, cropSource, contextDest, cropDest };
}

// ─── Event-gate decision ────────────────────────────────────────────
export function eventGateDecision({ changedPixels, totalPixels, threshold }) {
  if (!totalPixels || totalPixels <= 0) {
    return { inspect: true, ratio: 1, reason: "initial frame" };
  }
  const ratio = changedPixels / totalPixels;
  if (ratio >= threshold) return { inspect: true, ratio, reason: "change above threshold" };
  return { inspect: false, ratio, reason: "below threshold — skipped" };
}

// ─── Bounded browser video metadata loading ─────────────────────────
// Uploaded media must not leave the UI waiting forever when a browser/codec
// neither emits loadedmetadata nor an error. Listeners are installed before
// load() to avoid missing a fast local-blob event.
export function waitForVideoMetadata(video, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener?.("loadedmetadata", onLoaded);
      video.removeEventListener?.("error", onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onLoaded = () => finish(resolve, video);
    const onError = () => finish(reject, new Error("Video metadata decode failed"));
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    timer = setTimeout(
      () => finish(reject, new Error("Video metadata timeout")),
      Math.max(1, Number(timeoutMs) || 10_000),
    );
    try {
      video.load?.();
    } catch (error) {
      finish(reject, error);
    }
  });
}

// ─── Video snapshot scheduling ──────────────────────────────────────
export const MIN_SNAPSHOT_FPS = 1;
export const MAX_SNAPSHOT_FPS = 8;
export const MAX_EXTRACTED_FRAMES = 200;

// Produce a strictly-monotonic list of snapshot timestamps in seconds:
//  - always includes t=0 when duration is positive
//  - step = 1/fps (fps clamped to MIN..MAX and rounded to integer)
//  - every timestamp is ≤ duration (never exceeds the video length)
//  - result length capped at maxFrames (default MAX_EXTRACTED_FRAMES=200)
//  - non-finite or ≤0 duration → returns []
export function buildSnapshotTimes(durationSeconds, fps, maxFrames = MAX_EXTRACTED_FRAMES) {
  const d = Number(durationSeconds);
  if (!Number.isFinite(d) || d <= 0) return [];
  let rate = Math.round(Number(fps));
  if (!Number.isFinite(rate)) rate = MIN_SNAPSHOT_FPS;
  rate = Math.max(MIN_SNAPSHOT_FPS, Math.min(MAX_SNAPSHOT_FPS, rate));
  const step = 1 / rate;
  const cap = Math.max(1, Math.min(MAX_EXTRACTED_FRAMES, Math.floor(Number(maxFrames)) || MAX_EXTRACTED_FRAMES));
  const EPS = 1e-6;
  const times = [];
  for (let i = 0; times.length < cap; i++) {
    const raw = i * step;
    if (raw > d + EPS) break;
    const t = Math.min(d, Math.round(raw * 1e6) / 1e6);
    if (times.length === 0 || t > times[times.length - 1] + EPS) {
      times.push(t);
    }
  }
  return times;
}

// ─── Count selected items in a source list ─────────────────────────
// Used by the UI to display "N / M selected" for image sources.
export function countSelectedItems(items) {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items) if (it && it.selected) n++;
  return n;
}

// ─── Protocol failure predicate ────────────────────────────────────
// A LIVE result is a protocol failure when the upstream response could not
// be parsed into the required JSON schema. The runner surfaces these as
// REVIEW cards; they must NEVER be counted as OK.
export function isProtocolFailure(result) {
  return !!(result && result.protocol_error);
}

// ─── Bounded prepared-image dimensions ─────────────────────────────
// Prevents runaway canvases (giant uploads, extreme aspect ratios) from
// forcing browsers to allocate huge buffers or from blowing the payload
// cap on the server side. Behaviour:
//   1. Scale so the short edge equals `target`.
//   2. Clamp the resulting long edge to `maxSide`.
//   3. If aspect ratio still exceeds `maxAspect`, letterbox the long edge
//      down to the maxAspect ceiling (short edge unchanged).
export function computePreparedDimensions({
  srcW, srcH, target,
  maxSide = MAX_PREPARED_SIDE,
  maxAspect = MAX_PREPARED_ASPECT,
}) {
  const sw = Math.max(1, Math.round(Number(srcW) || 1));
  const sh = Math.max(1, Math.round(Number(srcH) || 1));
  const t = Math.max(1, Math.round(Number(target) || 1));

  const shortEdge = Math.min(sw, sh);
  const scale = t / shortEdge;
  let outW = Math.max(1, Math.round(sw * scale));
  let outH = Math.max(1, Math.round(sh * scale));

  // Aspect-ratio ceiling: shorten the long edge if it exceeds maxAspect × short edge.
  if (outW > outH * maxAspect) outW = Math.round(outH * maxAspect);
  if (outH > outW * maxAspect) outH = Math.round(outW * maxAspect);

  // Long-edge ceiling: scale everything down proportionally.
  const longEdge = Math.max(outW, outH);
  if (longEdge > maxSide) {
    const s = maxSide / longEdge;
    outW = Math.max(1, Math.round(outW * s));
    outH = Math.max(1, Math.round(outH * s));
  }

  return { outW, outH };
}

// ─── Deterministic unit-id builder (no Date.now) ──────────────────
// Historically the fallback used Date.now(), which meant demo runs were
// non-deterministic across quick successive calls and unit IDs leaked
// millisecond timestamps. Callers should always supply their own IDs;
// this fallback is only used when they don't.
export function buildUnitId({ line, index }) {
  const l = String(line || "L").replace(/\s+/g, "-");
  const i = Math.max(0, Math.floor(Number(index) || 0));
  return `${l}-${String(i + 1).padStart(4, "0")}`;
}

export function buildInspectionSettingsSnapshot({
  line, model, mode, resolution, threshold, criteria, references = {}, referenceRois = {},
}) {
  const settings = { line, model, mode, resolution, threshold, criteria };
  if (mode === "few_shot") {
    const prepared = [];
    for (const label of ["OK", "DEFECT"]) {
      const image = references[label];
      if (!image) throw new Error(`Missing ${label} reference for run snapshot`);
      const roi = referenceRois[label] ? Object.freeze([...referenceRois[label]]) : null;
      prepared.push(Object.freeze({
        label,
        image,
        ...(label === "DEFECT" ? { note: roi ? "user-selected defect comparison region" : "reference defect" } : {}),
        ...(roi ? {
          focus_roi: roi,
          ...(label === "OK" ? { note: "user-selected OK comparison region" } : {}),
        } : {}),
      }));
    }
    if (prepared.length > MAX_REFERENCES) throw new Error(`Reference count exceeds ${MAX_REFERENCES}`);
    settings.references = Object.freeze(prepared);
  }
  return Object.freeze(settings);
}

// ─── Safe uploaded-raster header inspection ─────────────────────────
export const MAX_REFERENCE_DIMENSION = 8192;
export const MAX_REFERENCE_DECODED_PIXELS = 16_000_000;

export function detectRasterDimensions(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input instanceof ArrayBuffer ? input : input?.buffer || []);
  if (bytes.length >= 24 &&
      bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
      bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 &&
      bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), format: "png" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (sof.has(marker) && length >= 7) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        return { width, height, format: "jpeg" };
      }
      offset += 2 + length;
    }
  }
  throw new Error("Unsupported reference image format; use JPEG or PNG");
}

export function computeBoundedImageDimensions(width, height, maxSide = 1536) {
  const w = Number(width), h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error("Reference image dimensions are invalid");
  }
  if (w > MAX_REFERENCE_DIMENSION || h > MAX_REFERENCE_DIMENSION) {
    throw new Error("Reference image dimensions exceed the safe limit");
  }
  if (w * h > MAX_REFERENCE_DECODED_PIXELS) {
    throw new Error("Reference image pixel count exceeds the safe limit");
  }
  const limit = Math.max(1, Number(maxSide) || 1536);
  const scale = Math.min(1, limit / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

// ─── Latest-generation gate for browser async work ──────────────────
// Each new operation invalidates prior completions; explicit clear/cancel calls
// invalidate() so late FileReader/video/decode results cannot overwrite state.
export function createGenerationGate() {
  let generation = 0;
  return {
    issue() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(token) { return token === generation; },
  };
}

export function beginBoundedFileGeneration(gate, byteLength, maxBytes) {
  if (!gate || typeof gate.issue !== "function") throw new Error("Generation gate is required");
  const generation = gate.issue();
  const size = Number(byteLength), limit = Number(maxBytes);
  return {
    generation,
    accepted: Number.isFinite(size) && size >= 0 && Number.isFinite(limit) && limit >= 0 && size <= limit,
  };
}

// ─── Run-token snapshot helpers (browser controller) ──────────────
// The browser assigns a fresh token to each run. Long-lived async loops
// (batch fetches, frame extractors) capture the token at their start and
// no-op if the token has changed by the time they resolve. This prevents
// a stale loop from mutating a restarted run.
let _tokenSeq = 0;
export function makeRunToken() {
  _tokenSeq = (_tokenSeq + 1) >>> 0 || 1;
  return _tokenSeq;
}
export function snapshotEqual(a, b) {
  if (a == null || b == null) return false;
  return a === b;
}
