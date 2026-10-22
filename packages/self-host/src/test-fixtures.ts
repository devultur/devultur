// Test-only: upload bodies whose first bytes carry a real signature for their declared Content-Type, so the Worker's
// content sniffing (content-sniff.ts) accepts them. Not exported from the package.

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

const SIGNATURES: Record<string, number[]> = {
	"application/pdf": ascii("%PDF-1.7\n"),
	"image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
	"image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	// A 24-byte `ftyp` box: major brand isom, minor version 0x200, compatible brands isom and mp41.
	"video/mp4": [0, 0, 0, 0x18, ...ascii("ftypisom"), 0, 0, 2, 0, ...ascii("isommp41")],
	"application/zip": [0x50, 0x4b, 0x03, 0x04],
};

function signatureOf(contentType: string): number[] {
	const signature = SIGNATURES[contentType];
	if (!signature) throw new Error(`test-fixtures: no signature for ${contentType}`);
	return signature;
}

/** `size` bytes (at least the signature's length): the signature of `contentType`, then zeros. */
export function sniffableBytes(contentType: string, size = 64): Uint8Array<ArrayBuffer> {
	const signature = signatureOf(contentType);
	const bytes = new Uint8Array(Math.max(size, signature.length));
	bytes.set(signature);
	return bytes;
}

/** The signature of `contentType` followed by `body`. */
export function withSignature(contentType: string, body: string | Uint8Array): Uint8Array<ArrayBuffer> {
	const signature = signatureOf(contentType);
	const payload = typeof body === "string" ? new TextEncoder().encode(body) : body;
	const bytes = new Uint8Array(signature.length + payload.length);
	bytes.set(signature);
	bytes.set(payload, signature.length);
	return bytes;
}
