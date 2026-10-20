---
"@devultur/self-host": patch
---

A delete no longer destroys the encryption key of an upload still writing the same key.
- `DELETE /v1/media/:key` sweeps only the deleted version's key and the keys written before it. A key written after it belongs to an upload in flight (a multipart overwrite created before the delete, or a PUT between its key and its write), which now completes into an object that decrypts.
- The upload PUT and the multipart complete check that their key still exists right before writing the object. If it's gone, they answer `500 encryption_key_missing` (exported as `ENCRYPTION_KEY_MISSING_CODE`) and store nothing; the multipart session is aborted, so the client uploads again.
- A retried or concurrent multipart complete no longer deletes the key of the object the first complete wrote.
