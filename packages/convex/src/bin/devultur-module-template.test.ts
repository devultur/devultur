import { describe, expect, it } from "vitest";
import { Devultur } from "../client";
import type { ComponentApi } from "../component/_generated/component.js";
import { DEVULTUR_MODULE_TEMPLATE } from "./devultur-module-template";

const exportBlock = DEVULTUR_MODULE_TEMPLATE.slice(
	DEVULTUR_MODULE_TEMPLATE.indexOf("export const {"),
	DEVULTUR_MODULE_TEMPLATE.indexOf("} = defineDevulturFunctions"),
);
const lines = exportBlock.split("\n").map((line) => line.trim());
const exported = lines.filter((line) => /^\w+,$/.test(line)).map((line) => line.slice(0, -1));
const commentedOut = lines.filter((line) => /^\/\/ \w+,$/.test(line)).map((line) => line.slice(3, -1));

describe("the devultur-init module", () => {
	it("exports the library functions <MediaLibrary> and <MediaPicker> need", () => {
		expect(exported).toEqual(expect.arrayContaining(["listMediaPage", "searchMedia", "createUploadUrl"]));
	});

	it("leaves updateMediaMeta commented out, for the guard to authorize first", () => {
		expect(exported).not.toContain("updateMediaMeta");
		expect(commentedOut).toEqual(["updateMediaMeta"]);
	});

	it("exports only functions defineDevulturFunctions returns", () => {
		const functionNames = Object.keys(Devultur.exposeApi({} as ComponentApi));
		for (const name of [...exported, ...commentedOut]) expect(functionNames).toContain(name);
	});

	it("returns the signed-in user as the guard's userId", () => {
		expect(DEVULTUR_MODULE_TEMPLATE).toContain("return { userId: identity.subject };");
	});
});
