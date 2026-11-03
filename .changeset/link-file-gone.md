---
"@devultur/self-host": patch
"@devultur/convex": patch
"@devultur/react": patch
---

A download link whose file was deleted answers `410 file_gone` instead of `404`: the link existed, its file doesn't (`@devultur/convex` labels the code in English and Spanish). Removes the reads of the field names renamed before 1.0 in download links and pending uploads (`callerContext`, `objectMetadata`), now that no link or pending upload written with them can still be alive, and two unused bindings in `useVideoPlayer`.
