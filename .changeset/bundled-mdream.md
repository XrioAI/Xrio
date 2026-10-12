---
"@xrio/core": patch
---

Markdown conversion of a page with many code blocks now takes linear time, because the package bundles a patched `@mdream/js` 1.7.2 instead of installing it as a dependency.
