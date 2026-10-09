---
name: changeset
description: Add release notes for client changes in packages/core. Use when implementing or reviewing changes to @xrio/core behavior, public API, types, runtime dependencies, or package output.
---

# Client changesets

- Before finishing a release-worthy client change, include a changeset in the same PR. Update an existing note for that change instead of duplicating it.
- Skip landing-page, CI, docs-only, test-only, and internal refactors with no consumer impact.
- Run `vp run changeset` and select `@xrio/core`, or create `.changeset/<short-unique-name>.md` directly:

```md
---
"@xrio/core": patch
---

Describe the user-visible change in one sentence.
```

- Choose `patch` for fixes, `minor` for backward-compatible features, and `major` for breaking changes. Explain required migration for breaking changes.
- Do not manually bump package versions, edit generated changelogs, or run `release:version` in a normal PR. The version workflow handles that through the release PR. No npm publishing.
