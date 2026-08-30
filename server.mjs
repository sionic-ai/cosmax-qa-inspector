// ═══════════════════════════════════════════════════════════════════
//  COSMAX QA Inspector — HTTP server
//  Live: proxies OpenGateway when OPENGATEWAY_API_KEY is set.
//  Demo: returns deterministic simulated results when the key is missing
//        (or when the client explicitly asks for mode=demo).
//
//  Hardening notes:
//    • Binds to 127.0.0.1 by default (not the wildcard 0.0.0.0).
//    • Host header is validated against the configured bind host + port;
//      requests with any other Host are rejected 400 before routing.
//    • CORS is same-origin only; POST inspection endpoints additionally
//      reject requests whose Origin does not match Host (403) and
//      requests without application/json (415).
//    • LIVE fetches are wrapped in an AbortController with an upstream
//      timeout AND a batch-wide deadline. The wait queue is bounded so a
//      flood returns 503 instead of exhausting file descriptors.
//    • A client TCP disconnect propagates into runBatchInspection and
//      cancels queued/inflight upstream calls — no credits spent after Stop.
//    • Upstream errors are mapped to stable generic codes; vendor
//      response bodies, request IDs, and raw messages never reach the
//      browser (a redacted diagnostic may be logged server-side).
//    • Default unit_ids are deterministic (never derived from Date.now()).
//    • Malformed model output becomes a REVIEW/protocol-error result — it
//      is never silently reported as an OK unit.
// ═══════════════════════════════════════════════════════════════════
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateBatchRequest,
  buildPromptMessages,
  normalizeModelOutput,
  makeDemoResult,
  resolveStaticPath,
  buildUnitId,
  isProtocolFailure,
  MAX_PAYLOAD_BYTES,
} from "./public/lib/inspector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 5173;
export const DEFAULT_HOST = "127.0.0.1";
const HOST = process.env.HOST || DEFAULT_HOST;

const API_URL = process.env.OPENGATEWAY_URL || "https://apis.opengateway.ai/v1/chat/completions";
const API_KEY_ENV = "OPENGATEWAY_API_KEY";
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 45_000;
const BATCH_DEADLINE_MS   = Number(process.env.BATCH_DEADLINE_MS)   || 120_000;
const LIVE_MAX_INFLIGHT   = Math.max(1, Number(process.env.LIVE_MAX_INFLIGHT) || 2);
const LIVE_MAX_WAITERS    = Math.max(0, Number(process.env.LIVE_MAX_WAITERS)  || 16);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

// ─── Host / Origin allow-listing ────────────────────────────────────
// The Host header is untrusted — a malicious client can send any string.
// We only serve when Host resolves to a loopback alias on the configured
// port (or the operator-provided HOST override). This closes DNS-rebinding
// vectors against the local demo binary.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "ipv6-localhost"]);

function parseHostHeader(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") return null;
  const m = hostHeader.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  if (!m) return null;
  return { hostname: m[1].replace(/^\[|\]$/g, "").toLowerCase(), port: Number(m[2]) };
}

export function isAllowedHost(hostHeader, opts = {}) {
  const { bindHost, port, trustProxyHosts = false } = opts;
  if (trustProxyHosts) {
    const value = String(hostHeader || "").toLowerCase();
    if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/.test(value)) return false;
    const portMatch = value.match(/:(\d{1,5})$/);
    return !portMatch || Number(portMatch[1]) <= 65535;
  }
  const bh = String(bindHost ?? HOST).toLowerCase();
  const pn = Number(port ?? PORT);
  const p = parseHostHeader(hostHeader);
  if (!p) return false;
  if (p.port !== pn) return false;
  if (LOOPBACK_HOSTNAMES.has(p.hostname)) return true;
  return p.hostname === bh;
}

export function isSafeOriginForHost(originHeader, hostHeader, opts) {
  if (!originHeader) return true; // no Origin ⇒ not a browser CORS request
  try {
    const u = new URL(originHeader);
    if (opts?.trustProxyHosts === true) {
      return (u.protocol === "http:" || u.protocol === "https:") &&
        u.host.toLowerCase() === String(hostHeader || "").toLowerCase() &&
        isAllowedHost(hostHeader, opts);
    }
    if (u.protocol !== "http:") return false;
    if (!isAllowedHost(u.host, opts)) return false;
    if (!isAllowedHost(hostHeader, opts)) return false;
    const a = parseHostHeader(u.host);
    const b = parseHostHeader(hostHeader);
    return !!(a && b && a.hostname === b.hostname && a.port === b.port);
  } catch { return false; }
}

