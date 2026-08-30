import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateBatchRequest,
  clampBatchSize,
  validateResolution,
  buildPromptMessages,
  normalizeModelOutput,
  clampBoundingBoxes,
  makeDemoResult,
  resolveStaticPath,
  roiToPixels,
  pixelsToRoi,
  eventGateDecision,
  buildSnapshotTimes,
  countSelectedItems,
  buildReferenceFocusPlan,
  waitForVideoMetadata,
  createGenerationGate,
  detectRasterDimensions,
  computeBoundedImageDimensions,
  buildInspectionSettingsSnapshot,
  beginBoundedFileGeneration,
  DEFAULT_CRITERIA,
  MAX_EXTRACTED_FRAMES,
  MIN_SNAPSHOT_FPS,
  MAX_SNAPSHOT_FPS,
} from "../public/lib/inspector.mjs";

// ─── clampBatchSize ────────────────────────────────────────────────
test("clampBatchSize forces UI batch into 4..8 window", () => {
  assert.equal(clampBatchSize(0), 4);
  assert.equal(clampBatchSize(3), 4);
  assert.equal(clampBatchSize(4), 4);
  assert.equal(clampBatchSize(6), 6);
  assert.equal(clampBatchSize(8), 8);
  assert.equal(clampBatchSize(20), 8);
  assert.equal(clampBatchSize("5"), 5);
  assert.equal(clampBatchSize(NaN), 4);
});

// ─── validateResolution ────────────────────────────────────────────
test("validateResolution accepts only 512/768/1024", () => {
  assert.equal(validateResolution(512), 512);
  assert.equal(validateResolution(768), 768);
  assert.equal(validateResolution(1024), 1024);
  assert.equal(validateResolution("768"), 768);
  assert.throws(() => validateResolution(600), /resolution/);
  assert.throws(() => validateResolution(0), /resolution/);
});

// ─── validateBatchRequest (server transport allows 1..8) ───────────
test("validateBatchRequest accepts 1..8 images with settings", () => {
  const good = {
    images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
    settings: {
      line: "Line-A",
      model: "moonshotai/kimi-k3-ultrafast",
      mode: "zero_shot",
      resolution: 768,
      threshold: 0.5,
      criteria: "cap seating",
    },
  };
  const out = validateBatchRequest(good);
  assert.equal(out.ok, true);
  assert.equal(out.value.images.length, 2);
});

test("validateBatchRequest rejects 0 images", () => {
  const bad = { images: [], settings: { line: "L", model: "m", mode: "zero_shot", resolution: 512, threshold: 0.5, criteria: "c" } };
  const out = validateBatchRequest(bad);
  assert.equal(out.ok, false);
  assert.match(out.error, /images/);
});

test("validateBatchRequest rejects 9 images", () => {
  const bad = {
    images: new Array(9).fill("data:image/png;base64,AA"),
    settings: { line: "L", model: "m", mode: "zero_shot", resolution: 512, threshold: 0.5, criteria: "c" },
  };
  const out = validateBatchRequest(bad);
  assert.equal(out.ok, false);
  assert.match(out.error, /images/);
});

test("validateBatchRequest rejects malformed images", () => {
  const bad = {
    images: ["not-a-data-url"],
    settings: { line: "L", model: "m", mode: "zero_shot", resolution: 512, threshold: 0.5, criteria: "c" },
  };
  const out = validateBatchRequest(bad);
  assert.equal(out.ok, false);
  assert.match(out.error, /image/i);
});

test("validateBatchRequest rejects payload above hard cap", () => {
  const huge = "data:image/png;base64," + "A".repeat(2_000_000);
  const bad = {
    images: [huge, huge, huge, huge],
    settings: { line: "L", model: "m", mode: "zero_shot", resolution: 512, threshold: 0.5, criteria: "c" },
  };
  const out = validateBatchRequest(bad);
  assert.equal(out.ok, false);
  assert.match(out.error, /size|large/i);
});

test("validateBatchRequest rejects unknown mode", () => {
  const bad = {
    images: ["data:image/png;base64,AA"],
    settings: { line: "L", model: "m", mode: "bogus", resolution: 512, threshold: 0.5, criteria: "c" },
  };
  const out = validateBatchRequest(bad);
  assert.equal(out.ok, false);
});

