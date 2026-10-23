---
name: gpt-image-2-5-prompt-library
kind: basic
description: GPT Image 2.5 提示词库技能（基础技能）：LemGen 八段式提示词框架、生成/编辑/多图/一致性/文字排版等提示词工程规则，用于撰写可直接生图的人物、环境、镜头设计提示词。
source: https://github.com/gpt-img-2/awesome-gpt-image-2-5
license: MIT
---

# GPT Image 2.5 Prompt Library

> 来源：https://github.com/gpt-img-2/awesome-gpt-image-2-5 （MIT）。本文件 = SKILL.md + docs/ 全部指南，供无检索工具的模型直接使用。

# GPT Image 2.5 Prompt Library

Use the repository as two distinct sources:

- `data/templates.json`: 27 LemGen-original production templates designed for
  adaptation.
- `data/community-prompts.json`: 1,935 credited community references useful for
  discovery. Preserve the author and source when presenting one.

## Find useful candidates

Run the deterministic search helper from this skill directory:

```bash
node scripts/search.mjs --query "product poster exact text" --limit 8
node scripts/search.mjs --kind original --category editing --limit 5
node scripts/search.mjs --creator "BubbleBrain" --sort views --limit 10
```

Search returns full prompts, IDs, attribution, source links, and provenance.
Select for structural relevance, not merely popularity. Do not merge several
long community prompts by default; choose one useful structure and remove details
that do not belong to the user's brief.

## Route the model

- Use `gpt-image-2.5-sunburst` when editing precision matters most, or when the
  brief depends on protected identity, product details, exact text, or layout.
- Use `gpt-image-2.5-flare` for fast high-quality everyday generation, broad
  exploration, and many early drafts.
- Describe those as official high-level model positions plus practical workflow
  guidance. Do not invent aliases, availability, pricing, or guarantees.

## Turn the reference into a production brief

1. Name the asset, audience, primary subject, and real job it must do.
2. Keep only relevant composition, camera, light, material, palette, visible
   text, and failure constraints from the selected entry.
3. Replace variables with user-provided facts. Keep unresolved business claims,
   legal copy, prices, measurements, and identity details as explicit variables.
4. For edits, separate `Change` from `Preserve exactly`. For multiple images,
   assign each reference one role and state which wins if they conflict.
5. Return a copy-ready prompt and 2–4 observable review checks.

Read the relevant guide only when needed:

- Editing: `../../../docs/editing-guide.md`
- Visible text: `../../../docs/text-layout-guide.md`
- Identity consistency: `../../../docs/consistency-guide.md`
- Failed result: `../../../docs/troubleshooting.md`
- Comparison claims: `../../../docs/benchmark-protocol.md`

## Evidence and rights boundary

`verification: template` means reusable instruction, not a tested result.
`verification: community-reference` means historical discovery material, not a
GPT Image 2.5 benchmark. Keep its author and source attached. A benchmark requires
the model ID, inputs, settings, original output, and generation receipt.

## Response shape

```text
Recommended model: Sunburst | Flare
Why: one workflow-specific sentence

Selected reference:
- title, author, source, provenance label

Copy-ready prompt:
<adapted prompt>

Still needed:
- unresolved variables only

Review:
- 2–4 observable checks
```

## 附：提示词框架（八段式）

# The LemGen prompt framework

A useful image prompt is an editable creative brief, not a dense cloud of style
adjectives.

## The eight-part structure

1. **Goal** — name the asset and what it must accomplish.
2. **Subject** — identify the central object, person, place, or information.
3. **Composition** — set hierarchy, crop, viewpoint, spacing, and aspect ratio.
4. **Environment** — describe the stage around the subject.
5. **Light** — use observable direction, softness, contrast, and time of day.
6. **Materials and color** — specify surface behavior and each color's job.
7. **Exact text** — quote only approved visible copy and state its hierarchy.
8. **Constraints** — protect invariants and name likely visible failures.

```text
[goal] + [subject] + [composition] + [environment] + [light]
+ [materials and color] + [exact visible text]
+ [protected details and failure constraints]
```

## Generation pattern

```text
Create [ASSET TYPE] for [GOAL]. Main subject: [SUBJECT]. Environment:
[SETTING]. Composition: [CROP, ANGLE, SPACING, ASPECT RATIO]. Lighting:
[DIRECTION, QUALITY, CONTRAST]. Materials and palette: [DETAILS]. Show the
exact text "[COPY]" at [LOCATION]. Preserve [FIXED ELEMENTS]. Avoid
[SPECIFIC FAILURES].
```

## Editing pattern

Editing prompts need two equally explicit lists:

```text
Change only: [REQUESTED CHANGE].
Keep unchanged: [IDENTITY, GEOMETRY, TEXT, COMPOSITION, CAMERA, LIGHT, COLOR].
Match naturally: [PERSPECTIVE, CONTACT SHADOW, REFLECTION, MATERIAL BEHAVIOR].
Do not: [CONCRETE FAILURE MODES].
```

“Keep everything else the same” is weaker than naming the protected details.

## Multi-image pattern

Give every input one job:

```text
Image 1: exact product source.
Image 2: environment and lighting reference only.
Image 3: palette reference only.
```

Do not ask several reference images to control the same visual property unless
you also define a priority order.

## Review order

Review results in this order:

1. factual and text accuracy;
2. protected details and identity;
3. composition and spatial relationships;
4. light and material behavior;
5. style and polish.

Revise one visible variable at a time. That turns the next output into useful
evidence instead of another uncontrolled variation.

## 附：编辑操作规范

# Edit without collateral damage

Image editing fails when the requested change is clear but everything that must
stay unchanged is left implicit. Write an edit prompt in two blocks.

## 1. State the change