// ─── Same-origin CORS decision (no wildcard) ────────────────────────
// Returns the origin string to echo, or null to omit the header entirely.
// Non-CORS same-origin requests (no Origin header) get null and work fine.
export function deriveCorsOrigin({ origin, host }) {
  if (!origin || !host) return null;
  try {
    const u = new URL(origin);
    const norm = (h) => (h || "").replace(/^\[|\]$/g, "").replace(/^ipv6-localhost$/i, "localhost");
    if (norm(u.host) === norm(host)) return origin;
    return null;
  } catch { return null; }
}

// ─── Global LIVE concurrency limiter with cancellable waiters ───────
// A bounded wait queue prevents a stampede from exhausting file
// descriptors. Waiters are cancellable via signal so a client TCP
// disconnect (or the batch deadline) doesn't leak a slot reservation.
let _inflight = 0;
const _waiters = [];

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
function overloadedError() {
  const e = new Error("server_overloaded");
  e.code = "OVERLOADED";
  e.status = 503;
  return e;
}

async function acquireLiveSlot({ signal, maxWaiters = LIVE_MAX_WAITERS } = {}) {
  if (signal?.aborted) throw abortError();
  if (_inflight < LIVE_MAX_INFLIGHT) { _inflight++; return; }
  if (_waiters.length >= maxWaiters) throw overloadedError();

  await new Promise((resolve, reject) => {
    const waiter = {
      resolve, reject, done: false,
      onAbort: () => {
        if (waiter.done) return;
        waiter.done = true;
        const idx = _waiters.indexOf(waiter);
        if (idx >= 0) _waiters.splice(idx, 1);
        reject(abortError());
      },
    };
    if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
    _waiters.push(waiter);
  });
  // releaseLiveSlot transfers the existing reservation atomically to us.
}

function releaseLiveSlot() {
  while (_waiters.length) {
    const next = _waiters.shift();
    if (next.done) continue;
    next.done = true;
    next.resolve();
    return;
  }
  _inflight = Math.max(0, _inflight - 1);
}

// ─── Signal composition (no AbortSignal.any dependency) ─────────────
function anySignal(...signals) {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

// ─── Upstream error redaction ───────────────────────────────────────
// The browser must never see vendor error bodies, request IDs, or raw
// exception messages. We map to a small stable enumeration and log a
// bounded, redacted diagnostic server-side (no Authorization, no API key).
function mapUpstreamCode(status) {
  if (status === 401 || status === 403) return "upstream_unauthorized";
  if (status === 429) return "upstream_rate_limited";
  if (status && status >= 500) return "upstream_unavailable";
  return "upstream_failed";
}
function logRedacted(event, fields) {
  try {
    const safe = JSON.parse(JSON.stringify(fields ?? {}));
    // Never persist auth tokens or full bodies.
    if (safe.headers) delete safe.headers.Authorization;
    if (safe.headers) delete safe.headers.authorization;
    const line = JSON.stringify({ event, ...safe }).slice(0, 500);
    console.warn(`[${new Date().toISOString()}] ${line}`);
  } catch { /* logging must never throw */ }
}

// ─── Live upstream call for one image ───────────────────────────────
async function callUpstream({ apiKey, model, messages, fetchImpl, signal }) {
  const payload = { model, messages, temperature: 0.1, max_tokens: 400 };
  const r = await fetchImpl(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal,
  });
  let data = {};
  try { data = await r.json(); } catch { /* leave data empty */ }
  if (!r.ok) {
    // Log only the stable status class. Vendor messages may contain request,
    // account, quota, balance, or token identifiers and must never cross the
    // abstraction boundary—even in local logs.
    logRedacted("upstream_error", { status: r.status, code: mapUpstreamCode(r.status) });
    const err = new Error(mapUpstreamCode(r.status));
    err.status = r.status;
    err.code = err.message;
    throw err;
  }
  const raw = data.choices?.[0]?.message?.content ?? "";
  const normalized = normalizeModelOutput(raw);
  normalized.usage = data.usage || null;
  return normalized;
}

