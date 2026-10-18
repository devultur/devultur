const encoder = new TextEncoder();

/**
 * Constant-time string comparison (with respect to content): it always walks every byte of `expected`, so the
 * timing does not reveal how many characters of a secret an attacker guessed. Only the length is not secret. Pure.
 */
export function isConstantTimeEqual(received: string, expected: string): boolean {
	const receivedBytes = encoder.encode(received);
	const expectedBytes = encoder.encode(expected);
	let difference = receivedBytes.length ^ expectedBytes.length;
	for (let index = 0; index < expectedBytes.length; index++) {
		difference |= (receivedBytes[index] ?? 0) ^ expectedBytes[index];
	}
	return difference === 0;
}

/** Does `authHeader` carry `Bearer <secret>`? Fail-closed: an unset or empty secret authorizes nobody. Pure. */
export function isBearerAuthorized(secret: string | undefined, authHeader: string | undefined): boolean {
	if (!secret || !authHeader) return false;
	return isConstantTimeEqual(authHeader, `Bearer ${secret}`);
}
