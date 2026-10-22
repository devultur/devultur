import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Drift check: `_generated/component.ts` (the `ComponentApi` apps type `components.devultur` with) must describe
// exactly the public functions of each module (`public.ts`, `lock.ts`, `uploads.ts`, `metadata.ts`, `library.ts`), with the same kind and arguments. It fails when a function or an
// argument changes without regenerating. Fix it with `pnpm --filter @devultur/convex codegen`.

type Visibility = "public" | "internal";
type FunctionKind = "query" | "mutation" | "action";

interface Validator {
	kind: string;
	isOptional: "optional" | "required";
	fields?: Record<string, Validator>;
	members?: Validator[];
	element?: Validator;
	value?: unknown;
}

interface Registered {
	kind: FunctionKind;
	visibility: Visibility;
	args: Record<string, Validator>;
}

vi.mock("./_generated/server", () => {
	const builder = (kind: FunctionKind, visibility: Visibility) => (definition: { args?: Record<string, unknown> }) => ({
		kind,
		visibility,
		args: definition.args ?? {},
	});
	return {
		env: {},
		query: builder("query", "public"),
		mutation: builder("mutation", "public"),
		action: builder("action", "public"),
		internalQuery: builder("query", "internal"),
		internalMutation: builder("mutation", "internal"),
		internalAction: builder("action", "internal"),
	};
});
vi.mock("./_generated/api", () => ({ api: {}, internal: {} }));

const publicModule = (await import("./public")) as unknown as Record<string, Registered>;
const MODULES: Record<string, Record<string, Registered>> = {
	public: publicModule,
	lock: (await import("./lock")) as unknown as Record<string, Registered>,
	uploads: (await import("./uploads")) as unknown as Record<string, Registered>,
	metadata: (await import("./metadata")) as unknown as Record<string, Registered>,
	library: (await import("./library")) as unknown as Record<string, Registered>,
};

function objectType(fields: [name: string, isOptional: boolean, type: string][]): string {
	const properties = fields
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, isOptional, type]) => `${name}${isOptional ? "?" : ""}:${type}`);
	return `{${properties.join(";")}}`;
}

function unionType(members: string[]): string {
	return [...new Set(members)].sort().join("|");
}

/** The TypeScript type a Convex validator stands for, in the canonical form `typeNodeText` also produces. */
function validatorType(validator: Validator): string {
	switch (validator.kind) {
		case "string":
		case "id":
			return "string";
		case "float64":
			return "number";
		case "int64":
			return "bigint";
		case "boolean":
		case "null":
		case "any":
			return validator.kind;
		case "literal":
			return JSON.stringify(validator.value);
		case "array":
			return `Array<${validatorType(validator.element as Validator)}>`;
		case "union":
			return unionType((validator.members ?? []).map(validatorType));
		case "object":
			return argsType(validator.fields ?? {});
		default:
			throw new Error(`Unsupported validator kind "${validator.kind}": extend generated-drift.test.ts`);
	}
}

function argsType(fields: Record<string, Validator>): string {
	return objectType(
		Object.entries(fields).map(([name, field]) => [name, field.isOptional === "optional", validatorType(field)]),
	);
}

/** A generated type node in canonical form: sorted object keys and union members, no whitespace. */
function typeNodeText(node: ts.TypeNode, source: ts.SourceFile): string {
	if (ts.isTypeLiteralNode(node)) {
		return objectType(
			node.members.filter(ts.isPropertySignature).map((member) => {
				if (!member.type) throw new Error(`Untyped property ${member.name.getText(source)}`);
				return [member.name.getText(source), !!member.questionToken, typeNodeText(member.type, source)];
			}),
		);
	}
	if (ts.isUnionTypeNode(node)) return unionType(node.types.map((member) => typeNodeText(member, source)));
	if (ts.isArrayTypeNode(node)) return `Array<${typeNodeText(node.elementType, source)}>`;
	if (ts.isParenthesizedTypeNode(node)) return typeNodeText(node.type, source);
	if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return JSON.stringify(node.literal.text);
	if (ts.isTypeReferenceNode(node) && node.typeName.getText(source) === "Array" && node.typeArguments?.[0]) {
		return `Array<${typeNodeText(node.typeArguments[0], source)}>`;
	}
	return node.getText(source).replace(/\s+/g, "");
}

interface GeneratedFunction {
	kind: string;
	args: string;
}

/** A module of the generated `ComponentApi`: each function's kind and canonical args type. */
function generatedApi(moduleName: string): Record<string, GeneratedFunction> {
	const path = join(import.meta.dirname, "_generated", "component.ts");
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const componentApi = source.statements.find(
		(statement): statement is ts.TypeAliasDeclaration =>
			ts.isTypeAliasDeclaration(statement) && statement.name.text === "ComponentApi",
	);
	if (!componentApi || !ts.isTypeLiteralNode(componentApi.type)) throw new Error("ComponentApi type not found");
	const publicModuleType = componentApi.type.members
		.filter(ts.isPropertySignature)
		.find((member) => member.name.getText(source) === moduleName)?.type;
	if (!publicModuleType || !ts.isTypeLiteralNode(publicModuleType)) {
		throw new Error(`ComponentApi.${moduleName} not found`);
	}

	const functions: Record<string, GeneratedFunction> = {};
	for (const member of publicModuleType.members.filter(ts.isPropertySignature)) {
		const reference = member.type;
		if (!reference || !ts.isTypeReferenceNode(reference) || !reference.typeArguments) continue;
		const [kind, , args] = reference.typeArguments;
		if (!kind || !args) continue;
		functions[member.name.getText(source)] = {
			kind: kind.getText(source).replace(/"/g, ""),
			args: typeNodeText(args, source),
		};
	}
	return functions;
}

function sourceApi(module: Record<string, Registered>): Record<string, GeneratedFunction> {
	const functions: Record<string, GeneratedFunction> = {};
	for (const [name, registered] of Object.entries(module)) {
		if (registered?.visibility !== "public") continue;
		functions[name] = { kind: registered.kind, args: argsType(registered.args) };
	}
	return functions;
}

describe("generated ComponentApi", () => {
	it.each(
		Object.keys(MODULES),
	)("lists exactly the public functions of %s.ts, with their kinds and arguments", (name) => {
		expect(generatedApi(name)).toEqual(sourceApi(MODULES[name] ?? {}));
	});

	it("leaves internal functions out, as Convex codegen does", () => {
		const generated = generatedApi("public");
		expect(publicModule.handleWebhookEvent?.visibility).toBe("internal");
		expect(generated).not.toHaveProperty("handleWebhookEvent");
	});
});
