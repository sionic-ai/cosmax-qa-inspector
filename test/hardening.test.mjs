// ═══════════════════════════════════════════════════════════════════
//  Blocker-fix tests (RED first, then GREEN after implementation).
//  Covers: reference budget, prepared dimensions, unit-id determinism,
//          malformed LIVE output surfacing as protocol_error, upstream
//          fetch timeout, CORS origin decision, and the run-token
//          snapshot helper used by the browser controller.
// ═══════════════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateBatchRequest,
  computePreparedDimensions,
  buildUnitId,
  normalizeModelOutput,
  isProtocolFailure,
  MAX_REFERENCES,
  MAX_PREPARED_SIDE,
  makeRunToken,
  snapshotEqual,
} from "../public/lib/inspector.mjs";

import { runBatchInspection, deriveCorsOrigin, DEFAULT_HOST } from "../server.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
function settings(overrides = {}) {
  return {
    line: "Line-A",
    model: "moonshotai/kimi-k3-ultrafast",
    mode: "zero_shot",
    resolution: 768,
    threshold: 0.5,
    criteria: "cap seating; label skew",
    ...overrides,
  };
}

// ─── Few-shot must require BOTH OK and DEFECT references (client+server) ─
test("validateBatchRequest few-shot requires at least one OK and one DEFECT", () => {
  const onlyOk = validateBatchRequest({
    images: [PNG],
    settings: settings({ mode: "few_shot", references: [{ label: "OK", image: PNG }] }),
  });
  assert.equal(onlyOk.ok, false);
  assert.match(onlyOk.error, /DEFECT/);

  const onlyDefect = validateBatchRequest({
    images: [PNG],
    settings: settings({ mode: "few_shot", references: [{ label: "DEFECT", image: PNG }] }),
  });
  assert.equal(onlyDefect.ok, false);
  assert.match(onlyDefect.error, /OK/);

  const both = validateBatchRequest({
    images: [PNG],
    settings: settings({
      mode: "few_shot",
      references: [
        { label: "OK", image: PNG },
        { label: "DEFECT", image: PNG },
      ],
    }),
  });
  assert.equal(both.ok, true);
});

// ─── Few-shot references bounded ──────────────────────────────────
test("validateBatchRequest few-shot bounds reference count", () => {
  const refs = [];
  for (let i = 0; i <= MAX_REFERENCES; i++) {
    refs.push({ label: i % 2 ? "OK" : "DEFECT", image: PNG });
  }
  const out = validateBatchRequest({
    images: [PNG],
    settings: settings({ mode: "few_shot", references: refs }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /reference/i);
});

// ─── Payload cap MUST include reference bytes ─────────────────────
test("validateBatchRequest payload cap counts reference bytes", () => {
  const huge = "data:image/png;base64," + "A".repeat(1_500_000);
  // 4 images + 2 references would exceed 6MB when references are counted
  const out = validateBatchRequest({
    images: [huge, huge, huge],
    settings: settings({
      mode: "few_shot",
      references: [
        { label: "OK", image: huge },
        { label: "DEFECT", image: huge },
      ],
    }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /large|payload/i);
});

// ─── computePreparedDimensions ────────────────────────────────────
test("computePreparedDimensions caps the long edge at MAX_PREPARED_SIDE", () => {
  const p = computePreparedDimensions({ srcW: 8000, srcH: 6000, target: 4096 });
  assert.ok(Math.max(p.outW, p.outH) <= MAX_PREPARED_SIDE, `long edge ${Math.max(p.outW, p.outH)} > ${MAX_PREPARED_SIDE}`);
  assert.ok(p.outW > 0 && p.outH > 0);
});

test("computePreparedDimensions normalizes extreme aspect ratios (>3:1)", () => {
  // 4000x100 (40:1) should be clamped so aspect stays <= 3:1
  const p = computePreparedDimensions({ srcW: 4000, srcH: 100, target: 768 });
  const ratio = Math.max(p.outW / p.outH, p.outH / p.outW);
  assert.ok(ratio <= 3 + 0.001, `aspect ratio ${ratio} not normalized`);
});

test("computePreparedDimensions is stable for a normal square input", () => {
  const p = computePreparedDimensions({ srcW: 1000, srcH: 1000, target: 768 });
  assert.equal(p.outW, 768);
  assert.equal(p.outH, 768);
});

// ─── Deterministic unit ID (no Date.now) ──────────────────────────
test("buildUnitId is deterministic and does not depend on time", () => {
  const a = buildUnitId({ line: "Line-A", index: 0 });
  const b = buildUnitId({ line: "Line-A", index: 0 });
  const c = buildUnitId({ line: "Line-A", index: 12 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  // Format: must include the line and a zero-padded index — never a millisecond timestamp.
  assert.match(a, /Line-A/);
  assert.doesNotMatch(a, /\d{10,}/, "unit id must not embed a millisecond timestamp");
});

test("runBatchInspection default unit_ids are stable across calls", async () => {
  const body = {
    images: [PNG, PNG, PNG, PNG],
    settings: settings(),
  };
  const r1 = await runBatchInspection({ body, apiKey: "" });
  const r2 = await runBatchInspection({ body, apiKey: "" });
  const ids1 = r1.body.results.map(r => r.unit_id);
  const ids2 = r2.body.results.map(r => r.unit_id);
  assert.deepEqual(ids1, ids2);
});

// ─── Malformed LIVE output surfaces as protocol error, never OK ──
test("normalizeModelOutput on garbage marks protocol_error and does not fabricate OK", () => {
  const out = normalizeModelOutput("this is not json at all");
  assert.equal(out.protocol_error, true);
  assert.equal(isProtocolFailure(out), true);
  assert.notEqual(out.defect, false, "unparsed output must not be reported as defect=false OK");
});

test("runBatchInspection LIVE turns malformed model output into a review/error result", async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: "utterly malformed !!! not json" } }] }),
  });
  const r = await runBatchInspection({
    body: { images: [PNG], settings: settings() },
    apiKey: "k",
    fetchImpl: fakeFetch,
  });
  assert.equal(r.status, 200);
  const item = r.body.results[0];
  assert.equal(item.protocol_error, true);
  assert.notEqual(item.defect, false, "must not be silently reported as OK");
});

