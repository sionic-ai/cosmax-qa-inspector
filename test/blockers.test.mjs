// ═══════════════════════════════════════════════════════════════════
//  Codex-review blocker fixes — RED tests written first, GREEN after
//  the corresponding server/inspector hardening is in place.
//
//  Covers:
//    B1  strict normalizeModelOutput (schema-invalid → protocol_error)
//    B2  LIVE cancellation / bounded wait queue / batch deadline
//    B3  local-origin safety (Host, Origin on POST, Content-Type)
//    B4  full effective payload budget + per-field string caps
//    B6  redacted upstream errors (no vendor body / IDs leak to browser)
// ═══════════════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  validateBatchRequest,
  normalizeModelOutput,
  isProtocolFailure,
  MAX_LINE_LEN,
  MAX_MODEL_LEN,
  MAX_UNIT_ID_LEN,
  MAX_CRITERIA_LEN,
  MAX_REFERENCE_NOTE_LEN,
  MAX_PAYLOAD_BYTES,
} from "../public/lib/inspector.mjs";

import {
  runBatchInspection,
  isAllowedHost,
  isSafeOriginForHost,
  createServer,
} from "../server.mjs";

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

// ─── B1 · normalizeModelOutput strict schema ────────────────────────
test("normalizeModelOutput: {} is a protocol error, not an OK unit", () => {
  const out = normalizeModelOutput("{}");
  assert.equal(isProtocolFailure(out), true);
  assert.notEqual(out.defect, false, "empty object must not become a passing OK");
});

test("normalizeModelOutput: missing defect field → protocol error", () => {
  const out = normalizeModelOutput(JSON.stringify({ type: "OK", confidence: 0.9, items: [] }));
  assert.equal(isProtocolFailure(out), true);
});

test("normalizeModelOutput: missing confidence field → protocol error", () => {
  const out = normalizeModelOutput(JSON.stringify({ defect: false, type: "OK", items: [] }));
  assert.equal(isProtocolFailure(out), true);
});

test("normalizeModelOutput: non-numeric confidence (string) → protocol error", () => {
  const out = normalizeModelOutput(JSON.stringify({ defect: false, type: "OK", confidence: "0.8", items: [] }));
  assert.equal(isProtocolFailure(out), true);
});

test("normalizeModelOutput: NaN / Infinity confidence → protocol error", () => {
  const a = normalizeModelOutput('{"defect":true,"type":"x","confidence":null,"items":[]}');
  assert.equal(isProtocolFailure(a), true);
});

test("normalizeModelOutput: unrecognised defect value → protocol error", () => {
  const a = normalizeModelOutput('{"defect":"maybe","type":"x","confidence":0.5,"items":[]}');
  const b = normalizeModelOutput('{"defect":1,"type":"x","confidence":0.5,"items":[]}');
  const c = normalizeModelOutput('{"defect":null,"type":"x","confidence":0.5,"items":[]}');
  assert.equal(isProtocolFailure(a), true);
  assert.equal(isProtocolFailure(b), true);
  assert.equal(isProtocolFailure(c), true);
});

test("normalizeModelOutput: items must be an array when present", () => {
  const out = normalizeModelOutput('{"defect":false,"type":"OK","confidence":0.9,"items":"none"}');
  assert.equal(isProtocolFailure(out), true);
});

test("normalizeModelOutput: array top-level → protocol error", () => {
  const out = normalizeModelOutput('[{"defect":true,"confidence":0.9}]');
  assert.equal(isProtocolFailure(out), true);
});

test("normalizeModelOutput: complete valid shape parses to a normal result", () => {
  const raw = JSON.stringify({
    defect: true, type: "cap-tilt", confidence: 0.9,
    items: [{ type: "cap-tilt", bbox: [0.1, 0.1, 0.4, 0.4], severity: "high", reason: "cap misseated" }],
  });
  const out = normalizeModelOutput(raw);
  assert.equal(out.protocol_error, undefined);
  assert.equal(out.defect, true);
  assert.equal(out.type, "cap-tilt");
  assert.equal(out.confidence, 0.9);
  assert.equal(out.bboxes.length, 1);
});

// ─── B4 · per-field string caps + full effective payload budget ─────
test("validateBatchRequest rejects an oversized criteria string", () => {
  const bad = {
    images: [PNG],
    settings: settings({ criteria: "x".repeat(MAX_CRITERIA_LEN + 1) }),
  };
  const out = validateBatchRequest(bad);
  assert.equal(out.ok, false);
  assert.match(out.error, /criteria/i);
});

