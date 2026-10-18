// Uploading an output from the runner to the worker: single PUT up to the threshold; above it, the upload routes'
// multipart (parts of `partSize`, the one the create call sets) to avoid hitting the body limit or the Worker's
// memory (a single PUT buffers the whole thing). The worker does the L4 encryption of a private asset either way.
import { RESOURCE_SECURITY_HEADER } from "../helpers";

/** Above this an output uploads via multipart (a 5 Mbps hero MP4 passes 50 MB in ~80 s). */
export const DERIVED_MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;

const AUTH = '-H "Authorization: Bearer $UPLOAD_CREDENTIAL"';
const SECURITY = `-H "${RESOURCE_SECURITY_HEADER}: $RESOURCE_SECURITY"`;

// Field from a flat JSON response from the worker (no jq in the image: busybox sed). `etag` is captured up to the
// closing `"}` to keep escaped quotes as-is and pass them back to complete.
const jsonString = (field: string) => `sed -n 's/.*"${field}":"\\([^"]*\\)".*/\\1/p'`;
const jsonNumber = (field: string) => `sed -n 's/.*"${field}":\\([0-9]*\\).*/\\1/p'`;

/**
 * Shell that defines `upload_asset <file> <key> <content-type>`. Fails (exit ≠ 0) if the worker rejects any
 * multipart step → with `set -e` the script aborts and the trap emits `transcode.failed`.
 */
export function uploadAssetFunction(thresholdBytes = DERIVED_MULTIPART_THRESHOLD_BYTES): string {
	return [
		"upload_asset() {",
		'  ASSET_FILE="$1"; ASSET_KEY="$2"; ASSET_TYPE="$3"',
		"  ASSET_SIZE=$(wc -c < \"$ASSET_FILE\" | tr -d ' ')",
		`  if [ "$ASSET_SIZE" -le ${thresholdBytes} ]; then`,
		`    curl -sS -X PUT "$WORKER_URL/v1/upload/$ASSET_KEY" ${AUTH} ${SECURITY} -H "Content-Type: $ASSET_TYPE" --data-binary "@$ASSET_FILE"`,
		"    return 0",
		"  fi",
		'  echo "[transcode] multipart upload of $ASSET_KEY ($ASSET_SIZE bytes)"',
		`  CREATED=$(curl -sS --fail -X POST "$WORKER_URL/v1/upload/$ASSET_KEY?multipart=create" ${AUTH} ${SECURITY} -H "Content-Type: application/json" -d "{\\"size\\":$ASSET_SIZE,\\"contentType\\":\\"$ASSET_TYPE\\"}")`,
		`  UPLOAD_ID=$(printf '%s' "$CREATED" | ${jsonString("uploadId")})`,
		`  PART_SIZE=$(printf '%s' "$CREATED" | ${jsonNumber("partSize")})`,
		`  PART_COUNT=$(printf '%s' "$CREATED" | ${jsonNumber("partCount")})`,
		'  if [ -z "$UPLOAD_ID" ] || [ -z "$PART_SIZE" ] || [ -z "$PART_COUNT" ]; then return 1; fi',
		// R2's uploadId can contain `+`, `/` or `=`: it's URL-encoded in the query.
		"  UPLOAD_ID_QUERY=$(printf '%s' \"$UPLOAD_ID\" | sed -e 's/%/%25/g' -e 's/+/%2B/g' -e 's/\\//%2F/g' -e 's/=/%3D/g')",
		'  PARTS=""',
		"  PART=1",
		'  while [ "$PART" -le "$PART_COUNT" ]; do',
		// Each part is exactly `partSize` (the last one, the remainder): the worker rejects any other size.
		`    PART_RESPONSE=$(dd if="$ASSET_FILE" bs="$PART_SIZE" skip=$((PART - 1)) count=1 2>/dev/null | curl -sS --fail -X PUT "$WORKER_URL/v1/upload/$ASSET_KEY?uploadId=$UPLOAD_ID_QUERY&partNumber=$PART" ${AUTH} -H "Content-Type: application/octet-stream" --data-binary @-)`,
		`    ETAG=$(printf '%s' "$PART_RESPONSE" | sed -n 's/.*"etag":"\\(.*\\)"}.*/\\1/p')`,
		'    if [ -z "$ETAG" ]; then return 1; fi',
		'    PARTS="$PARTS,{\\"partNumber\\":$PART,\\"etag\\":\\"$ETAG\\"}"',
		"    PART=$((PART + 1))",
		"  done",
		"  PARTS=$(printf '%s' \"$PARTS\" | cut -c2-)",
		`  curl -sS --fail -X POST "$WORKER_URL/v1/upload/$ASSET_KEY?multipart=complete" ${AUTH} -H "Content-Type: application/json" -d "{\\"uploadId\\":\\"$UPLOAD_ID\\",\\"parts\\":[$PARTS]}" > /dev/null`,
		"}",
	].join("\n");
}
