// Delivery of a storyboard's WebVTT with a token: like the HLS playlist, each sprite reference gets rewritten with
// the viewer's `?token=` so the player can request the private sprites without building its own URLs. The `#xywh=`
// fragment goes AFTER the query (URL syntax). A private VTT is encrypted at-rest like any non-HLS asset: it gets
// decrypted before rewriting.
import { createDecryptStream } from "@devultur/core";

const STORYBOARD_VTT = /(?:^|\/)video\/[^/]+\/storyboard\/[^/]+\.vtt$/;
// Cue line: `sprite-N.jpg` with its optional fragment. Nothing else is touched (timestamps, `WEBVTT`).
const SPRITE_LINE = /^(sprite-\d+\.jpg)(#xywh=\d+,\d+,\d+,\d+)?$/gm;

export function isStoryboardVttKey(key: string): boolean {
	return STORYBOARD_VTT.test(key);
}

/** VTT with the viewer's token on each sprite (`sprite-0.jpg?token=…#xywh=…`). Pure → testable. */
export function rewriteStoryboardVtt(vttText: string, token: string): string {
	return vttText.replace(SPRITE_LINE, (_line, file: string, fragment = "") => `${file}?token=${token}${fragment}`);
}

export interface StoryboardDecryption {
	key: CryptoKey;
	iv: Uint8Array;
}

/** Response for the rewritten VTT. No shared cache: it carries the viewer's token (same as the playlist). */
export async function storyboardVttResponse(
	body: ReadableStream,
	token: string,
	decryption: StoryboardDecryption | null,
): Promise<Response> {
	const plain = decryption ? body.pipeThrough(createDecryptStream(decryption.key, decryption.iv)) : body;
	const vttText = await new Response(plain).text();
	return new Response(rewriteStoryboardVtt(vttText, token), {
		headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "no-cache" },
	});
}
