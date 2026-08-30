import { test } from "node:test";
import assert from "node:assert/strict";

import { runBatchInspection } from "../server.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function goodBody(overrides = {}) {
  const { settings: settingsOverride, ...rest } = overrides;
  return {
    images: [PNG, PNG, PNG, PNG],
    ...rest,
    settings: {
      line: "Line-A",
      model: "moonshotai/kimi-k3-ultrafast",
      mode: "zero_shot",
      resolution: 768,
      threshold: 0.5,
      criteria: "cap seating; label skew",
      ...settingsOverride,
    },
  };
}

test("runBatchInspection rejects invalid body with 400", async () => {
  const r = await runBatchInspection({ body: { images: [] }, apiKey: "" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /images/);
});

test("runBatchInspection with no API key returns deterministic demo results", async () => {
  const body = goodBody();
  const r1 = await runBatchInspection({ body, apiKey: "" });
  const r2 = await runBatchInspection({ body, apiKey: "" });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.mode, "demo");
  assert.equal(r1.body.results.length, body.images.length);
  assert.deepEqual(r1.body.results.map(x => x.type), r2.body.results.map(x => x.type));
  for (const res of r1.body.results) {
    assert.equal(typeof res.defect, "boolean");
    assert.ok(res.confidence >= 0 && res.confidence <= 1);
    assert.ok(Array.isArray(res.bboxes));
  }
});

test("runBatchInspection demo mode uses per-image seed so results differ across images", async () => {
  // Run two batches of 8 seeds — 16 draws makes 'all identical' vanishingly unlikely
  const ids = Array.from({ length: 8 }, (_, i) => `sku-A-${i}`);
  const body = goodBody({ images: new Array(8).fill(PNG), unit_ids: ids });
  const r = await runBatchInspection({ body, apiKey: "" });
  assert.equal(r.status, 200);
  const types = new Set(r.body.results.map(x => x.type));
  const confidences = new Set(r.body.results.map(x => x.confidence));
  assert.ok(types.size >= 2 || confidences.size >= 2, `demo results too uniform: ${[...types]}`);
});

test("runBatchInspection LIVE path calls fetchImpl with prompt containing criteria", async () => {
  let seenBody = null;
  const fakeFetch = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"defect":true,"type":"cap-tilt","confidence":0.9,"items":[{"type":"cap-tilt","bbox":[0.1,0.1,0.4,0.4],"severity":"high","reason":"cap misseated"}]}' } }],
        usage: { total_tokens: 42 },
      }),
    };
  };
  const body = goodBody({ settings: { criteria: "MY-UNIQUE-CRITERIA-XYZ" } });
  const r = await runBatchInspection({ body, apiKey: "test-key", fetchImpl: fakeFetch });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "live");
  assert.equal(r.body.results.length, 4);
  const msg = seenBody.messages[0].content.find(c => c.type === "text").text;
  assert.match(msg, /MY-UNIQUE-CRITERIA-XYZ/);
  // one live call per image
});

test("runBatchInspection LIVE surfaces upstream error", async () => {
  const fakeFetch = async () => ({
    ok: false, status: 401,
    json: async () => ({ error: { message: "unauthorized" } }),
  });
  const r = await runBatchInspection({ body: goodBody(), apiKey: "bad", fetchImpl: fakeFetch });
  assert.equal(r.status, 502);
  assert.match(JSON.stringify(r.body), /unauthorized/);
});

test("runBatchInspection few_shot LIVE includes reference images in the prompt", async () => {
  let seenBody = null;
  const fakeFetch = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"defect":false,"type":"OK","confidence":0.9,"items":[]}' } }] }),
    };
  };
  const body = goodBody({
    images: [PNG],
    settings: {
      mode: "few_shot",
      references: [
        { label: "OK", image: PNG },
        { label: "DEFECT", image: PNG, note: "cap tilt" },
      ],
    },
  });
  const r = await runBatchInspection({ body, apiKey: "k", fetchImpl: fakeFetch });
  assert.equal(r.status, 200);
  const imgParts = seenBody.messages[0].content.filter(c => c.type === "image_url");
  assert.equal(imgParts.length, 3); // 2 refs + 1 target
});
