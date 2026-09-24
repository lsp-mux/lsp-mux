---
---

Move the per-document version offset bookkeeping out of `LspProxy` into
`version-offsets.ts`. A resync and a replay both add the offset to a client
version, and both did it inline against the proxy's own fields; as pure
functions over the document map they are testable on their own, and the unit
tests now cover the arithmetic that only an end-to-end watcher test reached.

No release: nothing observable changes.