Name one observable transformation: replace the background, change one garment,
remove one object, repair damage, or localize visible text. Include where the
change happens and what the finished state should look like.

## 2. Lock the invariants

List what must remain unchanged: identity, facial proportions, pose, camera,
crop, product geometry, label spelling, lighting direction, shadows, reflections,
and unaffected pixels. Only include invariants that matter to the source image.

```text
Change: Replace only the wall behind the chair with warm gray limewash.

Preserve exactly: chair shape and upholstery, floor, camera position, crop,
window light direction, contact shadow, all foreground objects, and image size.

Do not: redesign the room, move objects, add decor, alter color elsewhere,
smooth textures, or add text.
```

Review the result by comparing protected details before judging aesthetics.
When several independent changes are needed, make them in separate passes.

## 附：角色与产品一致性

# Preserve character and product consistency

Consistency comes from naming the stable identity, assigning each reference one
job, and changing fewer variables per pass.

## Build an identity lock

Record observable features: face shape, eye spacing, nose, hairstyle, age range,
body proportions, signature garment construction, product silhouette, seams,
label position, materials, and color values. Avoid vague instructions such as
"keep the same vibe."

## Give references one role each

- Reference A: identity or product geometry.
- Reference B: pose or composition.
- Reference C: lighting or material direction.

Say which reference wins if they conflict. Never silently blend identity from
multiple people.

## Change one axis at a time

First lock identity and framing. Then change environment. Then adjust wardrobe
or lighting. Save accepted outputs as the next reference. A large simultaneous
change makes drift harder to diagnose.

Check silhouettes and proportions before small texture differences.

## 附：画面文字排版

# Control text and layout

Treat visible copy as data, not decoration.

1. Put every required string in quotation marks.
2. State the reading order and hierarchy: headline, supporting line, metadata.
3. Assign each string a region, alignment, and relative size.
4. Limit the number of type styles and colors.
5. Explicitly ban extra words, invented logos, fake sponsors, QR codes, and fine
   print unless required.
6. Check spelling character by character at full size after generation.

```text
Create a 4:5 event poster.

Exact visible copy:
- Headline: "THE SHAPE OF QUIET"
- Date: "18 OCT 2026"
- Venue: "NORTH HALL"

Place the headline in the upper third, left aligned, at least four times the
height of the date. Put date and venue on one baseline in the bottom margin.
Use one high-contrast serif and one neutral sans serif. Add no other text.
```

For localization, provide the final approved translated string yourself. Do not
ask the image model to translate legal, medical, pricing, or product claims.

## 附：失败排查

# Troubleshooting GPT Image prompts

| Failure | Likely cause | First correction |
| --- | --- | --- |
| The image feels generic | The prompt names mood but not observable decisions | Add viewpoint, hierarchy, material, light direction, and use context |
| Important objects disappear | Too many equal-priority subjects | Name one primary subject and place secondary objects explicitly |
| Hands or anatomy fail | Pose and interaction are underspecified | Describe which hand does what, visibility, grip, and occlusion |
| Text is wrong | Copy, hierarchy, or exclusions are ambiguous | Quote exact strings and forbid any additional text |
| Editing changes the whole image | Invariants were omitted | Separate the requested change from an explicit preserve list |
| Character identity drifts | References have conflicting roles | Assign one identity source and change one other axis per pass |
| Product looks redesigned | Geometry and label constraints are vague | Lock silhouette, dimensions, seams, label placement, and spelling |
| Everything looks over-styled | Adjective pile overwhelms the brief | Remove style synonyms; keep one visual system and concrete materials |

## A fast repair loop

1. Identify the single most expensive observable failure.
2. Remove conflicting or redundant instructions.
3. Add one measurable correction and the relevant invariant.
4. Regenerate without changing unrelated variables.
5. Record the prompt and settings if the result will be used as evidence.

Do not call a successful-looking image a benchmark unless it also satisfies the
[benchmark protocol](benchmark-protocol.md).

## 附：模型选择指南

# GPT Image 2.5 model guide

Last verified against official OpenAI documentation: 2026-09-09.

## Official model split

### GPT-Image-2.5 Sunburst

- Model ID: `gpt-image-2.5-sunburst`
- Dated snapshot: `gpt-image-2.5-sunburst-2026-09-08`
- Official positioning: OpenAI's most capable model for image generation and
  editing, especially when editing precision matters.
- Officially listed interfaces include the Image API and the Responses API
  image-generation tool.
- Source: [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)

### GPT-Image-2.5 Flare

- Model ID: `gpt-image-2.5-flare`
- Dated snapshot: `gpt-image-2.5-flare-2026-09-08`
- Official positioning: OpenAI's fastest model for high-quality everyday image
  generation.
- Officially listed interfaces include the Image API and the Responses API
  image-generation tool.
- Source: [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)

Both official pages currently list `low`, `medium`, `high`, `xhigh`, `max`, and
`auto` quality settings.

## LemGen routing guidance

The table below is editorial guidance for choosing a starting point. It is not
an official benchmark or guarantee.

| Workload                                | Starting model | Why                                                                      |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| Broad ideation and many early drafts    | Flare          | The official positioning emphasizes speed and everyday generation.       |
| Targeted image edit                     | Sunburst       | The official positioning explicitly emphasizes editing precision.        |
| Identity or product preservation        | Sunburst       | These workflows benefit from the more capable editing model.             |
| Typography-heavy first draft            | Sunburst       | Treat exact text and hierarchy as precision constraints.                 |
| Simple lifestyle or product exploration | Flare          | Iterate quickly, then move approved directions to Sunburst if needed.    |
| Final production revision               | Sunburst       | Protected details and narrow changes matter more than exploration speed. |

Provider availability, account access, latency, token consumption, and output
behavior can change. Verify them in the active product or provider before
publishing operational claims.
