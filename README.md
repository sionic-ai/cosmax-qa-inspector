# COSMAX Cosmetic QA Inspector — Demo Studio 

> **Fictional customer demo.** Everything here — the "COSMAX" branding, the 4
> production lines, the 200-unit run, the SKU numbering — is invented for the
> purpose of showing how an OpenGateway VLM would look inside a cosmetic-line
> QA console. This is **not** a production QA system and is **not** a high-FPS
> throughput benchmark.

A vanilla-JS desktop inspection studio that runs one 200-unit demo batch,
draws convincing cosmetic packaging on the client, and asks either a real
OpenGateway vision model (LIVE mode) or a deterministic in-process simulator
(DEMO mode) to judge each unit against user-editable defect criteria.

<p>
  <strong>DEMO indicator</strong> = no API key present, results generated in
  <code>server.mjs</code> with a seeded RNG. Same seed → same result.<br>
  <strong>LIVE indicator</strong> = <code>OPENGATEWAY_API_KEY</code> is set,
  each unit hits <code>apis.opengateway.ai/v1/chat/completions</code>.
</p>

---

## Run

```bash
# DEMO mode (no key required) — everything works out of the box
npm start
# → open http://localhost:5173

# LIVE mode — talk to OpenGateway
export OPENGATEWAY_API_KEY="apik_xxx"
npm start
```

Node 20+ required. No dependencies to install.

```bash
npm test    # node:test suite (109 tests)
npm run check   # syntax check for server + browser modules
```

### Docker / deployment

The deploy image follows the internal web-service convention used by Mission
Control and other demo charts: **container port 3000** and a dependency-free
`GET /_health` probe. The image build runs syntax checks and the complete test
suite, then copies only runtime files into a non-root Alpine image.

```bash
docker build -t cosmax-qa-inspector:local .
docker run --rm -p 3000:3000 cosmax-qa-inspector:local
curl -fsS http://127.0.0.1:3000/_health  # ok
```

`OPENGATEWAY_API_KEY` may be injected at runtime for LIVE mode. The image sets
`HOST=0.0.0.0`, `PORT=3000`, and `TRUST_PROXY_HOSTS=1`; the last setting is for
deployment behind the company ingress and keeps unsafe browser requests
same-origin. Local non-container runs retain strict loopback Host validation.

Shared-chart probe values:

```yaml
service:
  httpPort: 3000
livenessProbe:
  httpGet: { path: /_health, port: http }
readinessProbe:
  httpGet: { path: /_health, port: http }
```

---

## Product scope & non-goals

**Scope**

- Four fictional lines (A립스틱 · B파운데이션 · C스킨케어 · D포장).
- Four source-media modes: built-in sample images, built-in sample video
  (procedural, deterministic), uploaded images (multi-select), or an
  uploaded video (client-side frame extraction).
- One finite run per press of ▶ 검사 시작, processed with a configured batch
  size of 4–8. The final transport batch may contain 1–3 remaining units.
  Run length is determined by the selected source (see
  "Media workflow" below).
- Zero-shot judgment against an editable criteria prompt, or few-shot with at
  least one OK and one DEFECT reference image (uploaded, generated, or captured
  from the current image/video frame). Each reference may have its own focus ROI.
- Client-drawn cosmetic package images with subtle defects (cap tilt, label
  skew, seal damage, leak, print blur, scratch, foreign particle).
- ROI editor (drag on the preview canvas) with previous/next preview
  navigation across images or extracted video frames.
- Event-gated inspection (per-ROI pixel-change threshold) applied to any
  source — images, procedural video frames, or uploaded video frames.
- Bounding-box overlays returned by the model or the demo simulator.

**Non-goals**

- Not a real-time high-FPS pipeline. The UI reports "demo throughput" only.
- Not a benchmark for OpenGateway TPS/latency — batches are throttled
  sequentially so a single browser can watch every result.
- Not a video codec harness. What plays in the browser is what we can inspect;
  unsupported codecs surface a friendly error rather than trying to transcode.
- No user auth, no persistence, no camera capture. Everything is in-memory.
- Uploaded video **never leaves the browser**. Only the sampled frames the
  UI decides to inspect are turned into `data:image/jpeg` and posted to
  `/api/inspect/batch`. See "Client-side privacy" below.

---

## UI walkthrough