// ─── Core: run one batch (used by HTTP handler and tests) ───────────
export async function runBatchInspection({
  body, apiKey,
  fetchImpl = globalThis.fetch,
  forceDemo = false,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
  batchDeadlineMs = BATCH_DEADLINE_MS,
  clientSignal,
}) {
  const v = validateBatchRequest(body);
  if (!v.ok) return { status: 400, body: { error: v.error } };

  const { images, settings } = v.value;
  const unitIds = Array.isArray(body.unit_ids) && body.unit_ids.length === images.length
    ? body.unit_ids
    : images.map((_, i) => buildUnitId({ line: settings.line, index: i }));

  const isDemo = forceDemo || !apiKey || settings.mode_override === "demo";

  const t0 = Date.now();
  const results = [];

  if (isDemo) {
    // Cheap, deterministic — no fanout, no network
    for (let i = 0; i < images.length; i++) {
      const r = makeDemoResult({ seed: unitIds[i], criteria: settings.criteria });
      results.push({ unit_id: unitIds[i], ...r });
    }
    return {
      status: 200,
      body: {
        mode: "demo",
        model: settings.model,
        line: settings.line,
        latency_ms: Date.now() - t0,
        batch_size: images.length,
        results,
      },
    };
  }

  // LIVE mode. Batch-wide deadline sits alongside the per-upstream timeout;
  // both are cancellable by a client disconnect signal.
  const batchAbort = new AbortController();
  const deadlineTimer = setTimeout(() => batchAbort.abort(), Math.max(1, batchDeadlineMs));
  const onClientAbort = () => batchAbort.abort();
  if (clientSignal) {
    if (clientSignal.aborted) batchAbort.abort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }

  const disconnectResponse = () => (
    clientSignal?.aborted
      ? { status: 499, body: { error: "client_disconnected" } }
      : { status: 504, body: { error: "batch_deadline_exceeded", timeout: true } }
  );

  try {
    // Cancellable slot acquisition — if the client already gave up, we never
    // reserve a slot (and therefore never spend an upstream credit).
    try {
      await acquireLiveSlot({ signal: batchAbort.signal });
    } catch (e) {
      if (e && e.code === "OVERLOADED") return { status: 503, body: { error: "server_overloaded" } };
      if (e && (e.name === "AbortError")) return disconnectResponse();
      throw e;
    }

    try {
      for (let i = 0; i < images.length; i++) {
        if (batchAbort.signal.aborted) return disconnectResponse();
        const timeoutAbort = new AbortController();
        const perTimer = setTimeout(() => timeoutAbort.abort(), upstreamTimeoutMs);
        const perSignal = anySignal(batchAbort.signal, timeoutAbort.signal);
        let r;
        try {
          const messages = buildPromptMessages({ images: [images[i]], settings });
          r = await callUpstream({
            apiKey, model: settings.model, messages, fetchImpl,
            signal: perSignal,
          });
        } catch (e) {
          clearTimeout(perTimer);
          const aborted =
            e?.name === "AbortError" ||
            /abort/i.test(String(e?.message || ""));
          if (aborted) {
            // Distinguish client disconnect vs batch deadline vs per-upstream timeout.
            if (clientSignal?.aborted || batchAbort.signal.aborted) {
              return disconnectResponse();
            }
            return { status: 502, body: { error: "upstream_timeout", timeout: true } };
          }
          const stableCode = typeof e?.code === "string" && /^upstream_(unauthorized|rate_limited|unavailable|failed)$/.test(e.code)
            ? e.code
            : "upstream_failed";
          return { status: 502, body: { error: stableCode } };
        } finally {
          clearTimeout(perTimer);
        }

        // Malformed model output = REVIEW, never a silent OK.
        if (isProtocolFailure(r)) {
          results.push({
            unit_id: unitIds[i],
            defect: null,
            type: "REVIEW",
            confidence: 0,
            bboxes: [],
            protocol_error: true,
            error: "model returned unparsable output",
          });
        } else {
          results.push({ unit_id: unitIds[i], ...r });
        }
      }
    } finally {
      releaseLiveSlot();
    }
  } finally {
    clearTimeout(deadlineTimer);
    if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
  }

  return {
    status: 200,
    body: {
      mode: "live",
      model: settings.model,
      line: settings.line,
      latency_ms: Date.now() - t0,
      batch_size: images.length,
      results,
    },
  };
}

// ─── Legacy single-image endpoint (kept for compatibility) ──────────
async function runSingleInspection({ body, apiKey, fetchImpl = globalThis.fetch, clientSignal }) {
  if (!body || typeof body.image !== "string") {
    return { status: 400, body: { error: "Missing image field" } };
  }
  const settings = {
    line: body.line || "Line-A",
    model: body.model || "moonshotai/kimi-k3-ultrafast",
    mode: "zero_shot",
    resolution: 768,
    threshold: 0.5,
    criteria: body.criteria || "cap seating; label skew; leak; scratch",
  };
  return runBatchInspection({
    body: { images: [body.image], settings, unit_ids: [body.unit_id || "single"] },
    apiKey, fetchImpl, clientSignal,
  });
}

