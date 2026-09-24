---
'lsp-proxy-config-default': patch
---

Add an end-to-end suite that installs the packed tarballs into a throwaway npm
project and drives the proxy they generate, asserting that a single-file
component reaches both linters and that the published package still carries the
vtsls override. Nothing before it exercised an install, so the two bugs that
made the published package inert — resolution that assumed pnpm's layout, and a
copy that dropped `servers/` from the tarball — were only ever visible by hand.
