async function importHmacKey(secret: string): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

function bufferToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function hexToBuffer(hex: string): ArrayBuffer {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes.buffer;
}

import { DEFAULT_PRESIGN_EXPIRY_SECONDS } from "./constants";

export async function signPayload(payload: string, secret: string): Promise<string> {
	const key = await importHmacKey(secret);
	const encoder = new TextEncoder();
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	return bufferToHex(signature);
}

export async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
	const key = await importHmacKey(secret);
	const encoder = new TextEncoder();
	const signatureBuffer = hexToBuffer(signature);
	return crypto.subtle.verify("HMAC", key, signatureBuffer, encoder.encode(payload));
}

export async function signUrl(url: string, secret: string, expiresIn?: number): Promise<string> {
	const expiry = expiresIn ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
	const expires = Math.floor(Date.now() / 1000) + expiry;

	const parsed = new URL(url);
	parsed.searchParams.set("expires", String(expires));

	const payload = `${parsed.origin}${parsed.pathname}?expires=${expires}`;
	const signature = await signPayload(payload, secret);

	parsed.searchParams.set("signature", signature);
	return parsed.toString();
}

export async function verifySignedUrl(signedUrl: string, secret: string): Promise<boolean> {
	const parsed = new URL(signedUrl);

	const expires = parsed.searchParams.get("expires");
	const signature = parsed.searchParams.get("signature");
	if (!expires || !signature) return false;

	const now = Math.floor(Date.now() / 1000);
	if (now > Number(expires)) return false;

	const payload = `${parsed.origin}${parsed.pathname}?expires=${expires}`;
	return verifySignature(payload, signature, secret);
}