The interface is a three-rail industrial inspection console: a compact setup
rail, a dominant warm-white inspection canvas and filmstrip, and a concise
verdict/metrics rail inside a restrained graphite shell. Start, Stop, status,
batch size, resolution and progress remain visible in the top command bar at
desktop demo resolutions.

```
┌───────── Setup (left) ────────────────┬─── ROI editor / queue ────┬── Spotlight ──┐
│ 1. Line select (4 buttons)             │  ROI preview + ◀ prev/next │  Latest      │
│ 2. Model + Zero/Few-shot toggle        │  ↳ drag to set inspection  │  result with │
│ 3. Source media tabs:                  │     region, "전체로" resets│  defect      │
│    · sample images (3 scenarios)        │  Extraction progress bar   │  boxes drawn │
│    · sample video (2 scenarios)         │  Progress · OK/BAD/SKIP    │  Recent 40   │
│    · upload images (multi, thumb select)│  Result cards grid         │  judgments   │
│    · upload video (client-side extract) │  (bounding boxes overlaid) │              │
│    Snapshot rate 1..8 fps (video only)  │                            │              │
│ 4. Batch size (4–8), resolution         │                            │              │
│    (512/768/1024), threshold,           │                            │              │
│    total units (synthetic-200 only)     │                            │              │
│ 5. Event-gate on/off + threshold        │                            │              │
│ 6. Start / Stop / Reset                 │                            │              │
└────────────────────────────────────────┴────────────────────────────┴──────────────┘
```

- **DEMO / LIVE indicator** lives in the top-right pill. Reflects the value
  returned from `GET /api/config` (mode is `live` iff the server has an API
  key at boot).
- **GLM 5.3 Flash Ultrafast** remains visible as `준비 중` but is disabled only
  by the frontend `<option disabled>` attribute. For an immediate controlled
  demo, a presenter may re-enable that option in browser DevTools; the server
  does not independently block the model ID.
- Keyboard: every control is a real `<button>` / `<input>` / `<select>`;
  focus is visible; the ROI canvas is `tabindex="0"` with an accessible label.
- Narrow viewports (≤1180 px) collapse to a two-column layout; ≤900 px stacks
  to a single column.

---

## Media workflow

The **소스 미디어** panel exposes four source kinds via tabs. Only the
selected source runs when you press ▶ 검사 시작.

| Source                | Where it comes from                             | Run size |
|-----------------------|-------------------------------------------------|----------|
| 샘플 이미지 · 합성 200 | Client-drawn deterministic packages, 1..200 units | 1..200 (defaults to 200 for the visual demo) |
| 샘플 이미지 · 시나리오 | Pre-drawn scenario set: `line-mixed-24` (OK/defect balance) or `line-defects-12` (defects-only) | Number selected (default: all) |
| 샘플 영상             | Procedural deterministic frames — `conveyor-stable` (6s, mostly stable) or `conveyor-events` (10s, intermittent packages). No large binaries in the repo. | `⌊duration × fps⌋ + 1`, capped at 200 |
| 이미지 업로드         | Multi-file `png / jpeg / webp`. All files start selected; click a thumbnail to include/exclude. | Number selected |
| 영상 업로드           | Any file the browser can decode (mp4/webm/mov). Metadata is loaded to get duration; the raw video file **never leaves the browser**. | Same formula as sample video |

### Snapshot rate (video sources only)

- Integer **1..8 frames per second**, default **2**.
- Pure helper `buildSnapshotTimes(durationSeconds, fps, maxFrames=200)`
  (see `public/lib/inspector.mjs`) produces the exact schedule of
  timestamps: `[0, 1/fps, 2/fps, …]`, strictly monotonic, every value
  `≤ duration`, no duplicates, non-finite or ≤0 duration → `[]`.
- **Frame cap: 200.** If the requested `fps × duration` would exceed 200
  frames, extraction stops at 200 and the UI displays a
  "상한 200 프레임 도달" note next to the estimate.
- Changing the FPS slider updates the estimated frame count *before*
  extraction and invalidates any previously extracted frames.

### Client-side extraction & privacy

- **Sample video** frames are drawn deterministically by `drawSampleVideoFrame`
  on demand at each timestamp — nothing is streamed or uploaded.
- **Uploaded video** is decoded by an `HTMLVideoElement` in the browser.
  For every timestamp in `buildSnapshotTimes(...)`, the app seeks the video
  (`video.currentTime = t`; awaits `seeked`) and draws the frame into an
  offscreen `<canvas>` sized to the target resolution.
