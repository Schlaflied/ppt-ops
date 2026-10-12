# User-selected delivery formats

New projects omit `Project.outputs`. Outline and Design can proceed before any export choice. Older project files with `outputs` remain readable, but that field never authorizes a new delivery. No format is silently selected.

At Handoff, offer the available self-contained HTML, editable PowerPoint and PDF choices. At Outline acceptance, independently offer Markdown, Word and PDF; the user can also continue without exporting the outline. Use plain language and keep commands out of the conversation.

## Presentation delivery

Create explicit immutable Build targets from a Frozen Version and review the exact Build. `delivery-capabilities` reports which artifacts are available. HTML and PPTX are independent renderers; neither is a conversion source for the other. A format absent from the Build requires another explicitly requested Build from the same Frozen Version and its own Review.

Use `delivery-select --artifact presentation --formats pptx --source <build> --source-revision <version> --build <build> --actor user`, then pass its stored ID to `handoff-create --selection <id>`. Handoff requires the accepted Review, matching source hashes and an explicit stored user decision. It packages only selected files plus the Review report and manifest. Caller-supplied selection JSON cannot replace the stored evidence.

PDF becomes available only when a reviewed source and exporter exist. A reviewed HTML source uses Chromium printing with one page per slide and notes/navigation hidden; otherwise a reviewed PPTX can use the native presentation converter. The derivative records the source file hash, Build/Version, Review, exporter and output hash. PDF-only delivery does not add the unselected source file to the package. Failed exporters report `EXPORTER_UNAVAILABLE`, preserve accepted work and allow reselection; they never silently switch formats. Existing immutable derivatives are reused only after their hashes are verified.

## Outline delivery

`outline-source` returns the outline identity and hash of its title, sections and referenced page content. After explicit acceptance, `outline-approve --source-revision <hash> --actor user --raw-feedback <text>` preserves the exact accepted snapshot. A later change requires a new acceptance.

`delivery-select --artifact outline --formats markdown,docx --source <outline> --source-revision <hash> --approval <id> --actor user` exports only the selected formats. Markdown and editable DOCX are produced directly from the accepted snapshot. PDF uses an internal print document derived from that snapshot, with its hash and approval preserved in `pdf-source.json`. Chromium availability is reported before selection; its failure cannot discard accepted content. Outline exports do not create a presentation Build or pretend to satisfy presentation Review.

## Durable evidence and reselection

Each choice is a new immutable `.pptops/delivery-selections/<id>/manifest.json` containing artifact type, formats, source identity/revision, user actor, decision time and choice source. Outline choices also reference an immutable `.pptops/outline-approvals/<id>/manifest.json`. These files survive database reindexing. Reselection does not modify previous choices, accepted content, PageSpecs, frozen Versions or Builds. Export manifests include output hashes and errors retain the selection ID.

The older `handoff` and `deliver` convenience commands now require `--formats html,pptx --actor user`. They record an explicit choice and a hash of the current output snapshot, and package only selected outputs. Their separate visual/PowerPoint acceptance remains pending unless independently performed; use formal Build/Review/Handoff commands for an accepted delivery. Existing packages remain untouched. The former implicit `Project.outputs` default is removed.

## Online lecture mode

Choose `Project.delivery_mode = "online_lecture"` when the deck is presented through screen sharing (Tencent Meeting, Zoom, Feishu/Lark, live streaming) or watched as a recorded replay. Use `live_talk` for a projector in the room. Online sharing degrades the slide differently from a projector: compression blurs thin lines and pale small text, meeting apps cover fixed parts of the frame, and replay viewers often watch at 720p or on a phone.

Compared with `live_talk`, the mode tightens the automated guidance:

| Guidance | `live_talk` | `online_lecture` |
| --- | --- | --- |
| Visible characters per content page | 420 | 300 |
| Shapes per slide | 48 | 40 |
| Minimum body text (px at 1920×1080) | 24 (design baseline) | 32 (≈21 px at 720p) |
| Minimum secondary text (numbers, citations, captions) | — | 20 (≈13 px at 720p) |
| Minimum line/stroke width | — | 3 px (2 px at 720p) |
| Text contrast | WCAG thresholds | 4.5:1 for all text; no large-text exemption |

Legibility checks scale generated PPTX font sizes (1 pt = 2 px at 1080p), connector widths and, in HTML QA, computed CSS font sizes and SVG stroke widths from 1080p to 720p before comparing. These checks are arithmetic on declared geometry, not pixel or OCR analysis, and never claim that a viewer can read the slide.

### Safe zones

`Project.safe_zones` is an optional list. Each item is either a preset or a named rectangle. Rectangles use coordinates normalized to the 16:9 slide: `0,0` is the top-left and `1,1` is the bottom-right, so the same zones apply to PPTX, HTML and downscaled screenshots.

```json
{
  "delivery_mode": "online_lecture",
  "safe_zones": [
    { "preset": "tencent_meeting" },
    { "name": "chat-panel", "x": 0.82, "y": 0, "width": 0.18, "height": 1, "description": "Chat sidebar on the host screen" }
  ],
  "interaction_interval_minutes": 8
}
```

Built-in presets are approximate planning defaults, not measurements of any client version. Layouts change with platform, client version, window size and participant settings, so add your own rectangles when you know the real layout.

| Preset | Zones (`x, y, width, height`) |
| --- | --- |
| `tencent_meeting` (腾讯会议) | `tencent_meeting.share_toolbar` top-centre sharing toolbar `0.20, 0, 0.60, 0.08`; `tencent_meeting.self_view` camera tile, bottom-right `0.78, 0.72, 0.22, 0.28` |
| `zoom` | `zoom.share_banner` top-centre "You are screen sharing" banner `0.25, 0, 0.50, 0.07`; `zoom.video_panel` floating video panel, top-right `0.80, 0.07, 0.20, 0.25` |
| `feishu` (飞书会议 / Lark) | `feishu.share_toolbar` top-centre sharing toolbar `0.25, 0, 0.50, 0.07`; `feishu.camera_tile` camera tile, bottom-right `0.80, 0.74, 0.20, 0.26` |
| `replay_captions` | `replay_captions.caption_band` bottom caption band on replays `0, 0.88, 1, 0.12` |

Review reports `online-safe-zone-occlusion` when a key element (non-decorative text, image, chart, table or annotated HTML content/node) overlaps a zone by more than 2% of its area. Each finding carries `page`, `element` (PPTX object name or HTML `data-qa-id`), `zone` and the overlap ratio. Slide numbers, footer rules and decorative objects are ignored. Without declared zones, the delivery-mode fit records an `online-lecture-safe-zones-undeclared` note. HTML QA can also apply presets directly: `pptops html-qa <html-file> --safe-zones tencent_meeting,zoom`.

### Interaction cadence

Online audiences need more frequent checkpoints. Delivery-mode fit adds up `estimated_duration_seconds` page by page and reports `online-lecture-interaction-cadence` when more than `interaction_interval_minutes` (default 8) pass without a page declaring `audience_interaction`. The finding names the first and last page of the gap. Pages without an estimate count as zero seconds and are listed in an `online-lecture-duration-unestimated` note. Estimates are planning data, not rehearsed timing.

### 720p evidence

For `online_lecture`, PPTX review adds 720p page images (`page-720p-<n>.png`) to the rendered evidence when ImageMagick is available, otherwise the 720p view is reported as unavailable. Screenshot evidence also records each focal region's estimated pixel size in the 720p view. Human visual acceptance of the shared and replayed deck remains separate.