test("validateBatchRequest few-shot requires references", () => {
  const bad = {
    images: ["data:image/png;base64,AA"],
    settings: {
      line: "L", model: "m", mode: "few_shot", resolution: 512, threshold: 0.5, criteria: "c",
      references: [],
    },
  };
  const out = validateBatchRequest(bad);
  assert.equal(out.ok, false);
  assert.match(out.error, /reference/i);
});

// ─── buildPromptMessages ───────────────────────────────────────────
test("buildPromptMessages embeds criteria in the zero-shot instruction", () => {
  const msgs = buildPromptMessages({
    images: ["data:image/png;base64,AA", "data:image/png;base64,BB"],
    settings: {
      mode: "zero_shot",
      criteria: "cap seating; label skew; leakage",
      line: "Line-A",
      threshold: 0.6,
    },
  });
  assert.equal(msgs.length, 1);
  const text = msgs[0].content.find(c => c.type === "text").text;
  assert.match(text, /cap seating/);
  assert.match(text, /label skew/);
  assert.match(text, /leakage/);
  assert.match(text, /Line-A/);
  const imgs = msgs[0].content.filter(c => c.type === "image_url");
  assert.equal(imgs.length, 2);
});

test("buildPromptMessages few-shot includes OK and DEFECT reference labels", () => {
  const msgs = buildPromptMessages({
    images: ["data:image/png;base64,AA"],
    settings: {
      mode: "few_shot",
      criteria: "scratch",
      line: "Line-B",
      threshold: 0.5,
      references: [
        { label: "OK", image: "data:image/png;base64,OK1" },
        { label: "DEFECT", image: "data:image/png;base64,BAD1", note: "cap tilted" },
      ],
    },
  });
  const text = msgs[0].content.find(c => c.type === "text").text;
  assert.match(text, /reference/i);
  assert.match(text, /OK/);
  assert.match(text, /DEFECT/);
  assert.match(text, /cap tilted/);
  const imgs = msgs[0].content.filter(c => c.type === "image_url");
  // 2 references + 1 target
  assert.equal(imgs.length, 3);
});

test("validateBatchRequest accepts a normalized focus ROI on few-shot references", () => {
  const out = validateBatchRequest({
    images: ["data:image/png;base64,AA"],
    settings: {
      line: "L", model: "m", mode: "few_shot", resolution: 512, threshold: 0.5, criteria: "scratch",
      references: [
        { label: "OK", image: "data:image/png;base64,OK", focus_roi: [0.1, 0.2, 0.5, 0.4] },
        { label: "DEFECT", image: "data:image/png;base64,BAD", focus_roi: [0.1, 0.2, 0.5, 0.4] },
      ],
    },
  });
  assert.equal(out.ok, true);
});

