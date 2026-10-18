// `sh` script that runs inside the runner (Fly machine, container, VPS). Provider-agnostic: everything it
// needs comes in through env (INPUT_KEY, WORKER_URL, DOWNLOAD_TOKEN, CALLBACK_*, JOB_TICKET, KEY_B64, TRANSCODE_*) and
// state goes out through signed webhooks to `/v1/webhooks/transcode`.
import { RESOURCE_SECURITY_HEADER } from "../helpers";
import { masterPlaylistScript, SEGMENT_SECONDS } from "../transcode-ladder";
import type { MaxResolution } from "../types";
import { JOB_TICKET_HEADER } from "./job-ticket";
import { encodeParamsJson, perTitleScript } from "./per-title";
import { legacyPlan, type TranscodePlan } from "./plan";
import { planSetupScript } from "./plan-script";
import { hasAudioScript, posterScript } from "./poster-script";
import { STORYBOARD, storyboardUploadScript, storyboardVttScript } from "./storyboard-script";
import { uploadAssetFunction } from "./upload-script";

// Encode measurement for the Worker's operator (it's logged and a plugin reads it; the app's webhook doesn't get
// it): ffmpeg wall clock, vCPU and runner, highest rendition (`duration`, already in the event, = source duration) and
// per-title encode: complexity score (`null` without a probe), probe seconds and CRF/maxrate per rung.
function encodeJson(plan: TranscodePlan): string {
	const fields = [
		'\\"seconds\\":$ENCODE_SECONDS',
		'\\"cpus\\":$TRANSCODE_CPUS',
		'\\"topRung\\":\\"$TOP_RES\\"',
		'\\"runner\\":\\"$TRANSCODE_RUNNER\\"',
		'\\"complexity\\":$PT_SCORE',
		'\\"probeSeconds\\":$PROBE_SECONDS',
		`\\"params\\":${encodeParamsJson(plan)}`,
	];
	return `\\"encode\\":{${fields.join(",")}}`;
}

// After the encode, each output from /tmp/outputs.list with its real size (`width`/`height` of the frame or the
// MP4), into OUTPUTS_JSON: comma-separated `{variant,kind,rung,key,width,height}`, ready for `"renditions":[…]`.
export function renditionsScript(): string[] {
	return [
		'OUTPUTS_JSON=""',
		"while read -r O_PROBE O_JSON; do",
		'  O_DIMS=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$O_PROBE" | head -1)',
		'  O_W=$(echo "$O_DIMS" | cut -s -d, -f1)',
		'  O_H=$(echo "$O_DIMS" | cut -s -d, -f2)',
		'  case "$O_W" in ""|*[!0-9]*) O_W=0 ;; esac',
		'  case "$O_H" in ""|*[!0-9]*) O_H=0 ;; esac',
		'  OUTPUTS_JSON="$OUTPUTS_JSON,$O_JSON,\\"width\\":$O_W,\\"height\\":$O_H}"',
		"done < /tmp/outputs.list",
		"OUTPUTS_JSON=$(printf '%s' \"$OUTPUTS_JSON\" | cut -c2-)",
	];
}

// Preset outputs for the client (only if the plan reports them): keys, poster and whether audio was kept. The
// worker (webhooks.ts) turns them into stable URLs before forwarding them.
function outputsReportJson(plan: TranscodePlan, posterKey: string): string {
	if (!plan.reportsOutputs) return "";
	const formats = plan.posterFormats.map((format) => `\\"${format}\\"`).join(",");
	return [
		"",
		'\\"renditions\\":[$OUTPUTS_JSON]',
		`\\"posterKey\\":\\"${posterKey}\\"`,
		`\\"posterFormats\\":[${formats}]`,
		'\\"hasAudio\\":$HAS_AUDIO',
	].join(",");
}

export interface BuildScriptOptions {
	videoId: string;
	maxResolution: MaxResolution;
	outputPrefix: string;
	thumbnailKey: string;
	/** Output plan; absent → the legacy HLS ladder up to `maxResolution`. */
	plan?: TranscodePlan;
	/** Poster key; absent → `poster.jpg` next to the thumbnail. */
	posterKey?: string;
	/** MP4 prefix; absent → `mp4/` next to `hls/`. */
	mp4Prefix?: string;
	/** Storyboard prefix; absent → `storyboard/` next to `hls/`. */
	storyboardPrefix?: string;
	/** Multipart threshold for large outputs (tests). Absent → `DERIVED_MULTIPART_THRESHOLD_BYTES`. */
	multipartThresholdBytes?: number;
	encrypt?: boolean;
}

