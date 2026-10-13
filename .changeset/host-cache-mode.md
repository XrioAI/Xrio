---
"@xrio/core": patch
---

Fork launches no longer fail with `must belong to this user with mode 0700` after a stock headless scrape first wrote to an empty host cache, because Xrio now creates missing cache directories with mode 0700 instead of the usual 0755 or 0775 the umask gives (delete a host cache directory an earlier version left that way).
