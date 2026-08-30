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
      if (!onlyKeys(r, new Set(["label", "image", "note"]))) return { ok: false, error: `references[${i}] contains unknown fields` };
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
      references.map((r, i) => `  #${i + 1} ${r.label}${r.note ? " — " + r.note : ""}`).join("\n") +
      "\nLearn the visual difference between OK and DEFECT references before judging the target image(s)."
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
  const x = Math.round(clamp01(norm.x) * canvasW);
  const y = Math.round(clamp01(norm.y) * canvasH);
  let w = Math.round(clamp01(norm.w) * canvasW);
  let h = Math.round(clamp01(norm.h) * canvasH);
  if (x + w > canvasW) w = canvasW - x;
  if (y + h > canvasH) h = canvasH - y;
  return { x, y, w, h };
}
export function pixelsToRoi(px, canvasW, canvasH) {
  return {
    x: px.x / canvasW,
    y: px.y / canvasH,
    w: px.w / canvasW,
    h: px.h / canvasH,
  };
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
