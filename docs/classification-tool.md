# On-Device Text Classification Tool (`classify_text`)

## Overview

The `classify_text` tool is an **on-device, zero-shot text classification tool** available to all Dev Session agent roles (Requirements, Plan, Coding, QA). It uses a small NLI (Natural Language Inference) / MNLI model running via [`transformers.js`](https://xenova.github.io/transformers.js/) to classify text against a caller-supplied set of candidate labels.

**Key properties:**

- ✅ Runs entirely on-device (no network call, no cloud API cost)
- ✅ Fast after the first download (model is cached on disk and reused)
- ✅ Available to any Dev Session agent without a separate model or service
- ✅ Deterministic: same text + labels always produce the same result
- ✅ Closed-set only: ranks caller-supplied labels, cannot invent labels or generate text

**Best used for:**

- Triaging a QA finding or bug report by severity/category
- Tagging a requirement or doc section by area or type
- Deciding whether a piece of text is relevant to a given query
- Sorting a list of items into known categories
- Any judgment that is "which of these 2–10 buckets does this belong to?"

**Not for:**

- Free-text generation, summarization, or open-ended decisions
- Open-ended classification (when you don't have a fixed set of labels)
- Anything where your own reasoning is more important than offloading a rote bucketing task

## How to Use It

Call the tool with:

- **`text`** (string, required): The text to classify (a sentence, paragraph, log line, commit message, etc.).
- **`labels`** (string array, required): A list of candidate labels to rank the text against. Must have at least 2 distinct, non-empty labels.
- **`mode`** (string, optional, default: `"single"`):
  - `"single"`: Return the one best-fitting label and its score.
  - `"multi"`: Return every label that fits (scores ≥ threshold), highest-scoring first.
- **`threshold`** (number, optional, range 0–1):
  - Multi-label mode only; ignored in single mode.
  - The minimum confidence score a label must reach to be included in the result.
  - Default: `0.5` — labels with ≥ 50% confidence are considered a match.
  - Pass a different value to tighten (e.g., 0.7) or loosen (e.g., 0.3) the threshold.

## Output

The tool returns:

- **`model`**: The name of the model that ran, so you can tell which one your agent got.
- **`mode`**: The mode used (`"single"` or `"multi"`).
- **`threshold`**: The confidence threshold applied (number in multi mode, `null` in single mode).
- **`selected`**: The label(s) that fit:
  - Single mode: array of exactly one label with its score.
  - Multi mode: array of every label scoring at or above the threshold (highest first), or empty if none clear it.
- **`allScores`**: Every candidate label, sorted by descending score, so you can see near-misses and distinguish high-confidence from coin-flip classifications.

## Example

```
Tool input:
{
  "text": "The app crashed when I tried to upload a large file. Stack trace: ...",
  "labels": ["bug report", "feature request", "question", "documentation issue"],
  "mode": "single"
}

Tool output:
{
  "model": "Xenova/distilbert-base-uncased-mnli",
  "mode": "single",
  "threshold": null,
  "selected": [
    { "label": "bug report", "score": 0.98 }
  ],
  "allScores": [
    { "label": "bug report", "score": 0.98 },
    { "label": "feature request", "score": 0.01 },
    { "label": "question", "score": 0.005 },
    { "label": "documentation issue", "score": 0.005 }
  ]
}
```

## Model Selection

Three curated ONNX models are available, all trained on NLI/MNLI datasets and compatible with the zero-shot-classification pipeline. You can switch between them in **Settings → Dev Agents → Classification Model**.

| Model                         | Size    | Speed     | Accuracy | Best for                                                                                     |
| ----------------------------- | ------- | --------- | -------- | -------------------------------------------------------------------------------------------- |
| **DistilBERT MNLI** (default) | ~70 MB  | Very fast | Good     | Clear-cut label sets, resource-constrained environments. **Recommended for most use cases.** |
| **DeBERTa v3 XSmall NLI**     | ~90 MB  | Fast      | Better   | Nuanced, overlapping, or adversarial labels. Noticeably better than DistilBERT.              |
| **BART Large MNLI**           | ~400 MB | Slower    | Best     | Subtle semantic distinctions, corner cases, low confidence. Slowest to download and to run.  |

All three are small enough to cache on disk; pick the smallest that handles your label set clearly, and upgrade if you see false positives or confidence coin-flips.

## Cache and Offline Operation

Downloaded models are cached under **`harness-server/state/classification-models/`** (not in `transformers.js`'s default OS cache location), keyed by model ID so multiple models can coexist:

```
harness-server/state/classification-models/
├── Xenova/distilbert-base-uncased-mnli/
│   ├── (ONNX weights and metadata)
├── Xenova/nli-deberta-v3-xsmall/
│   ├── (ONNX weights and metadata)
└── Xenova/bart-large-mnli/
    └── (ONNX weights and metadata)
```

**First use of a model:** Downloads from Hugging Face Hub (requires network access).  
**Every subsequent use:** Offline, reads from cache.

The in-memory pipeline singleton is cached across every agent role and session, so a model downloaded once by the Coding agent can be reused by the Requirements agent or a later session at no additional cost.

## Settings: Classification Tool

Open **Settings → Dev Agents** to manage the classification tool:

- **Model**: A dropdown to select which of the three models to use. Takes effect on the next `classify_text` call (no agent-server restart needed).
- **Cache Status**: For each of the three models, shows whether it has been downloaded (`✓ Downloaded`, ~70/90/400 MB) or not (`Not downloaded`).
- **Clear Cache**: A button to delete every cached classification model at once. After clearing, the next `classify_text` call re-downloads whichever model is selected at that point.

## Multi-Label Threshold

In **`multi` mode**, the tool returns every label that scores at or above the threshold:

- **Default**: `0.5` (50% confidence). A label must be at least "half sure" to be considered a match.
- **Override per call**: Pass a `threshold` parameter to use a different cutoff for that classification.
  - Use `0.1–0.3` if you want generous, inclusive results (catch more matches, accept some false positives).
  - Use `0.7–0.9` if you want strict, high-confidence results only (reject noise, but risk missing valid edges).

In **`single` mode**, `threshold` is ignored — the tool always returns the highest-scoring label regardless of score.

## Error Handling

If classification fails (bad input, model download fails, inference error, etc.), the tool returns a clear error message at the tool level — it does not crash the agent's turn or the session. You'll see the error and can:

- Retry with different labels or text
- Pick a different model in Settings
- Clear the cache if the model seems corrupted
- Fall back to your own reasoning if the tool can't help

## Technical Details

### Model Runtime

The classification tool uses [`@xenova/transformers`](https://huggingface.co/docs/transformers.js/index), a JavaScript implementation of the Hugging Face Transformers library. It runs ONNX (Open Neural Network Exchange) models, a standard cross-platform format for inference.

**Why not Riff's existing Qwen model?** Riff runs a local Qwen model via `llama-helper` (llama.cpp, GGUF format) for the Dev Sessions coordinator's continue/ready decisions. Qwen is a causal (text-generation) model, incompatible with the zero-shot-classification pipeline, which requires a sequence-classification model trained on entailment/contradiction/neutral tasks (NLI/MNLI). The two stacks cannot be mixed; this tool uses a dedicated small NLI model instead.

### Zero-Shot Classification

"Zero-shot" means the model can classify text against any labels you supply, without needing to be fine-tuned on those specific labels first. It works by treating classification as a Natural Language Inference (NLI) task: for each label, it asks "does the premise (text) entail the hypothesis (label)?" and scores the answer.

For example, "The app crashed when I tried to upload a large file" entails "bug report" (high score) but not "feature request" (low score), without the model ever being specifically trained on crash reports.

### Configuration

Model and cache configuration is defined in:

- **Backend settings schema**: `harness-server/backend/src/settings/settings.ts` (`CLASSIFICATION_MODELS`, `DEFAULT_CLASSIFICATION_MODEL`, `ClassificationSettings`)
- **Pipeline module**: `harness-server/backend/src/agents/classification.ts` (cache location `CLASSIFICATION_CACHE_DIR`, default threshold `DEFAULT_MULTI_LABEL_THRESHOLD`)
- **Tool definition**: `harness-server/backend/src/agents/tool-defs/classify-text-tool.ts` (input schema, description, execution)

Changes to model options, cache location, or the default threshold require updates to the settings schema and/or the classification module — the tool definition and API routes do not need changes.

## See Also

- [`classifyTextTool` definition](../harness-server/backend/src/agents/tool-defs/classify-text-tool.ts)
- [Classification module](../harness-server/backend/src/agents/classification.ts)
- [Settings configuration](../harness-server/backend/src/settings/settings.ts)
- [Settings API routes](../harness-server/backend/src/routes/settings.ts)
- [`CLAUDE.md` → Dev Sessions](../CLAUDE.md#dev-sessions-meeting--requirements--plan--code--qa)
