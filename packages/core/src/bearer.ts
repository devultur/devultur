// Secret comparison for webhook receivers. Runtime-neutral (no Node APIs): it runs in Convex, edge workers and
// browsers alike.

const encoder = new TextEncoder();

/**
 * Constant-time string equality with respect to content: it always walks the longer of the two inputs, so the
 * time does not reveal at which byte they differ. Only the length is not secret.
 */
export function timingSafeEqual(received: string, expected: string): boolean {
	const receivedBytes = encoder.encode(received);
	const expectedBytes = encoder.encode(expected);
	const length = Math.max(receivedBytes.length, expectedBytes.length);
	let difference = receivedBytes.length ^ expectedBytes.length;
	for (let index = 0; index < length; index++) {
		difference |= (receivedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
	}
	return difference === 0;
}

/**
 * Whether `authHeader` is exactly `Bearer <secret>`. Fails closed: a missing or empty secret never authorizes,
 * so an unset environment variable cannot turn into an accepted `Bearer undefined` or `Bearer `.
 */
export function isBearerOf(authHeader: string | null | undefined, secret: string | null | undefined): boolean {
	if (!authHeader || !secret) return false;
	return timingSafeEqual(authHeader, `Bearer ${secret}`);
}