// ─── Upstream timeout via AbortController ────────────────────────
test("runBatchInspection LIVE times out slow upstream calls", async () => {
  const slowFetch = async (_url, opts) => {
    // Wait for the abort signal to fire, then throw an AbortError like real fetch does.
    return await new Promise((_resolve, reject) => {
      if (opts?.signal?.aborted) {
        return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }
      opts.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  };
  const r = await runBatchInspection({
    body: { images: [PNG], settings: settings() },
    apiKey: "k",
    fetchImpl: slowFetch,
    upstreamTimeoutMs: 30,
  });
  assert.equal(r.status, 502);
  assert.match(JSON.stringify(r.body), /timeout|abort/i);
});

// ─── Same-origin CORS decision (no wildcard) ─────────────────────
test("deriveCorsOrigin returns null when Origin is absent (no CORS header needed)", () => {
  assert.equal(deriveCorsOrigin({ origin: undefined, host: "localhost:5173" }), null);
});

test("deriveCorsOrigin echoes only when Origin host matches server host", () => {
  assert.equal(
    deriveCorsOrigin({ origin: "http://localhost:5173", host: "localhost:5173" }),
    "http://localhost:5173",
  );
});

test("deriveCorsOrigin refuses cross-origin Origin (never returns wildcard)", () => {
  assert.equal(
    deriveCorsOrigin({ origin: "http://evil.example", host: "localhost:5173" }),
    null,
  );
});

// ─── Default bind is localhost, never 0.0.0.0 ────────────────────
test("server DEFAULT_HOST is loopback (127.0.0.1), never wildcard", () => {
  assert.equal(DEFAULT_HOST, "127.0.0.1");
});

// ─── Run-token snapshot helper (used by browser controller) ──────
test("makeRunToken issues monotonically increasing tokens", () => {
  const a = makeRunToken();
  const b = makeRunToken();
  const c = makeRunToken();
  assert.ok(b > a);
  assert.ok(c > b);
});

test("snapshotEqual returns true only for identical numeric tokens", () => {
  assert.equal(snapshotEqual(3, 3), true);
  assert.equal(snapshotEqual(3, 4), false);
  assert.equal(snapshotEqual(0, null), false);
  assert.equal(snapshotEqual(null, null), false); // null token means no run
});
