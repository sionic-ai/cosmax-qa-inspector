# COSMAX: training-free anomaly detection with frontier VLMs

**Recommendation (2026-08-30):** keep the current OpenAI-compatible image-in/JSON-out contract and add a **selective two-pass inspection policy** around it: (1) retrieve only the most relevant normal reference(s), (2) run a global scout over the existing context+ROI composite, and (3) invoke a blinded local verifier only for ambiguous, tiny, safety-critical, or low-quality cases. Convert disagreement and weak evidence to `REVIEW`; do not treat a model's self-reported number as calibrated probability.

This is a natural API-only adaptation of recent training-free work, not a claim to reproduce its algorithms. The strongest training-free detectors use patch embeddings, segmentation models, feature memory banks, or score calibration unavailable through a generic chat-completions API. AnomalyDINO, for example, performs nearest-neighbor matching against a DINOv2 patch-feature memory bank.[3] UniVAD combines component segmentation, component-aware patch matching, and graph-enhanced component modeling.[2] LogSAD uses an LMM to propose interests and compositional rules, but its actual multi-granularity detectors still use CLIP/DINOv2/SAM features and anomaly-free statistics.[5] Requiring those systems in the demo would add model hosting, GPU/runtime dependencies, and a second visual stack—the opposite of a minimal, provider-agnostic change.

## Why this change, not a new detector

Current MLLMs are useful inspectors but not reliable standalone measurement instruments. MMAD evaluated 8,366 industrial images and 39,672 questions; its best reported model averaged 74.9%, which the authors explicitly describe as below industrial requirements.[1] Its normal-template experiment is also cautionary: the closest normal image often hurt models, only some larger models used it effectively, and increasing the number of normal examples eventually caused information overload.[1] Therefore COSMAX should **retrieve and limit** references, then measure the effect by model rather than assuming that more images are better.

The closest implementation precedent is Echo: it retrieves the most similar normal image and context-specific defect knowledge before asking an MLLM to decide; its ablation reported anomaly-detection accuracy falling from 83.22% to 78.70% when the reference extractor was removed.[6] Echo uses a CLIP retriever, so it is not API-only as published, but its separation of retrieval, knowledge, and decision maps cleanly onto COSMAX.

Recent AgentIAD provides the clearest architecture pattern: iteratively zoom suspicious regions and retrieve a normal comparator for verification.[7]
It reports that the median anomaly occupies only 0.58% of an MMAD image, motivating its zoom tool.[7]
However, AgentIAD is **not training-free**: it trains a Qwen2.5-VL agent with supervised fine-tuning and reinforcement learning.[7]
Anomaly-OV's “look twice” mechanism is another global/local precedent, but it likewise changes and trains model internals rather than offering an API-only inference recipe.[4]
COSMAX should borrow only the inference policy—scout, zoom, compare, abstain—not either trained model.

## Proposed API-only pipeline

```text
client event gate (existing)
  -> reference selector (same line/SKU/ROI; top 1, optionally top 2)
  -> PASS 1: SCOUT (fast configured model; full context + enlarged ROI)
       | decisive, visible, non-critical, sufficiently large
       +-----------------------------------------------> final candidate
       | uncertain / tiny / critical / quality issue
       v
     PASS 2: VERIFY (same or stronger configured vision model)
       -> deterministic consensus + evidence gates
       -> OK | DEFECT | REVIEW
```

### 1. Reference retrieval: normal-first and small

**Default:** top-1 `OK` reference; test top-2. Keep a defect example optional, not mandatory. Industrial anomaly detection is fundamentally a one-class comparison against normality, while the current UI's mandatory `OK + DEFECT` pair can anchor the model toward a known defect and does not represent unseen anomalies.

Selection can remain dependency-free and in-browser:

1. Hard-filter by line, SKU/package family, camera/ROI ID, and expected orientation.
2. Reuse the existing 32×32 ROI signature in `public/app.js`; compare illumination-normalized grayscale/gradient signatures only inside the hard-filtered group.
3. Rank primarily for pose/geometry and secondarily for appearance. Send stable `reference_id` and metadata with each selected image.
4. Exclude references not explicitly approved as normal. Never auto-promote a recent target to the normal bank.
5. Cap the prompt at 1–2 normal references. Do not send all six merely because validation permits six.