export function buildScript(options: BuildScriptOptions): string {
	// L4: HLS muxer option to encrypt the segments (AES-128 CBC) reading the keyinfo. Empty if the
	// video isn't encrypted → ladder identical to today. Private MP4s are encrypted at rest in the PUT (file-level L4).
	const hlsKeyOption = options.encrypt ? "-hls_key_info_file /tmp/enc.keyinfo " : "";
	const plan = options.plan ?? legacyPlan(options.maxResolution);
	const playlistKey = `${options.outputPrefix}playlist.m3u8`;
	const mp4Prefix = options.mp4Prefix ?? options.outputPrefix.replace(/hls\/$/, "mp4/");
	const posterKey = options.posterKey ?? options.thumbnailKey.replace(/[^/]+$/, "poster.jpg");
	const storyboardPrefix = options.storyboardPrefix ?? options.outputPrefix.replace(/hls\/$/, "storyboard/");
	const putAsset = `curl -sS -X PUT -H "Authorization: Bearer $UPLOAD_CREDENTIAL" -H "${RESOURCE_SECURITY_HEADER}: $RESOURCE_SECURITY"`;
	const ladderSetup = planSetupScript(plan, hlsKeyOption, { playlistKey, mp4Prefix });

	// Every callback carries the shared secret → the webhook rejects POSTs not originated by this machine; and the
	// job's signed ticket (job-ticket.ts) → the webhook knows which job it belongs to.
	const callbackHeaders = `-H "Content-Type: application/json" -H "Authorization: Bearer $CALLBACK_SECRET" -H "${JOB_TICKET_HEADER}: $JOB_TICKET"`;
	const sendEvent = `curl -sS -X POST "$CALLBACK_URL" ${callbackHeaders} -d`;
	// `transcode.complete` is the job's terminal event (the app relies on receiving it): it retries on
	// transient errors (connection, 408/429/5xx) and `--fail` makes a non-2xx count as an error. Consumers
	// treat it as idempotent per videoId → retrying doesn't duplicate effects.
	const sendCompletion = `curl -sS --fail --retry 5 --retry-delay 3 --retry-connrefused -X POST "$CALLBACK_URL" ${callbackHeaders} -d`;

	return [
		"set -e",
		uploadAssetFunction(options.multipartThresholdBytes),
		// With `set -e`, any failing command aborts the script and the machine self-destructs
		// WITHOUT sending `transcode.complete` → the client would be stuck in "transcoding". This trap
		// emits `transcode.failed` on abnormal exit so the webhook still arrives. `STAGE`
		// gives context on where it failed; `COMPLETED` keeps it from firing after a successful finish.
		"STAGE=starting",
		// Failure categorized by stage: `reason` + `retriable` (unquoted JSON bool) → the client decides
		// the message and whether to retry. downloading=invalid/non-retriable input; encoding=unsupported codec;
		// starting=capacity (the machine didn't start, retriable); everything else=internal, retriable.
		`notify_failure() { ec=$?; [ "$ec" -eq 0 ] && return 0; [ -n "$COMPLETED" ] && return 0; case "$STAGE" in downloading) R=invalid_input; T=false ;; encoding) R=unsupported_codec; T=false ;; starting) R=capacity; T=true ;; *) R=internal; T=true ;; esac; ${sendEvent} "{\\"event\\":\\"transcode.failed\\",\\"videoId\\":\\"${options.videoId}\\",\\"error\\":\\"transcode failed at $STAGE (exit $ec)\\",\\"reason\\":\\"$R\\",\\"retriable\\":$T}" || true; }`,
		"trap notify_failure EXIT",
		"echo '[transcode] starting'",
		// /tmp/probe holds one frame per rendition (for the master's RESOLUTION); not uploaded.
		"mkdir -p /tmp/output /tmp/probe /tmp/mp4 /tmp/storyboard",
		// L4: keyfile (16 bytes from KEY_B64) + keyinfo for ffmpeg. keyinfo line 1 = URI that gets
		// baked into the playlist (`$KEY_ID.key`, relative → resolves against the hls/ folder on delivery);
		// line 2 = local path to the keyfile ffmpeg uses to encrypt. Outside /tmp/output → not uploaded.
		...(options.encrypt
			? [
					'echo "$KEY_B64" | base64 -d > /tmp/enc.keyfile',
					`printf '%s\\n%s\\n' "$KEY_ID.key" "/tmp/enc.keyfile" > /tmp/enc.keyinfo`,
				]
			: []),
		"STAGE=downloading",
		// "Machine alive" heartbeat: the first progress event (phase=downloading) moves the video out of
		// "queued" within seconds, BEFORE downloading the input (which can take a while). Without this the
		// status takes ~as long as the download.
		`${sendEvent} "{\\"event\\":\\"transcode.progress\\",\\"videoId\\":\\"${options.videoId}\\",\\"currentSegment\\":0,\\"totalSegments\\":100,\\"phase\\":\\"downloading\\"}"`,
		'echo "[transcode] downloading input from R2"',
		// The input (raw, private) is downloaded with the service download token, not the upload credential: the
		// delivery gate requires a valid viewer token for private media. The worker decrypts the raw if it's encrypted.
		'curl -sS -o /tmp/input "$WORKER_URL/v1/media/$INPUT_KEY" -H "Authorization: Bearer $DOWNLOAD_TOKEN"',
		'echo "[transcode] input downloaded: $(du -h /tmp/input | cut -f1)"',
		"DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/input)",
		`TOTAL_SEGMENTS=$(echo "$DURATION / ${SEGMENT_SECONDS}" | bc)`,
		"TOTAL_SEGMENTS=$((TOTAL_SEGMENTS + 1))",
		`${sendEvent} "{\\"event\\":\\"transcode.started\\",\\"videoId\\":\\"${options.videoId}\\",\\"totalSegments\\":$TOTAL_SEGMENTS,\\"duration\\":$DURATION}"`,

		// Complexity probe (per-title encode) BEFORE setup: the ffmpeg args read its `PT_*` values.
		"STAGE=probing",
		perTitleScript(plan),
		ladderSetup,
		"STAGE=encoding",
		'echo "[transcode] running ffmpeg hls encode"',
		// `set -f`: FF_OUTPUTS is expanded unquoted (intentional word-splitting) and carries a `*` in
		// -force_key_frames's `expr:` → without noglob the shell could expand it against the filesystem.
		"set -f",
		// Measurement: encode wall clock (ffmpeg only, no download/upload). × runner vCPU = vCPU-s.
		"ENCODE_START=$(date +%s)",
		"ffmpeg -nostdin -progress /tmp/ffmpeg_progress -i /tmp/input $FF_OUTPUTS &",
		"set +f",
		"FFMPEG_PID=$!",
		"LAST_PCT=0",
		"while kill -0 $FFMPEG_PID 2>/dev/null; do",
		"  sleep 5",
		"  if [ -f /tmp/ffmpeg_progress ]; then",
		'    CURRENT_US=$(grep "out_time_us" /tmp/ffmpeg_progress | tail -1 | cut -d= -f2)',
		'    if [ -n "$CURRENT_US" ] && [ "$CURRENT_US" -gt 0 ] 2>/dev/null; then',
		'      DURATION_US=$(echo "$DURATION * 1000000" | bc | cut -d. -f1)',
		"      PCT=$(( CURRENT_US * 100 / DURATION_US ))",
		'      if [ "$PCT" -gt "$LAST_PCT" ] && [ "$PCT" -le 100 ]; then',
		`        ${sendEvent} "{\\"event\\":\\"transcode.progress\\",\\"videoId\\":\\"${options.videoId}\\",\\"currentSegment\\":$PCT,\\"totalSegments\\":100,\\"phase\\":\\"encoding\\"}"`,
		"        LAST_PCT=$PCT",
		"      fi",
		"    fi",
		"  fi",
		"done",
		"wait $FFMPEG_PID",
		"ENCODE_SECONDS=$(( $(date +%s) - ENCODE_START ))",
		// Sanitize: these go raw into the event's JSON (number / slug), a weird env value shouldn't break it.
		'case "$TRANSCODE_CPUS" in ""|*[!0-9]*) TRANSCODE_CPUS=0 ;; esac',
		'case "$TRANSCODE_RUNNER" in ""|*[!a-z0-9-]*) TRANSCODE_RUNNER=unknown ;; esac',
		'echo "[transcode] encode took $ENCODE_SECONDS seconds on $TRANSCODE_CPUS vCPU ($TRANSCODE_RUNNER)"',
		...renditionsScript(),

		// The master's CODECS needs to know if the output has audio.
		hasAudioScript(plan),
		// Without an HLS ladder (MP4-only preset) there's no master to write.
		'if [ -n "$RENDITIONS" ]; then',
		'echo "[transcode] generating master playlist"',
		masterPlaylistScript(),
		"fi",
		storyboardVttScript(plan, `${storyboardPrefix}${STORYBOARD.vttFile}`),
		"STAGE=thumbnail",
		'echo "[transcode] generating poster and thumbnail"',
		// Poster and thumbnail are generated OUTSIDE /tmp/output so they upload to their own path (`thumbnails/…`,
		// where delivery serves them from) instead of sitting in the segment loop's hls/ folder.
		posterScript(plan),
		"STAGE=uploading",
		'echo "[transcode] uploading segments"',
		"CURRENT=0",
		// Counts the files to upload from hls/ (.ts segments + media playlists + master) and mp4/. Poster and
		// thumbnail upload separately to their own path. CURRENT and TOTAL line up with any plan.
		"TOTAL=$(ls /tmp/output/* /tmp/mp4/* 2>/dev/null | wc -l)",
		"for f in /tmp/output/*; do",
		// Empty folder (MP4-only preset): the glob stays literal.
		'  [ -e "$f" ] || continue',
		'  FILENAME=$(basename "$f")',
		'  CT="application/octet-stream"',
		'  case "$FILENAME" in',
		'    *.m3u8) CT="application/vnd.apple.mpegurl" ;;',
		'    *.ts) CT="video/mp2t" ;;',
		"  esac",
		'  echo "[transcode] uploading $FILENAME ($(du -h "$f" | cut -f1))"',
		`  curl -sS -X PUT "$WORKER_URL/v1/upload/${options.outputPrefix}$FILENAME" -H "Authorization: Bearer $UPLOAD_CREDENTIAL" -H "${RESOURCE_SECURITY_HEADER}: $RESOURCE_SECURITY" -H "Content-Type: $CT" --data-binary "@$f"`,
		"  CURRENT=$((CURRENT + 1))",
		`  ${sendEvent} "{\\"event\\":\\"transcode.progress\\",\\"videoId\\":\\"${options.videoId}\\",\\"currentSegment\\":$CURRENT,\\"totalSegments\\":$TOTAL,\\"phase\\":\\"uploading\\"}"`,
		"done",
		// Standalone MP4s → `mp4/`: single PUT up to the threshold, multipart above it (a 200 MB hero doesn't fit in a
		// buffered PUT). A private one is encrypted at rest on either path and served with Range.
		"for f in /tmp/mp4/*; do",
		'  [ -e "$f" ] || continue',
		'  FILENAME=$(basename "$f")',
		'  echo "[transcode] uploading $FILENAME ($(du -h "$f" | cut -f1))"',
		`  upload_asset "$f" "${mp4Prefix}$FILENAME" "video/mp4"`,
		"  CURRENT=$((CURRENT + 1))",
		`  ${sendEvent} "{\\"event\\":\\"transcode.progress\\",\\"videoId\\":\\"${options.videoId}\\",\\"currentSegment\\":$CURRENT,\\"totalSegments\\":$TOTAL,\\"phase\\":\\"uploading\\"}"`,
		"done",
		storyboardUploadScript(plan, storyboardPrefix, putAsset),
		'echo "[transcode] uploading poster"',
		`curl -sS -X PUT "$WORKER_URL/v1/upload/${posterKey}" -H "Authorization: Bearer $UPLOAD_CREDENTIAL" -H "${RESOURCE_SECURITY_HEADER}: $RESOURCE_SECURITY" -H "Content-Type: image/jpeg" --data-binary "@/tmp/poster.jpg"`,
		// Thumbnail → its own path (`{visibility}/video/{id}/thumbnails/thumbnail.jpg`), with the propagated
		// binding override. Encrypted at rest if the policy requires it (it's a non-HLS private asset).
		'echo "[transcode] uploading thumbnail"',
		`curl -sS -X PUT "$WORKER_URL/v1/upload/${options.thumbnailKey}" -H "Authorization: Bearer $UPLOAD_CREDENTIAL" -H "${RESOURCE_SECURITY_HEADER}: $RESOURCE_SECURITY" -H "Content-Type: image/jpeg" --data-binary "@/tmp/thumbnail.jpg"`,
		'echo "[transcode] sending completion"',
		// MP4-only preset: no playlist to announce.
		`PLAYLIST_KEY="${playlistKey}"`,
		'[ -n "$RENDITIONS" ] || PLAYLIST_KEY=""',
		`${sendCompletion} "{\\"event\\":\\"transcode.complete\\",\\"videoId\\":\\"${options.videoId}\\",\\"duration\\":$DURATION,\\"playlistKey\\":\\"$PLAYLIST_KEY\\",\\"thumbnailKey\\":\\"${options.thumbnailKey}\\",\\"storyboardKey\\":\\"$STORYBOARD_KEY\\",${encodeJson(plan)}${outputsReportJson(plan, posterKey)}}"`,
		"COMPLETED=1",
		'echo "[transcode] done"',
	].join("\n");
}