test("validateBatchRequest rejects an invalid few-shot focus ROI", () => {
  const out = validateBatchRequest({
    images: ["data:image/png;base64,AA"],
    settings: {
      line: "L", model: "m", mode: "few_shot", resolution: 512, threshold: 0.5, criteria: "scratch",
      references: [
        { label: "OK", image: "data:image/png;base64,OK", focus_roi: [0.8, 0.2, 0.5, 0.4] },
        { label: "DEFECT", image: "data:image/png;base64,BAD" },
      ],
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /focus_roi/i);
});

test("buildPromptMessages explains user-selected reference ROI composites", () => {
  const msgs = buildPromptMessages({
    images: ["data:image/png;base64,TARGET"],
    settings: {
      mode: "few_shot", criteria: "seal damage", line: "Line-C", threshold: 0.5,
      references: [
        { label: "OK", image: "data:image/png;base64,OK", focus_roi: [0.1, 0.2, 0.5, 0.4] },
        { label: "DEFECT", image: "data:image/png;base64,BAD", focus_roi: [0.1, 0.2, 0.5, 0.4] },
      ],
    },
  });
  const text = msgs[0].content.find(c => c.type === "text").text;
  assert.match(text, /user-selected focus region/i);
  assert.match(text, /full context.*magnified crop/i);
});

test("reference focus is soft visual guidance, not a coordinate hard rule", () => {
  const msgs = buildPromptMessages({
    images: ["data:image/png;base64,TARGET"],
    settings: {
      mode: "few_shot", criteria: "label print and cap alignment", line: "Line-A", threshold: 0.55,
      references: [
        { label: "OK", image: "data:image/png;base64,OK", focus_roi: [0.2, 0.2, 0.4, 0.3] },
        { label: "DEFECT", image: "data:image/png;base64,BAD", focus_roi: [0.3, 0.1, 0.3, 0.4] },
      ],
    },
  });
  const text = msgs[0].content.find(c => c.type === "text").text;
  assert.match(text, /visual guidance.*not.*hard rule/i);
  assert.match(text, /ignore unrelated background/i);
  assert.match(text, /position|alignment/i);
});

test("buildReferenceFocusPlan keeps full context and adds crop padding", () => {
  const plan = buildReferenceFocusPlan([0.25, 0.2, 0.5, 0.4], 1000, 500);
  assert.equal(plan.width, 1024);
  assert.equal(plan.height, 512);
  // Floor/ceil pixel bounds conservatively include every selected edge pixel.
  assert.deepEqual(plan.cropSource, { x: 190, y: 76, w: 620, h: 249 });
  assert.ok(plan.contextDest.w > 0 && plan.contextDest.h > 0);
  assert.ok(plan.cropDest.w > 0 && plan.cropDest.h > 0);
  assert.ok(plan.contextDest.x < 512);
  assert.ok(plan.cropDest.x >= 512);
});

test("buildReferenceFocusPlan rejects a missing or degenerate ROI", () => {
  assert.throws(() => buildReferenceFocusPlan([0.1, 0.1, 0, 0.5], 100, 100));
  assert.throws(() => buildReferenceFocusPlan([0.9, 0.1, 0.2, 0.5], 100, 100));
});

test("buildReferenceFocusPlan tolerates floating-point ROIs that touch an edge", () => {
  const plan = buildReferenceFocusPlan([0, 0, 1.0000000000000002, 1], 1179, 2556);
  assert.deepEqual(plan.cropSource, { x: 0, y: 0, w: 1179, h: 2556 });
});

// ─── normalizeModelOutput ──────────────────────────────────────────
test("normalizeModelOutput strips markdown fences and parses JSON", () => {
  const raw = "```json\n{\"defect\":true,\"type\":\"scratch\",\"confidence\":0.82,\"items\":[]}\n```";
  const out = normalizeModelOutput(raw);
  assert.equal(out.defect, true);
  assert.equal(out.type, "scratch");
  assert.equal(out.confidence, 0.82);
});

test("normalizeModelOutput rejects string booleans and out-of-range confidence", () => {
  const raw = "{\"defect\":\"true\",\"type\":\"leak\",\"confidence\":1.7,\"bbox\":[0.1,0.2,0.5,0.6]}";
  const out = normalizeModelOutput(raw);
  assert.equal(out.protocol_error, true);
  assert.equal(out.defect, null);
});

test("normalizeModelOutput handles an exact items[] shape", () => {
  const raw = JSON.stringify({
    defect: true,
    type: "mixed",
    confidence: 0.75,
    items: [
      { type: "cap-tilt", bbox: [0.1, 0.1, 0.4, 0.4], severity: "high", reason: "cap misseated" },
      { type: "label-skew", bbox: [0.5, 0.6, 0.9, 0.8], severity: "medium", reason: "label is skewed" },
    ],
  });
  const out = normalizeModelOutput(raw);
  assert.equal(out.bboxes.length, 2);
  assert.equal(out.bboxes[0].severity, "high");
  assert.equal(out.bboxes[0].reason, "cap misseated");
  assert.equal(out.bboxes[1].severity, "medium");
});

test("normalizeModelOutput on garbage returns protocol-error fallback (never OK)", () => {
  const out = normalizeModelOutput("this is not json at all");
  // Must NOT be a fabricated defect=false OK — that historically caused
  // malformed model responses to be silently reported as passing units.
  assert.equal(out.protocol_error, true);
  assert.notEqual(out.defect, false);
  assert.equal(out.confidence, 0);
  assert.equal(out.type, "UNPARSED");
  assert.deepEqual(out.bboxes, []);
});

// ─── clampBoundingBoxes ────────────────────────────────────────────
test("clampBoundingBoxes clamps to [0,1] and drops invalid boxes", () => {
  const in_ = [
    { bbox: [-0.2, 0.1, 1.2, 0.9], type: "a" },
    { bbox: [0.3, 0.5, 0.2, 0.4], type: "inverted" }, // x2<x1
    { bbox: [0, 0, 0.5, 0.5], type: "ok" },
    { bbox: "junk", type: "junk" },
  ];
  const out = clampBoundingBoxes(in_);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].bbox, [0, 0.1, 1, 0.9]);
  assert.deepEqual(out[1].bbox, [0, 0, 0.5, 0.5]);
});