- Extracted frames are immediately JPEG-compressed and their decoded canvas
  backing stores are released; only the frame being previewed or inspected is
  decoded again. This avoids retaining up to 200 raw 1024×1024 canvases.
- Only the resulting `data:image/jpeg` frames are POSTed to
  `/api/inspect/batch`, using the configured batch size of 4–8. A final
  partial request may contain 1–3 remaining frames. The raw video file is
  never read by the server.
- **Codec/decoder errors** (unsupported container, DRM-protected stream,
  corrupt file) surface as a friendly "영상 디코딩 실패…" error next to
  the Start button and abort the run without contacting the API.
- **Stop** aborts the extractor as soon as practical (checked between
  frames) and prevents any further batch posting.

### Preview navigation

The ROI editor shows either the currently selected image or the currently
selected video frame. Use ◀ / ▶ next to the ROI panel to step through
prior/next items or frames without starting a run. For the synthetic-200
scenario the preview is instead a freshly drawn package (there is no
finite list to navigate).

## Client-side ROI + event gate

- **ROI**: mouse-drag on `#roiCanvas` produces a normalized `{x,y,w,h}` in
  `[0,1]`. The canvas dims the outside area and shows a dashed teal outline.
  `roiToPixels` / `pixelsToRoi` handle canvas ↔ image coordinate conversion
  (both are unit-tested — see `test/inspector.test.mjs`).
- **Image preparation**: before send, the sample canvas is cropped to the
  ROI and resized so the short edge equals the target resolution
  (512 / 768 / 1024). Only prepared image data leaves the browser.
- **Event gate** (optional, off by default so the visual demo shows a useful
  mix of inspection results): when enabled, every generated frame's ROI is downsampled to 32×32,
  converted to grayscale, and compared to the previous ROI. If the changed-
  pixel ratio is below `eventThreshold`, the frame is marked `SKIP` and not
  sent. Skipped units render dimmed cards with a `SKIP` badge and a
  `변화 X.X%` meta line, visibly distinct from inspected results.
- Enable the gate to demonstrate client-side pre-filtering; lower the threshold
  to inspect more subtle changes or raise it to skip more frames.

### Few-shot reference focus regions

OK and DEFECT references have independent optional focus ROIs. Click **현재
화면** to capture the current image or extracted video frame, then **영역 지정**
to draw the comparison region. Applying it creates one browser-side visual
prompt containing:

1. the full reference image with a high-contrast ROI box; and
2. a magnified crop with 12% padding around that ROI.

The server also validates and describes the normalized `focus_roi` in the
few-shot prompt. This dual view is intentional: a crop raises effective detail
resolution while the full view preserves package context. It does not claim
pixel-perfect model grounding; accuracy still depends on model capability and
should be compared against the unmarked few-shot baseline on representative
line images.

The focus rectangle is **soft visual guidance, not a coordinate hard rule**.
The prompt tells the VLM to prioritize corresponding local evidence, ignore
unrelated background differences, and use the full image for product identity,
position, orientation and alignment. The box itself never determines the
verdict. We chose this provider-agnostic representation over crop-only or
coordinates-only prompting because it preserves global context while increasing
the effective detail of small cosmetic defects. The complete decision record,
alternatives, evidence, limitations and customer-data A/B plan are in
[`docs/few-shot-reference-roi-rationale.md`](docs/few-shot-reference-roi-rationale.md).

---

## Backend contract

### `POST /api/inspect/batch`

Request body (validated by `validateBatchRequest` in
`public/lib/inspector.mjs`):

```json
{
  "images": ["data:image/jpeg;base64,...", "..."],
  "unit_ids": ["LA-0001", "LA-0002"],
  "settings": {
    "line": "Line-A",
    "model": "moonshotai/kimi-k3-ultrafast",
    "mode": "zero_shot",
    "resolution": 768,
    "threshold": 0.55,
    "criteria": "cap seating; label skew/wrinkle; seal damage; ...",
    "references": [
      { "label": "OK",     "image": "data:image/jpeg;base64,..." },
      { "label": "DEFECT", "image": "data:image/jpeg;base64,...", "note": "cap tilted" }
    ]
  }
}
```

Rules:

