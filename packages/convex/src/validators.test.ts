import { describe, expect, it } from "vitest";
import { dv } from "./validators";

describe("dv.media", () => {
	it("produce un validador object con los campos de DevulturMedia", () => {
		const validator = dv.media();
		expect(validator.kind).toBe("object");
		expect(Object.keys(validator.fields).sort()).toEqual([
			"alt",
			"duration",
			"filename",
			"height",
			"id",
			"key",
			"kind",
			"pageCount",
			"sizeBytes",
			"tags",
			"title",
			"visibility",
			"width",
		]);
	});

	it("keeps every metadata field optional, so references stored before 1.4.0 stay valid", () => {
		const { fields } = dv.media();
		for (const field of ["title", "alt", "tags", "sizeBytes", "duration", "pageCount"] as const) {
			expect(fields[field].isOptional).toBe("optional");
		}
	});

	it("sin kind: acepta los tres tipos (union)", () => {
		const validator = dv.media();
		expect(validator.fields.kind.kind).toBe("union");
	});

	it("con kind: restringe a ese literal", () => {
		const validator = dv.media("image");
		expect(validator.fields.kind.kind).toBe("literal");
		expect((validator.fields.kind as { value: unknown }).value).toBe("image");
	});

	it("id/kind/visibility son requeridos; filename/width/height opcionales", () => {
		const { fields } = dv.media();
		expect(fields.id.isOptional).toBe("required");
		expect(fields.visibility.isOptional).toBe("required");
		expect(fields.filename.isOptional).toBe("optional");
		expect(fields.width.isOptional).toBe("optional");
	});

	it("keeps `key` optional, so references stored without it stay valid", () => {
		expect(dv.media().fields.key.isOptional).toBe("optional");
	});
});