// ─── makeDemoResult ────────────────────────────────────────────────
test("makeDemoResult is deterministic for same seed", () => {
  const a = makeDemoResult({ seed: "abc-1", criteria: "cap;label;leak" });
  const b = makeDemoResult({ seed: "abc-1", criteria: "cap;label;leak" });
  assert.deepEqual(a, b);
});

test("makeDemoResult returns valid shape", () => {
  const r = makeDemoResult({ seed: "sku-42", criteria: "cap;label;leak;scratch" });
  assert.equal(typeof r.defect, "boolean");
  assert.equal(typeof r.type, "string");
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  assert.ok(Array.isArray(r.bboxes));
  if (r.defect) {
    assert.ok(r.bboxes.length >= 1);
    const b = r.bboxes[0].bbox;
    assert.ok(b[0] >= 0 && b[2] <= 1 && b[0] < b[2]);
  }
});

test("makeDemoResult varies across different seeds", () => {
  const results = [];
  for (let i = 0; i < 40; i++) results.push(makeDemoResult({ seed: "s-" + i, criteria: "c" }));
  const defects = results.filter(r => r.defect).length;
  // roughly balanced — 3..37 out of 40 is a safe deterministic band
  assert.ok(defects >= 3 && defects <= 37, `defects=${defects} out of range`);
});

// ─── resolveStaticPath ─────────────────────────────────────────────
test("resolveStaticPath resolves normal file inside root", () => {
  const r = resolveStaticPath("/index.html", "/srv/pub");
  assert.equal(r.ok, true);
  assert.ok(r.path.endsWith("/index.html"));
  assert.ok(r.path.startsWith("/srv/pub"));
});

test("resolveStaticPath rewrites '/' to /index.html", () => {
  const r = resolveStaticPath("/", "/srv/pub");
  assert.equal(r.ok, true);
  assert.ok(r.path.endsWith("index.html"));
});

test("resolveStaticPath rejects traversal", () => {
  for (const p of ["/../secret", "/foo/../../etc/passwd", "/..%2fbad"]) {
    const r = resolveStaticPath(p, "/srv/pub");
    assert.equal(r.ok, false, `should reject ${p}`);
  }
});

// ─── roiToPixels / pixelsToRoi ─────────────────────────────────────
test("roiToPixels converts normalized ROI to pixel rect", () => {
  const px = roiToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1000, 800);
  assert.deepEqual(px, { x: 250, y: 400, w: 500, h: 200 });
});

test("pixelsToRoi/roiToPixels round-trip within tolerance", () => {
  const src = { x: 100, y: 80, w: 400, h: 320 };
  const norm = pixelsToRoi(src, 1000, 800);
  const back = roiToPixels(norm, 1000, 800);
  assert.deepEqual(back, src);
});

test("roiToPixels clamps a rect that overflows the canvas", () => {
  const px = roiToPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 100, 100);
  assert.equal(px.x + px.w <= 100, true);
  assert.equal(px.y + px.h <= 100, true);
});

test("roiToPixels preserves a positive pixel for tiny valid edge ROIs", () => {
  assert.deepEqual(
    roiToPixels({ x: 0.999, y: 0.999, w: 0.001, h: 0.001 }, 2, 2),
    { x: 1, y: 1, w: 1, h: 1 },
  );
});

// ─── eventGateDecision ─────────────────────────────────────────────
test("eventGateDecision returns skip when change ratio below threshold", () => {
  const d = eventGateDecision({ changedPixels: 100, totalPixels: 10000, threshold: 0.05 });
  assert.equal(d.inspect, false);
  assert.match(d.reason, /below/i);
});