For the smallest UI diff, change the existing OK slot to accept up to four thumbnails and make the DEFECT slot optional behind an “advanced comparison” toggle. `MAX_REFERENCES = 6` already exists. If even that is too much for the first demo, use a fixed per-line bank in memory and expose only the selected reference IDs in the result card.

**Important control:** retrieval is a hypothesis, not a guaranteed improvement. MMAD found mixed normal-template results and degradation with too many images.[1] The ablation must compare fixed, random, top-1, top-2, and all-reference policies.

### 2. Pass 1: global scout

Use the existing target presentation: full-context image with marked ROI plus the padded magnified crop. Ask for observations before a verdict, but keep the output compact and machine-readable.

```json
{
  "quality": "usable|blur|glare|occluded|misaligned",
  "global_checks": {
    "identity_match": true,
    "count_layout_ok": true,
    "reference_comparable": true
  },
  "candidates": [{
    "bbox": [0.0, 0.0, 1.0, 1.0],
    "criterion": "seal-damage",
    "observed_fact": "visible tear crossing the seal edge",
    "expected_normal": "continuous unbroken edge",
    "reference_ids": ["OK-LA-017"]
  }],
  "provisional": "OK|DEFECT|REVIEW",
  "confidence": 0.0,
  "needs_verification": true
}
```

Prompt rules:

- Compare like-for-like region and geometry; do not call lighting, print design, or pose changes defects unless the criteria say so.
- Separate **structural** checks (scratch, tear, leak, blur) from **logical** checks (wrong component, count, placement, missing part). This is a prompt-level analogue of LogSAD's multi-granularity decomposition, not its feature-level implementation.[5]
- Every defect candidate must name an observable fact and expected normal state. No visible evidence means `REVIEW`, not a confident label.
- `OK` requires all required criteria to be visible. Blur, glare, occlusion, wrong product, or incomparable reference must be `REVIEW`.

### 3. Conditional local verification

Trigger pass 2 when any of these is true:

- scout says `REVIEW` or `needs_verification`;
- confidence lies in a tunable gray band;
- candidate box is under 2% of the inspected view (tune by line);
- defect type is safety/contamination critical;
- target/reference comparability is false;
- image quality is not `usable`;
- result is a first occurrence of a defect type in the run;
- optional audit sample (for example 5% of apparently easy units).

The verifier receives the same reference set, target context, magnified ROI, candidate box, and criteria—but **not the scout's provisional verdict, type, confidence, or rationale**. This reduces confirmation anchoring. Ask it to independently answer:

```json
{
  "candidate_visible": true,
  "comparison_valid": true,
  "evidence_for": ["..."],
  "evidence_against": ["..."],
  "confirmed_bbox": [0.0, 0.0, 1.0, 1.0],
  "decision": "OK|DEFECT|REVIEW",
  "confidence": 0.0
}
```

The current composite already supplies higher effective resolution for the user ROI. A later enhancement may let pass 1 choose a new crop, but that requires a browser round-trip or a precomputed tile pyramid. Do **not** add server-side image decoding in phase 1 merely to implement agentic zoom.

### 4. Deterministic fusion and abstention

Keep final policy outside the VLM:

- `DEFECT`: both passes agree (when verification ran), a valid observable fact exists, the confirmed box overlaps the scout box above a tuned threshold, and the decision passes its calibrated operating threshold.
- `OK`: all criteria are visible, no candidate survives verification, and the OK operating threshold is met.
- `REVIEW`: pass disagreement, poor image quality, invalid/incomparable reference, malformed JSON, inconsistent localization, or score inside the abstention band.

Do not average two self-reported confidence values and call the result calibrated. Initially, confidence is only a routing feature. On a held-out line-specific calibration set, fit a monotonic mapping (or choose discrete thresholds) without changing model weights, then report selective risk versus coverage. Store raw pass outputs and final rule reasons for analysis.

## Minimal code changes

### Server (`server.mjs`)

1. Make `callUpstream` accept `stage`, `model`, and prompt messages; return usage and latency per pass.
2. Add `inspectUnitSelective()` around the existing call:
   - build scout messages;
   - evaluate `shouldVerify(scout, policy)`;
   - optionally call verifier;
   - map through `fuseSelective()` into the existing public result shape.
