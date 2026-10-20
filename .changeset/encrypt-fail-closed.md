---
"@devultur/self-host": patch
---

Encryption at rest fails closed. With `security.encrypt` on (Worker-wide or per resource) and no `KEYS_BUCKET` bound, the Worker used to store private files in plaintext without a word. It now refuses with `503 keys_bucket_missing` and stores nothing:
- `POST /v1/upload` refuses before the client uploads any bytes, and the upload `PUT` and multipart create refuse as a backstop.
- `POST /v1/transcode` refuses to launch a private video, whose HLS segments couldn't be encrypted.
- `POST /v1/captions` refuses before transcribing a private video.

**Behaviour change for misconfigured Workers:** a Worker with `encrypt` on and no `KEYS_BUCKET` now answers `503` to those requests instead of storing plaintext. Bind a `KEYS_BUCKET` (see the self-host guide) or turn `encrypt` off. Public files, HLS segments and Workers with encryption off are unaffected. The code is exported as `KEYS_BUCKET_MISSING_CODE`.

**Upgrading:** nothing already stored is encrypted after the fact. Private files that a Worker with `encrypt` on and no `KEYS_BUCKET` stored in plaintext stay plaintext, and so do their image variants. Re-upload them, with `KEYS_BUCKET` bound, to encrypt them.
