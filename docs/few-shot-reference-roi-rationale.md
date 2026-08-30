# Decision record: Few-shot reference focus ROI

- **Status:** accepted for the customer demo
- **Date:** 2026-08-30
- **Scope:** `OK` and `DEFECT` visual references only

## Decision

Each few-shot reference may carry an independent optional normalized focus region:

```json
{
  "label": "OK | DEFECT",
  "focus_roi": [0.1, 0.2, 0.5, 0.4]
}
```

When a focus region is present, the browser sends one visual prompt containing:

1. the complete reference image with a thin outline around the selected region;
2. a magnified crop with 12% padding around the selected region; and
3. the normalized `focus_roi` metadata and prompt text explaining how to use it.

The ROI is **soft visual guidance**, not a coordinate-based hard rule. It tells the VLM where comparison evidence is likely to be useful; the ROI coordinates themselves never determine `OK` or `DEFECT`.

## Why we chose it

Cosmetic packaging defects such as blurred printing, a tilted cap, label wrinkles, and seal damage can occupy a small fraction of the camera frame. Background fixtures, conveyor surfaces, illumination, and framing differences may occupy most of the pixels. An enlarged local view gives the VLM more effective visual detail and a clear comparison cue.

A crop-only design was rejected because it removes product identity, position, orientation, and alignment context. A coordinates-only design was rejected because generic API-hosted VLMs do not offer a portable guarantee of pixel-accurate coordinate grounding. The combined full-context + padded-crop representation works with ordinary multi-image vision APIs and does not depend on model internals.

Independent `OK` and `DEFECT` ROIs were selected because the useful comparison area can differ across examples and because reference images may use different framing or resolution. The ROI is optional so the unmarked few-shot baseline remains available.

This decision is consistent with recent evidence that normal-reference comparison can help capable frontier MLLMs, while reference quality and count matter more than simply adding more images. MMAD also reports that precise region evidence can help localization, whereas noisy anomaly maps may reduce classification quality. The feature therefore supplies explicit human-selected evidence but does not claim that ROI always improves accuracy.

## Prompt contract

For references with a focus ROI, the prompt must communicate all of the following:

- treat the ROI as visual guidance, not as a hard detector rule;
- prioritize corresponding evidence in the marked and magnified region;
- ignore unrelated background differences;
- use the full image for identity, position, orientation, and alignment;
- base the final verdict on visual evidence, labels, and configured criteria—not on the box itself.

## Safety and compatibility constraints

- Coordinates are normalized `[x, y, width, height]` values in the 0–1 range.
- Width and height must be positive, and the rectangle must fit inside the image.
- A `1e-9` tolerance permits harmless floating-point overflow at the right/bottom edge.
- Crop padding is 12% per ROI dimension and is clamped at image boundaries.
- The outline is drawn outside the evidence region where possible and does not add a translucent fill over defect pixels.
- Uploaded reference images are browser-normalized to a maximum 1536-pixel side before use.
- Reference uploads are limited to JPEG/PNG, 12 MB encoded size, 8192px per dimension, and 16 million decoded pixels; headers are checked before pixel decode and modern browsers receive decode-time resize dimensions.
- Per-slot generation gates prevent a late upload/decode from overwriting a newer generated, captured, or uploaded reference.
- The ROI editor is bound to the exact source image it opened and cannot save onto a replacement reference.
- Starting inspection invalidates pending reference work and freezes one immutable settings/reference snapshot for every batch in that run.
- References without a focus ROI preserve the existing few-shot path.

## Validation strategy

### Automated contract tests

- accepts valid independent reference ROIs;
- rejects malformed, out-of-range, and zero-area ROIs;
- tolerates floating-point contact with image edges;
- preserves full context and produces a 12%-padded crop;
- includes the focus metadata and full-context/crop explanation in the prompt;
- states explicitly that focus is soft guidance and unrelated background changes should be ignored.

### Browser verification

- create independent `OK` and `DEFECT` references;
- open the ROI editor and draw a region;
- apply/reset the region and verify the card badge;
- inspect a DEMO batch and verify normalized `focus_roi` in the request;
- verify an uploaded image and an uploaded-video current frame separately;
- fail with a bounded, visible error instead of hanging when browser video metadata never arrives;
- verify ROI canvas proportions at desktop and narrow viewport widths.

### Accuracy validation with customer data

The synthetic demo proves the UI and request contract, not inspection accuracy. Representative COSMAX data should compare:

1. full reference only;
2. crop only;
3. full reference + padded crop;
4. marked versus unmarked full context.

Report defect recall, normal false-reject rate, `REVIEW` rate, latency, and results by defect type and apparent defect area. Keep ROI opt-in unless the customer-data ablation shows a consistent improvement.

## Alternatives considered

| Alternative | Decision | Reason |
|---|---|---|
| ROI crop only | Rejected | loses package-level location and alignment context |
| Coordinates in text only | Rejected | coordinate grounding varies by provider/model |
| Translucent mask over the ROI | Rejected | can cover subtle defect pixels |
| One shared ROI for target and all references | Rejected | source images may have different pose, crop, and resolution |
| ROI as a deterministic defect rule | Rejected | current system is VLM visual in-context prompting, not a pixel/geometry detector |
| Full image + padded crop | Accepted | balances local detail, global context, and provider portability |

## Primary references

- Schiele et al., *Low-shot Visual Anomaly Detection with Multimodal Large Language Models* (2024): https://doi.org/10.1016/j.procs.2024.09.439
- Jiang et al., *MMAD: A Comprehensive Benchmark for Multimodal Large Language Models in Industrial Anomaly Detection* (ICLR 2025): https://openreview.net/forum?id=JDiER86r8v
- Deng et al., *GLLS: Global Logic and Local Search* (2026 preprint): https://arxiv.org/abs/2607.03817