3. Preserve the browser response contract (`defect`, `type`, `confidence`, `bboxes`) and add only optional diagnostic fields:
   `decision: "OK|DEFECT|REVIEW"`, `verified`, `review_reason`, `passes`, `reference_ids`, `usage`.
4. Count both calls against the current batch deadline and limiter. Expose `max_passes: 2`; never let the model recurse or choose unbounded tools.
5. Remove the unconditional `temperature: 0.1` or capability-gate it. Kimi's native OpenAI-compatible API documents model-specific temperature constraints and recommends omitting the field for K2.5/K2.6 unless the required value is used.[9]

### Shared logic (`public/lib/inspector.mjs`)

- Add internal `normalizeScoutOutput`, `normalizeVerifyOutput`, `shouldVerify`, and `fuseSelective` pure functions with protocol-error-to-`REVIEW` behavior.
- Extend settings with a small optional block:

```json
{
  "pipeline": "single|selective",
  "reference_k": 1,
  "verifier_model": "same|<gateway-model-id>",
  "verify_low": 0.45,
  "verify_high": 0.85,
  "tiny_box_area": 0.02,
  "audit_rate": 0.05
}
```

- Relax few-shot validation to require at least one `OK`; allow optional `DEFECT`. Keep the legacy dual-reference mode for the baseline.
- Add strict stage-specific JSON schemas, but map final output to the existing schema.

### Browser (`public/app.js`, `public/index.html`)

- Add a single pipeline selector: `단일 판정` / `선택적 재검증`.
- Extend OK references to a small bank and show which reference(s) were selected.
- Reuse the existing signature code for ranking; keep raw frames client-side.
- Render `REVIEW` distinctly and show `재검증`, review reason, pass count, and total latency.
- Log experiment fields per unit as downloadable JSONL/CSV; do not rely on aggregated UI counters.

### Existing-branch caveat

The inspected branch currently has the full-context + zoom composite for **reference** focus (`renderReferenceFocusComposite`), but `prepareImage()` still sends a target ROI-only crop. If the demo branch described in the task already added the target composite, no action is needed. Otherwise, first mirror the reference-composite pattern for targets; this is more valuable than adding a third reasoning pass.

## Provider/model capability boundary

Kimi's native vision documentation supports base64 `image_url` parts, multi-image conversations, and JSON mode, and recommends staying within documented resolution limits.[8] That validates the general payload pattern, not every OpenGateway route. OpenAI-compatible request shape does not guarantee identical parameter ranges, structured-output support, image accounting, or deterministic behavior across Kimi, GLM, and fallback routes. Therefore:

- keep prompt-only JSON as the portable baseline;
- enable `response_format` only through a tested per-model capability flag;
- omit provider-specific reasoning/tool fields by default;
- record exact gateway model ID, resolved provider if exposed, API date, prompt version, and image hashes;
- test multi-image order explicitly for every candidate model;
- do not infer native Kimi's 100 MB body allowance through OpenGateway—the local server's 6 MB cap remains authoritative.

## Ablation and evaluation plan

### Evaluation set

Create a frozen, blinded set from representative COSMAX-like data:

- each line/SKU/camera/ROI;
- normal variation (pose, lot print, illumination, gloss, fill level, packaging revision);
- every known defect at severity bands, especially tiny/subtle defects;
- logical anomalies (missing/wrong/misplaced part) and structural anomalies;
- hard negatives (glare, dust outside the product, shadows, permissible print variation);
- quality failures (blur, crop, occlusion, wrong SKU);
- short video runs with event-gate labels.

Split by lot/day/run, not random adjacent frames, to prevent near-duplicate video leakage. Keep one development/calibration split and one untouched test split. Human adjudication should include defect label, severity, target visibility, and region/point annotation where feasible.

### Primary operational metrics

Report per line and pooled with bootstrap confidence intervals:

1. **Defect escape rate / recall** for all defects and critical defects.
2. **False reject rate** on normal units.
3. **Review rate and selective coverage**.
4. **Selective risk–coverage curve** and area under it; an abstaining system must not hide errors by reviewing everything.
5. Balanced accuracy, macro-F1, AUROC/AUPRC when a continuous score is available.
6. Calibration: ECE/Brier score and reliability plot, separately for OK and DEFECT.
7. Localization: point-in-region and IoU/PRO where masks exist; box consistency between passes.
8. p50/p95 latency, calls per unit, input/output tokens, payload bytes, cost per 1,000 units, protocol-error rate, timeout rate.
9. Video: inspected-frame recall, event-gate skip rate, and missed-event rate.