// ─── Static file serving (path-traversal safe) ──────────────────────
async function serveStatic(reqPath, res) {
  const r = resolveStaticPath(reqPath, PUBLIC_ROOT);
  if (!r.ok) { res.writeHead(400).end("Bad request"); return; }
  try {
    const s = await stat(r.path);
    if (!s.isFile()) { res.writeHead(404).end("Not found"); return; }
    const buf = await readFile(r.path);
    const mime = MIME[path.extname(r.path).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// ─── HTTP handler ───────────────────────────────────────────────────
async function readJsonBody(req, limit = MAX_PAYLOAD_BYTES) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) { const e = new Error("payload too large"); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { const e = new Error("Invalid JSON"); e.status = 400; throw e; }
}

function jsonResponse(res, status, obj) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function textResponse(res, status, text) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function applyCors(req, res) {
  const originHeader = req.headers.origin;
  const hostHeader = req.headers.host;
  const allowed = deriveCorsOrigin({ origin: originHeader, host: hostHeader });
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  }
}

const INSPECT_PATHS = new Set(["/api/inspect", "/api/inspect/batch"]);

function requireJsonContent(req) {
  const mediaType = String(req.headers["content-type"] || "")
    .split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
}

// Wire req.aborted / socket close into an AbortController so long batches
// can cancel their upstream fanout when the client hangs up.
function clientDisconnectSignal(req, res) {
  const c = new AbortController();
  const abort = () => c.abort();
  req.on("close", () => { if (!req.complete) abort(); });
  req.on("aborted", abort);
  res.on("close", () => { if (!res.writableEnded) abort(); });
  req.socket?.on("close", () => { if (!res.writableEnded) abort(); });
  return c.signal;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      // Derive the effective bind host/port from the accepting socket so that
      // ephemeral-port test servers (listen(0)) validate against the actual
      // port, not the compile-time PORT default.
      const bindOpts = {
        bindHost: req.socket?.localAddress || HOST,
        port: req.socket?.localPort || PORT,
        trustProxyHosts: process.env.TRUST_PROXY_HOSTS === "1",
      };

      // 1. Host allow-list (before any routing)
      if (!isAllowedHost(req.headers.host, bindOpts)) {
        return jsonResponse(res, 400, { error: "bad_host" });
      }

      const url = new URL(req.url, `http://${req.headers.host}`);

      // Dependency-free process probe used by the shared service chart.
      if (url.pathname === "/_health" && req.method === "GET") {
        return textResponse(res, 200, "ok");
      }

      applyCors(req, res);
      if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

      // 2. Unsafe methods: require Origin to be same-origin (or absent)
      const unsafeMethod = req.method === "POST" || req.method === "PUT" || req.method === "DELETE" || req.method === "PATCH";
      if (unsafeMethod && !isSafeOriginForHost(req.headers.origin, req.headers.host, bindOpts)) {
        return jsonResponse(res, 403, { error: "forbidden_origin" });
      }

      // 3. Inspection POSTs must be JSON.
      if (req.method === "POST" && INSPECT_PATHS.has(url.pathname) && !requireJsonContent(req)) {
        return jsonResponse(res, 415, { error: "unsupported_media_type" });
      }

      // Batch endpoint
      if (url.pathname === "/api/inspect/batch" && req.method === "POST") {
        const body = await readJsonBody(req);
        const r = await runBatchInspection({
          body, apiKey: process.env[API_KEY_ENV] || "",
          clientSignal: clientDisconnectSignal(req, res),
        });
        return jsonResponse(res, r.status, r.body);
      }

      // Legacy single-image endpoint
      if (url.pathname === "/api/inspect" && req.method === "POST") {
        const body = await readJsonBody(req);
        const r = await runSingleInspection({
          body, apiKey: process.env[API_KEY_ENV] || "",
          clientSignal: clientDisconnectSignal(req, res),
        });
        if (r.status === 200 && r.body?.results?.length === 1) {
          const one = r.body.results[0];
          return jsonResponse(res, 200, { ...one, mode: r.body.mode, model: r.body.model, latency_ms: r.body.latency_ms });
        }
        return jsonResponse(res, r.status, r.body);
      }

      // Runtime info
      if (url.pathname === "/api/config" && req.method === "GET") {
        return jsonResponse(res, 200, {
          mode: process.env[API_KEY_ENV] ? "live" : "demo",
          server_version: "cosmax-qa-inspector/2.1.0",
          batch_min: 4, batch_max: 8,
          resolutions: [512, 768, 1024],
        });
      }

      if (req.method === "GET") {
        return serveStatic(url.pathname, res);
      }

      res.writeHead(405).end("Method Not Allowed");
    } catch (e) {
      const status = e.status || 500;
      // Never echo raw exception messages that might carry upstream detail.
      const code = status === 413 ? "payload_too_large"
                 : status === 400 ? (e.message || "bad_request")
                 : "internal_error";
      logRedacted("handler_error", { status, hint: String(e?.message || "").slice(0, 120) });
      jsonResponse(res, status, { error: code });
    }
  });
}

// Only listen if run directly (allow tests to import without a port bind).
const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    const mode = process.env[API_KEY_ENV] ? "LIVE" : "DEMO";
    console.log(`COSMAX QA Inspector [${mode}] ▸ http://${HOST}:${PORT}`);
  });
}