- `images` — 1..8 items (server transport). UI enforces 4..8 per user batch.
- Each image must be a `data:image/(png|jpeg|jpg|webp);base64,...` URL.
- Total payload capped at 6 MB (`MAX_PAYLOAD_BYTES`).
- `resolution` must be one of `512 / 768 / 1024`.
- `mode` must be `zero_shot` or `few_shot`; `few_shot` requires at least one
  reference with `label` in `{ "OK", "DEFECT" }`.
- `threshold` must be a number in `[0, 1]`.

Response (`200`):

```json
{
  "mode": "demo",         // or "live"
  "model": "…",
  "line": "Line-A",
  "batch_size": 4,
  "latency_ms": 12,
  "results": [
    {
      "unit_id": "LA-0001",
      "defect": true,
      "type": "cap-tilt",
      "confidence": 0.83,
      "bboxes": [{
        "type": "cap-tilt",
        "bbox": [0.34, 0.18, 0.66, 0.35],  // normalized [x1,y1,x2,y2]
        "severity": "high",
        "reason": "cap not fully seated"
      }]
    }
  ]
}
```

### `POST /api/inspect` (legacy, single image)

Kept for backwards compatibility with earlier clients. Under the hood it
calls `runBatchInspection` with `images: [image]` and flattens the result
so old fields (`defect`, `type`, `confidence`, `latency_ms`) still work.

### `GET /api/config`

Returns runtime info so the UI can render the DEMO/LIVE pill:

```json
{ "mode": "demo", "server_version": "cosmax-qa-inspector/2.0.0",
  "batch_min": 4, "batch_max": 8, "resolutions": [512, 768, 1024] }
```

### Prompt construction

`buildPromptMessages` embeds the user-supplied `criteria`, the line name,
the confidence threshold, the schema the model must emit, and (in few-shot
mode) an inline list of reference labels + notes followed by the reference
image parts. See `test/inspector.test.mjs` for the exact contract.

### Model output normalization

`normalizeModelOutput` strips markdown fences, tolerates string booleans,
clamps `confidence` to `[0,1]`, promotes single `bbox` fields into an
`items[]` shape, drops boxes with inverted or non-numeric coordinates
(`clampBoundingBoxes`), and returns a safe fallback on unparseable output.

### Deterministic demo mode

When no API key is present, each result is produced by `makeDemoResult`
using an FNV-1a hash of `unit_id + "|" + criteria`. Same seed → same defect
type, confidence, and bounding box. This is what makes visual overlays
match the drawn defect: the client uses the same seeded plan when drawing
the package.

### Static file safety

`resolveStaticPath` refuses paths containing `..` segments, null bytes, or
any resolved path outside the `public/` root. Unit-tested for `/../secret`,
double-traversal, and percent-encoded variants.

---

## Files of interest

- `server.mjs` — HTTP surface + `runBatchInspection` orchestrator. Does not
  see raw video; only receives per-frame data URLs.
- `public/lib/inspector.mjs` — pure logic (validators, prompt builder, model
  normalizer, bbox clamp, ROI math, event-gate decision, demo simulator,
  `buildSnapshotTimes`, `countSelectedItems`). Imported by both the server
  and the browser and directly test-covered.
- `public/app.js` — browser controller (state, ROI editor, package
  generator, source-media panel, thumbnail selector, procedural
  video-frame generator, uploaded-video seek/extract loop, batch runner).
- `public/index.html` + `public/styles.css` — three-column desktop studio.
- `test/*.test.mjs` — 91 `node:test` cases,
  including boundary coverage for `buildSnapshotTimes` (fps 1/8, fractional
  duration, zero/invalid, cap-200, monotonic/no duplicates, final timestamp).

## What isn't real about this demo

- The four lines, SKUs, and lot codes are procedurally generated strings.
- The "packages" are drawn with `CanvasRenderingContext2D`; a real QA system
  would ingest camera frames from the line PLC.
- LIVE OpenGateway calls fan out one HTTP request per unit; a real system
  would use a proper multiplexed batch API and back-pressure.
- The event gate compares against the *previous drawn frame*, not against a
  reference "empty conveyor" plate.
- Sample-video scenarios are procedural — they draw the same package
  generator used for sample images, gated by timestamp. No real camera or
  encoded stream is involved.
- Uploaded-video decoding is delegated to the browser's media stack. Support
  varies (Safari ≠ Chrome for some codecs). A file that "plays" in an
  `<video>` tag will extract cleanly; a file that does not is reported as
  a decode error rather than transcoded server-side.

Use it to talk about the interaction model — not the throughput numbers.