test("eventGateDecision returns inspect when change ratio above threshold", () => {
  const d = eventGateDecision({ changedPixels: 800, totalPixels: 10000, threshold: 0.05 });
  assert.equal(d.inspect, true);
});

test("eventGateDecision inspects when there is no previous frame", () => {
  const d = eventGateDecision({ changedPixels: 0, totalPixels: 0, threshold: 0.05 });
  assert.equal(d.inspect, true);
  assert.match(d.reason, /first|initial/i);
});

// ─── buildSnapshotTimes ────────────────────────────────────────────
test("buildSnapshotTimes returns monotonic times covering the duration at fps=2", () => {
  const t = buildSnapshotTimes(3, 2);
  // step = 0.5, so [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
  assert.deepEqual(t, [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]);
});

test("buildSnapshotTimes fps=1 emits one-per-second including t=duration", () => {
  const t = buildSnapshotTimes(4, 1);
  assert.deepEqual(t, [0, 1, 2, 3, 4]);
});

test("buildSnapshotTimes fps=8 upper bound is respected", () => {
  const t = buildSnapshotTimes(1, 8);
  // step = 0.125 → [0, 0.125, ..., 1.0] = 9 samples
  assert.equal(t.length, 9);
  assert.equal(t[0], 0);
  assert.equal(t[t.length - 1], 1);
});

test("buildSnapshotTimes handles fractional duration without exceeding it", () => {
  const t = buildSnapshotTimes(2.4, 2);
  // step 0.5 → 0, 0.5, 1, 1.5, 2 (2.5 would exceed)
  assert.equal(t.length, 5);
  for (const v of t) assert.ok(v <= 2.4, `${v} exceeds 2.4`);
});

test("buildSnapshotTimes returns [] for zero or negative duration", () => {
  assert.deepEqual(buildSnapshotTimes(0, 2), []);
  assert.deepEqual(buildSnapshotTimes(-3, 2), []);
});

test("buildSnapshotTimes returns [] for non-finite duration", () => {
  assert.deepEqual(buildSnapshotTimes(NaN, 2), []);
  assert.deepEqual(buildSnapshotTimes(Infinity, 2), []);
  assert.deepEqual(buildSnapshotTimes("abc", 2), []);
});

test("buildSnapshotTimes clamps fps into MIN..MAX", () => {
  // fps=0 or negative → treated as MIN (1)
  const low = buildSnapshotTimes(2, 0);
  assert.deepEqual(low, [0, 1, 2]);
  // fps well above MAX_SNAPSHOT_FPS clamps to MAX
  const high = buildSnapshotTimes(0.25, 999);
  assert.equal(high.length, Math.floor(0.25 * MAX_SNAPSHOT_FPS) + 1);
});

test("buildSnapshotTimes rounds fractional fps to integer", () => {
  const t = buildSnapshotTimes(2, 2.7);
  // 2.7 rounds to 3 → step 1/3 ≈ 0.333, 7 samples up to 2
  assert.equal(t.length, 7);
});

test("buildSnapshotTimes is strictly monotonic with no duplicates", () => {
  const t = buildSnapshotTimes(10, 8);
  for (let i = 1; i < t.length; i++) {
    assert.ok(t[i] > t[i - 1], `not strictly increasing at index ${i}: ${t[i-1]} vs ${t[i]}`);
  }
  // no exact duplicates
  const uniq = new Set(t.map(x => x.toFixed(6)));
  assert.equal(uniq.size, t.length);
});

test("buildSnapshotTimes caps output at maxFrames (default 200)", () => {
  const t = buildSnapshotTimes(600, 8); // would be ~4801 samples
  assert.equal(t.length, MAX_EXTRACTED_FRAMES);
  assert.equal(t.length, 200);
});

test("buildSnapshotTimes honors a custom cap argument", () => {
  const t = buildSnapshotTimes(60, 8, 50);
  assert.equal(t.length, 50);
});

test("buildSnapshotTimes final timestamp never exceeds duration", () => {
  for (const d of [0.4, 0.5, 1.0, 1.1, 2.5, 7.3, 60]) {
    for (const fps of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const t = buildSnapshotTimes(d, fps);
      if (t.length) assert.ok(t[t.length - 1] <= d + 1e-9, `d=${d} fps=${fps} last=${t[t.length-1]}`);
    }
  }
});