test("validateBatchRequest rejects an oversized line/model/unit_id", () => {
  const longLine = validateBatchRequest({ images: [PNG], settings: settings({ line: "L".repeat(MAX_LINE_LEN + 1) }) });
  const longModel = validateBatchRequest({ images: [PNG], settings: settings({ model: "M".repeat(MAX_MODEL_LEN + 1) }) });
  const longId = validateBatchRequest({
    images: [PNG],
    unit_ids: ["U".repeat(MAX_UNIT_ID_LEN + 1)],
    settings: settings(),
  });
  assert.equal(longLine.ok, false);
  assert.equal(longModel.ok, false);
  assert.equal(longId.ok, false);
});

test("validateBatchRequest rejects an oversized reference note", () => {
  const out = validateBatchRequest({
    images: [PNG],
    settings: settings({
      mode: "few_shot",
      references: [
        { label: "OK",     image: PNG },
        { label: "DEFECT", image: PNG, note: "n".repeat(MAX_REFERENCE_NOTE_LEN + 1) },
      ],
    }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /note/i);
});

test("validateBatchRequest counts full effective payload (images + strings) against MAX_PAYLOAD_BYTES", () => {
  const bigImage = "data:image/png;base64," + "A".repeat(1_500_000); // ~1.5MB each
  const filler = "z".repeat(Math.max(0, MAX_CRITERIA_LEN - 100));
  const out = validateBatchRequest({
    images: [bigImage, bigImage, bigImage, bigImage],
    settings: settings({ criteria: filler }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /large|payload/i);
});

// ─── B2 · LIVE cancellation + admission control ─────────────────────
test("runBatchInspection LIVE returns client_disconnected when clientSignal fires mid-flight", async () => {
  const clientController = new AbortController();
  let calls = 0;
  const fakeFetch = async (_url, opts) => {
    calls++;
    // Fire the client abort on first upstream call, then wait for the propagated abort.
    if (calls === 1) queueMicrotask(() => clientController.abort());
    return await new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  };
  const r = await runBatchInspection({
    body: { images: [PNG, PNG, PNG, PNG], settings: settings() },
    apiKey: "k",
    fetchImpl: fakeFetch,
    clientSignal: clientController.signal,
  });
  // Stable status code; must NOT be a 200/OK
  assert.notEqual(r.status, 200);
  assert.match(JSON.stringify(r.body), /disconnect|aborted|cancel/i);
});

test("runBatchInspection LIVE respects a batch-wide deadline distinct from per-upstream timeout", async () => {
  const fakeFetch = async (_url, opts) => {
    return await new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
  const r = await runBatchInspection({
    body: { images: [PNG, PNG, PNG, PNG], settings: settings() },
    apiKey: "k",
    fetchImpl: fakeFetch,
    upstreamTimeoutMs: 5_000,   // per-call timeout very generous
    batchDeadlineMs: 50,        // batch deadline tight → should fire first
  });
  // Batch deadline fires before per-upstream timeout → status is stable and non-200
  assert.notEqual(r.status, 200);
  assert.match(JSON.stringify(r.body), /deadline|timeout|abort/i);
});

// ─── B3 · Local-origin safety helpers ───────────────────────────────
test("isAllowedHost accepts loopback aliases with the configured port", () => {
  assert.equal(isAllowedHost("127.0.0.1:5173", { bindHost: "127.0.0.1", port: 5173 }), true);
  assert.equal(isAllowedHost("localhost:5173", { bindHost: "127.0.0.1", port: 5173 }), true);
  assert.equal(isAllowedHost("[::1]:5173",     { bindHost: "127.0.0.1", port: 5173 }), true);
});

test("isAllowedHost rejects wrong port or non-loopback hostname", () => {
  assert.equal(isAllowedHost("localhost:9999",       { bindHost: "127.0.0.1", port: 5173 }), false);
  assert.equal(isAllowedHost("evil.example.com:5173",{ bindHost: "127.0.0.1", port: 5173 }), false);
  assert.equal(isAllowedHost("127.0.0.1",            { bindHost: "127.0.0.1", port: 5173 }), false);
  assert.equal(isAllowedHost("",                     { bindHost: "127.0.0.1", port: 5173 }), false);
});

test("isAllowedHost accepts ingress and pod hosts only in trusted-proxy mode", () => {
  const opts = { bindHost: "0.0.0.0", port: 3000, trustProxyHosts: true };
  assert.equal(isAllowedHost("cosmax-demo.sionic.tech", opts), true);
  assert.equal(isAllowedHost("10.42.3.9:3000", opts), true);
  assert.equal(isAllowedHost("bad host", opts), false);
});

test("isSafeOriginForHost supports HTTPS ingress while preserving same-origin", () => {
  const opts = { bindHost: "0.0.0.0", port: 3000, trustProxyHosts: true };
  assert.equal(isSafeOriginForHost("https://cosmax-demo.sionic.tech", "cosmax-demo.sionic.tech", opts), true);
  assert.equal(isSafeOriginForHost("https://evil.example", "cosmax-demo.sionic.tech", opts), false);
});

test("isSafeOriginForHost passes when Origin is absent (non-CORS)", () => {
  assert.equal(isSafeOriginForHost(undefined, "127.0.0.1:5173", { bindHost: "127.0.0.1", port: 5173 }), true);
});

test("isSafeOriginForHost requires Origin host to match Host header", () => {
  const opts = { bindHost: "127.0.0.1", port: 5173 };
  assert.equal(isSafeOriginForHost("http://127.0.0.1:5173", "127.0.0.1:5173", opts), true);
  assert.equal(isSafeOriginForHost("http://evil.example",    "127.0.0.1:5173", opts), false);
  assert.equal(isSafeOriginForHost("http://127.0.0.1:9999",  "127.0.0.1:5173", opts), false);
});

// ─── B3 · Server-level end-to-end HTTP checks on an ephemeral port ─
async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try { return await fn(port); }
  finally { await new Promise((r) => server.close(r)); }
}

function req({ port, method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

test("server rejects requests with a mismatched Host header", async () => {
  await withServer(async (port) => {
    const r = await req({ port, method: "GET", path: "/api/config", headers: { Host: "evil.example:80" } });
    assert.equal(r.status, 400);
    assert.match(r.body, /host/i);
  });
});

test("GET /_health returns dependency-free probe response", async () => {
  await withServer(async (port) => {
    const r = await req({ port, path: "/_health", headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(r.status, 200);
    assert.equal(r.body, "ok");
    assert.match(String(r.headers["content-type"]), /^text\/plain/);
    assert.equal(r.headers["cache-control"], "no-store");
  });
});

test("server rejects POST inspection with cross-origin Origin", async () => {
  await withServer(async (port) => {
    const r = await req({
      port, method: "POST", path: "/api/inspect/batch",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
        Origin: "http://evil.example",
        "Content-Length": "2",
      },
      body: "{}",
    });
    assert.equal(r.status, 403);
    assert.match(r.body, /origin/i);
  });
});

test("server rejects POST inspection with wrong Content-Type", async () => {
  await withServer(async (port) => {
    const r = await req({
      port, method: "POST", path: "/api/inspect/batch",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "text/plain",
        "Content-Length": "2",
      },
      body: "{}",
    });
    assert.equal(r.status, 415);
  });
});

test("server accepts valid local POST inspection", async () => {
  await withServer(async (port) => {
    const body = JSON.stringify({
      images: [PNG, PNG, PNG, PNG],
      settings: settings(),
    });
    const r = await req({
      port, method: "POST", path: "/api/inspect/batch",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      body,
    });
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body);
    assert.equal(data.mode, "demo");
    assert.equal(data.results.length, 4);
  });
});

// ─── B6 · Redacted upstream errors ──────────────────────────────────
test("runBatchInspection LIVE error surface never leaks vendor detail / IDs", async () => {
  const secret = "SECRET_VENDOR_ID_ABC123";
  const fakeFetch = async () => ({
    ok: false, status: 500,
    json: async () => ({
      error: { message: "internal wire-protocol failure", request_id: secret },
      trace_id: secret,
    }),
  });
  const r = await runBatchInspection({
    body: { images: [PNG, PNG, PNG, PNG], settings: settings() },
    apiKey: "k",
    fetchImpl: fakeFetch,
  });
  const s = JSON.stringify(r.body);
  assert.doesNotMatch(s, new RegExp(secret));
  assert.doesNotMatch(s, /wire-protocol/i);
  assert.doesNotMatch(s, /trace_id|request_id/i);
});

test("runBatchInspection LIVE 401 → stable upstream_unauthorized code, no body echo", async () => {
  const fakeFetch = async () => ({
    ok: false, status: 401,
    json: async () => ({ error: { message: "bad key eyJhb.xyz" } }),
  });
  const r = await runBatchInspection({
    body: { images: [PNG, PNG, PNG, PNG], settings: settings() },
    apiKey: "bad",
    fetchImpl: fakeFetch,
  });
  const s = JSON.stringify(r.body);
  assert.match(s, /unauthorized/i);
  assert.doesNotMatch(s, /eyJhb/);
});
