---
---

Move the two waits a child's teardown is built from into `bounded-wait.ts`.
Both were private to `child-server.ts`, where the only way to reach them was
through a spawned process, so neither race they guard could be driven from a
test: a write that never settles needs a child that has stopped reading its
stdin, and the already-exited check needs the child to die inside the flush
window. Behind a narrow interface, a stub drives both.

No release: nothing observable changes.
