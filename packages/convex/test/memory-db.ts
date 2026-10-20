// A minimal in-memory stand-in for a Convex `ctx.db`: enough of insert / get / patch / delete and
// `query(table).withIndex(name, (q) => q.eq(...)).first() | .collect()` (plus `.filter()` and `.collect()` on a whole
// table) to run the component's functions for real.

type Document = Record<string, unknown> & { _id: string };

interface IndexRange {
	eq(field: string, value: unknown): IndexRange;
}

interface FieldFilter {
	field(name: string): string;
	eq(field: string, value: unknown): [string, unknown];
}

export function memoryDb() {
	const tables = new Map<string, Document[]>();
	let nextId = 0;

	const rows = (table: string) => {
		const existing = tables.get(table);
		if (existing) return existing;
		const created: Document[] = [];
		tables.set(table, created);
		return created;
	};
	const findById = (id: string) => [...tables.values()].flat().find((document) => document._id === id);

	return {
		tables,
		async insert(table: string, fields: Record<string, unknown>) {
			const _id = `${table}:${nextId++}`;
			rows(table).push({ ...fields, _id });
			return _id;
		},
		async get(id: string) {
			return findById(id) ?? null;
		},
		// Like Convex, a field patched to `undefined` is removed.
		async patch(id: string, fields: Record<string, unknown>) {
			const document = findById(id);
			if (!document) throw new Error(`No document ${id}`);
			for (const [name, value] of Object.entries(fields)) {
				if (value === undefined) delete document[name];
				else document[name] = value;
			}
		},
		async delete(id: string) {
			for (const documents of tables.values()) {
				const index = documents.findIndex((document) => document._id === id);
				if (index !== -1) documents.splice(index, 1);
			}
		},
		query(table: string) {
			const conditions: [string, unknown][] = [];
			const matches = () =>
				rows(table).filter((document) => conditions.every(([field, value]) => document[field] === value));
			const range: IndexRange = {
				eq(field, value) {
					conditions.push([field, value]);
					return range;
				},
			};
			// `order(...).paginate(...)`: the cursor is the offset of the page's end, as a string.
			const order = (direction: "asc" | "desc") => ({
				paginate: async ({ numItems, cursor }: { numItems: number; cursor: string | null }) => {
					const ordered = direction === "desc" ? matches().reverse() : matches();
					const start = cursor ? Number(cursor) : 0;
					const end = start + numItems;
					return { page: ordered.slice(start, end), isDone: end >= ordered.length, continueCursor: String(end) };
				},
			});
			return {
				withIndex(_index: string, select: (q: IndexRange) => IndexRange) {
					select(range);
					return { first: async () => matches()[0] ?? null, collect: async () => matches(), order };
				},
				order,
				// Only `filter((q) => q.eq(q.field(name), value))`, the one filter the component uses.
				filter(select: (q: FieldFilter) => [string, unknown]) {
					conditions.push(select({ field: (name) => name, eq: (field, value) => [field, value] }));
					return { collect: async () => matches() };
				},
				collect: async () => matches(),
			};
		},
	};
}

export type MemoryDb = ReturnType<typeof memoryDb>;