Predefine an operating constraint such as “maximize auto-decision coverage subject to zero observed critical escapes and an upper confidence bound on overall escape rate,” using values approved by the product owner rather than invented in the demo.

### Efficient ablation sequence

Use the same frozen images, model IDs, prompts, and reference bank. Run at least three repeated calls where the provider is nondeterministic.

**A. Reference policy (single pass):**

- A0 zero-shot;
- A1 current fixed `1 OK + 1 DEFECT`;
- A2 random eligible `1 OK`;
- A3 retrieved top-1 `OK`;
- A4 retrieved top-2 `OK`;
- A5 top-1 `OK` + matched DEFECT;
- A6 all eligible references.

This isolates whether retrieval helps, whether the DEFECT exemplar anchors decisions, and where image overload begins.

**B. View composition with best A:**

- B0 context only;
- B1 crop only;
- B2 context + crop;
- B3 context + crop with 0%, 12%, and 25% padding;
- B4 marked versus unmarked context.

Stratify by anomaly area and logical versus structural defect.

**C. Verification policy with best A/B:**

- C0 no verification;
- C1 always verify with same model;
- C2 uncertainty/quality/tiny/critical triggers with same model;
- C3 same triggers with stronger verifier model;
- C4 one-call self-check (cost-control baseline).

Measure incremental errors caught per extra call, latency, and cost. The expected deployable winner is C2 or C3, not always-on verification.

**D. Abstention/fusion:**

- D0 current raw confidence threshold;
- D1 pass agreement only;
- D2 agreement + evidence/localization gates;
- D3 D2 + calibrated thresholds;
- D4 D3 + 5% easy-case audit.

### Promotion gates

Promote only if the selective pipeline:

- improves defect recall or lowers escape rate at the same false-reject rate;
- reduces selective risk at matched coverage;
- does not materially regress any line/defect subgroup;
- keeps p95 latency and cost within the agreed budget;
- maintains malformed-output and timeout fail-closed behavior;
- reproduces on a different lot/day and at least one alternate gateway model.

## Phased delivery

1. **Phase 0 (one day):** logging/evaluation schema; freeze prompts and model IDs.
2. **Phase 1 (smallest useful diff):** scout + conditional blinded verifier using current references/views; deterministic `REVIEW`; no new image stack.
3. **Phase 2:** OK reference bank and dependency-free top-1/top-2 retrieval; make DEFECT optional.
4. **Phase 3 only if ablations justify it:** client-precomputed tile pyramid or server image tooling for model-selected zoom; calibrated thresholds and production dashboards.

The key design rule is to spend extra model calls only where they buy evidence. Training-free literature supports comparison, multi-granularity inspection, and calibration as mechanisms; COSMAX should implement those mechanisms with its existing browser image preparation and frontier-model API, while failing closed on uncertainty.

## Sources

[1] https://arxiv.org/abs/2410.09453 — MMAD: A Comprehensive Benchmark for Multimodal Large Language Models in Industrial Anomaly Detection
[2] https://arxiv.org/abs/2412.03342 — UniVAD: A Training-free Unified Model for Few-shot Visual Anomaly Detection
[3] https://arxiv.org/abs/2405.14529 — AnomalyDINO: Boosting Patch-based Few-shot Anomaly Detection with DINOv2
[4] https://arxiv.org/abs/2502.07601 — Towards Zero-Shot Anomaly Detection and Reasoning with Multimodal Large Language Models
[5] https://arxiv.org/abs/2503.18325 — Towards Training-free Anomaly Detection with Vision and Language Foundation Models
[6] https://arxiv.org/abs/2501.15795 — Can Multimodal Large Language Models be Guided to Improve Industrial Anomaly Detection?
[7] https://arxiv.org/abs/2512.13671 — AgentIAD: Agentic Industrial Anomaly Detection via Adaptive Memory Augmentation
[8] https://platform.kimi.ai/docs/guide/use-kimi-vision-model — Configure Kimi Vision Models
[9] https://platform.kimi.ai/docs/guide/migrating-from-openai-to-kimi — Compatibility with OpenAI API