test("buildSnapshotTimes exports snapshot-fps bounds", () => {
  assert.equal(MIN_SNAPSHOT_FPS, 1);
  assert.equal(MAX_SNAPSHOT_FPS, 8);
});

test("waitForVideoMetadata rejects instead of hanging when metadata never arrives", async () => {
  class PendingVideo extends EventTarget {
    load() {}
  }
  await assert.rejects(
    waitForVideoMetadata(new PendingVideo(), 5),
    /metadata.*timeout/i,
  );
});

test("waitForVideoMetadata catches a metadata event emitted during load", async () => {
  class ReadyVideo extends EventTarget {
    load() { this.dispatchEvent(new Event("loadedmetadata")); }
  }
  const video = new ReadyVideo();
  assert.equal(await waitForVideoMetadata(video, 50), video);
});

test("createGenerationGate invalidates stale asynchronous work", () => {
  const gate = createGenerationGate();
  const first = gate.issue();
  const second = gate.issue();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
});

test("an oversized newer file selection invalidates an older pending generation", () => {
  const gate = createGenerationGate();
  const first = beginBoundedFileGeneration(gate, 1024, 12 * 1024 * 1024);
  const oversized = beginBoundedFileGeneration(gate, 13 * 1024 * 1024, 12 * 1024 * 1024);
  assert.equal(first.accepted, true);
  assert.equal(oversized.accepted, false);
  assert.equal(gate.isCurrent(first.generation), false);
  assert.equal(gate.isCurrent(oversized.generation), true);
});

test("detectRasterDimensions reads PNG and JPEG headers without decoding pixels", () => {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  png.set([73, 72, 68, 82], 12);
  new DataView(png.buffer).setUint32(16, 4000);
  new DataView(png.buffer).setUint32(20, 3000);
  assert.deepEqual(detectRasterDimensions(png), { width: 4000, height: 3000, format: "png" });

  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x07, 0x08, 0x0b, 0xb8, 0x0f, 0xa0,
  ]);
  assert.deepEqual(detectRasterDimensions(jpeg), { width: 4000, height: 3000, format: "jpeg" });
});

test("computeBoundedImageDimensions rejects decode bombs and bounds the long edge", () => {
  assert.deepEqual(computeBoundedImageDimensions(4000, 3000, 1536), { width: 1536, height: 1152 });
  assert.throws(() => computeBoundedImageDimensions(9000, 2000, 1536), /dimensions exceed/i);
  assert.throws(() => computeBoundedImageDimensions(5000, 4000, 1536), /pixel count exceeds/i);
});

test("buildInspectionSettingsSnapshot keeps one immutable reference set for a run", () => {
  const references = { OK: "data:image/jpeg;base64,ok", DEFECT: "data:image/jpeg;base64,bad" };
  const referenceRois = { OK: [0.1, 0.2, 0.3, 0.4], DEFECT: null };
  const snapshot = buildInspectionSettingsSnapshot({
    line: "Line-A", model: "model", mode: "few_shot", resolution: 768,
    threshold: 0.55, criteria: "criteria", references, referenceRois,
  });
  references.OK = "replacement";
  referenceRois.OK[0] = 0.9;
  assert.equal(snapshot.references[0].image, "data:image/jpeg;base64,ok");
  assert.deepEqual(snapshot.references[0].focus_roi, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.references), true);
});

// ─── countSelectedItems ────────────────────────────────────────────
test("countSelectedItems counts items with .selected truthy", () => {
  assert.equal(countSelectedItems([]), 0);
  assert.equal(countSelectedItems([{ selected: true }, { selected: false }, { selected: true }]), 2);
  assert.equal(countSelectedItems(null), 0);
  assert.equal(countSelectedItems(undefined), 0);
  assert.equal(countSelectedItems([{}, { selected: 1 }, { selected: "yes" }]), 2);
});

// ─── DEFAULT_CRITERIA sanity ───────────────────────────────────────
test("DEFAULT_CRITERIA includes cosmetic-specific defects", () => {
  const t = DEFAULT_CRITERIA.toLowerCase();
  assert.match(t, /cap/);
  assert.match(t, /label/);
  assert.match(t, /leak|contamin/);
  assert.match(t, /print|lot/);
});
