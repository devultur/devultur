import { describe, expect, it } from "vitest";
import {
	signWebhook,
	verifyWebhookSignature,
	WEBHOOK_ID_HEADER,
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_TIMESTAMP_HEADER,
} from "./webhook-signature";

// The Standard Webhooks specification's own test vector (standard-webhooks/standard-webhooks, the libraries' tests).
const SPEC_VECTOR = {
	secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
	id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
	timestamp: 1614265330,
	payload: '{"test": 2432232314}',
	signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

const OLD_SECRET = "whsec_b2xkLXNlY3JldC1vbGQtc2VjcmV0LTEyMzQ1Ng==";
const NEW_SECRET = "a-plain-new-secret";

describe("signWebhook", () => {
	it("matches the Standard Webhooks test vector", async () => {
		const headers = await signWebhook(SPEC_VECTOR);

		expect(headers).toEqual({
			[WEBHOOK_ID_HEADER]: SPEC_VECTOR.id,
			[WEBHOOK_TIMESTAMP_HEADER]: String(SPEC_VECTOR.timestamp),
			[WEBHOOK_SIGNATURE_HEADER]: SPEC_VECTOR.signature,
		});
	});

	it("signs with every secret during a rotation", async () => {
		const headers = await signWebhook({ id: "evt_1", payload: "{}", secret: [OLD_SECRET, NEW_SECRET] });

		expect(headers[WEBHOOK_SIGNATURE_HEADER].split(" ")).toHaveLength(2);
	});

	it("refuses to sign without a secret", async () => {
		await expect(signWebhook({ id: "evt_1", payload: "{}", secret: "" })).rejects.toThrow("no secret");
	});
});

describe("verifyWebhookSignature", () => {
	const now = SPEC_VECTOR.timestamp + 10;
	const specHeaders = {
		[WEBHOOK_ID_HEADER]: SPEC_VECTOR.id,
		[WEBHOOK_TIMESTAMP_HEADER]: String(SPEC_VECTOR.timestamp),
		[WEBHOOK_SIGNATURE_HEADER]: SPEC_VECTOR.signature,
	};

	it("accepts the Standard Webhooks test vector", async () => {
		const result = await verifyWebhookSignature({
			payload: SPEC_VECTOR.payload,
			headers: new Headers(specHeaders),
			secret: SPEC_VECTOR.secret,
			now,
		});

		expect(result).toEqual({ ok: true, id: SPEC_VECTOR.id, timestamp: SPEC_VECTOR.timestamp });
	});

	it("refuses a payload changed after signing", async () => {
		const result = await verifyWebhookSignature({
			payload: '{"test": 2432232315}',
			headers: specHeaders,
			secret: SPEC_VECTOR.secret,
			now,
		});

		expect(result).toEqual({ ok: false, reason: "no_matching_signature" });
	});

	it("refuses a stale timestamp, even with a valid signature", async () => {
		const result = await verifyWebhookSignature({
			payload: SPEC_VECTOR.payload,
			headers: specHeaders,
			secret: SPEC_VECTOR.secret,
			now: SPEC_VECTOR.timestamp + 301,
		});

		expect(result).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
	});

	it("refuses a timestamp from the future past the tolerance", async () => {
		const result = await verifyWebhookSignature({
			payload: SPEC_VECTOR.payload,
			headers: specHeaders,
			secret: SPEC_VECTOR.secret,
			now: SPEC_VECTOR.timestamp - 301,
		});

		expect(result.ok).toBe(false);
	});

	it("refuses missing headers and a malformed timestamp", async () => {
		const missing = await verifyWebhookSignature({ payload: "{}", headers: {}, secret: NEW_SECRET });
		const malformed = await verifyWebhookSignature({
			payload: "{}",
			headers: { ...specHeaders, [WEBHOOK_TIMESTAMP_HEADER]: "soon" },
			secret: NEW_SECRET,
		});

		expect(missing).toEqual({ ok: false, reason: "missing_headers" });
		expect(malformed).toEqual({ ok: false, reason: "invalid_timestamp" });
	});

	it("accepts a webhook signed with both secrets on a receiver holding either one", async () => {
		const headers = await signWebhook({ id: "evt_1", payload: "{}", secret: [OLD_SECRET, NEW_SECRET] });

		for (const secret of [OLD_SECRET, NEW_SECRET]) {
			const result = await verifyWebhookSignature({ payload: "{}", headers, secret });
			expect(result.ok).toBe(true);
		}
	});

	it("accepts a webhook signed with the new secret on a receiver still holding both", async () => {
		const headers = await signWebhook({ id: "evt_1", payload: "{}", secret: NEW_SECRET });

		const result = await verifyWebhookSignature({ payload: "{}", headers, secret: [OLD_SECRET, NEW_SECRET] });

		expect(result.ok).toBe(true);
	});

	it("fails closed without a secret", async () => {
		const headers = await signWebhook({ id: "evt_1", payload: "{}", secret: NEW_SECRET });

		const result = await verifyWebhookSignature({ payload: "{}", headers, secret: "" });

		expect(result).toEqual({ ok: false, reason: "no_matching_signature" });
	});

	it("ignores signatures of other versions", async () => {
		const headers = await signWebhook({ id: "evt_1", payload: "{}", secret: NEW_SECRET });
		const signature = headers[WEBHOOK_SIGNATURE_HEADER].slice(3);

		const result = await verifyWebhookSignature({
			payload: "{}",
			headers: { ...headers, [WEBHOOK_SIGNATURE_HEADER]: `v2,${signature}` },
			secret: NEW_SECRET,
		});

		expect(result.ok).toBe(false);
	});
});
