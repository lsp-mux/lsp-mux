---
'lsp-proxy': minor
---

Resolve relative paths inside a server's `settings` against the config
directory, as `command` and `args` already were. A server that reads a path
from its settings can now be configured portably.
