# ADR 0009: Generated visuals on first and final pages are optional

- Status: Accepted
- Date: 2026-10-12
- Supersedes: [ADR 0002: Mandatory generated visuals at deck boundaries](0002-mandatory-boundary-images.md) (issue #58)

## Context

ADR 0002 required the canonical first and final page of every formally produced deck to select an accepted ImageGen visual as the dominant layer, with exactly one visible title. Version freeze, formal HTML/PPTX build, Review, Handoff, and delivery failed with `BOUNDARY_IMAGE_REQUIRED` until both pages complied, and both renderers forced an image-dominant, title-only layout on those pages.

## Decision

The project owner removed the mandatory boundary-image rule because it constrained the model's design freedom.

- No page position requires an ImageGen visual, an image-dominant composition, or title-only copy.
- Cover and closing pages render like any other page and may carry whatever text the content needs, including visible citations.
- The Visual Asset Pipeline is unchanged: accepted generated images remain available, optionally, on any page, including covers. Review still verifies the evidence chain of every selected generated asset.

## Consequences

- `src/visual-assets/boundary-policy.js` and the `BOUNDARY_IMAGE_REQUIRED` and `CITATION_BOUNDARY_CONFLICT` errors are removed; freeze, build, Review, Handoff, and delivery no longer inspect page position.
- Handoff manifests no longer write `boundary_images`. Earlier manifests and projects that recorded boundary assets remain valid; those assets are ordinary selected assets.
- Density checks count all visible copy on every page, including the first and final page.
- HTML/PPTX content-consistency compares the content both renderers carry (title, primary copy, sensitive tokens) instead of relying on boundary pages to hide renderer chrome differences.
