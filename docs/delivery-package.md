# Delivery Package

A Delivery Package is an immutable, manifest-backed set of final deliverables plus separately partitioned references, sources, and internal evidence.

The package workflow is:

1. Declare required and optional artifacts with stable IDs, roles, versions, and target sections.
2. Refuse missing required files, temporary files, unsafe paths, symlinks, or attempts to overwrite an existing package.
3. Copy files into `final`, `reference`, `source`, or `internal`; preserve the originals and record byte counts and SHA-256 hashes.
4. Inspect PPTX, DOCX, and PDF metadata without rewriting source artifacts.
5. Validate declared page counts, links, references, and cross-file relationships.
6. Generate `DELIVERY.md` for a non-technical recipient.
7. Record named human acceptance and external-sharing review separately from automated checks.

Automated success does not establish instructional-design approval, visual acceptance, or permission to share externally.
