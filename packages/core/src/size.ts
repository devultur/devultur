export const ByteUnit = {
	B: "B",
	KB: "KB",
	MB: "MB",
	GB: "GB",
	TB: "TB",
} as const;

export type ByteUnit = (typeof ByteUnit)[keyof typeof ByteUnit];

export const BYTES_PER_UNIT: Record<ByteUnit, number> = {
	[ByteUnit.B]: 1,
	[ByteUnit.KB]: 1024,
	[ByteUnit.MB]: 1024 ** 2,
	[ByteUnit.GB]: 1024 ** 3,
	[ByteUnit.TB]: 1024 ** 4,
};

export function parseSize(size: string | number): number {
	if (typeof size === "number") return size;

	const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/i);
	if (!match) {
		throw new Error(`Invalid size format: "${size}". Expected format like "2GB", "10MB", "500KB".`);
	}

	const value = Number.parseFloat(match[1]);
	const unit = match[2].toUpperCase() as ByteUnit;

	return Math.floor(value * BYTES_PER_UNIT[unit]);
}

export function formatSize(bytes: number): string {
	if (bytes === 0) return `0 ${ByteUnit.B}`;
	const units = Object.values(ByteUnit);
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
