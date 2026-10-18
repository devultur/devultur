// Area-average downscale (like OpenCV's `INTER_AREA`) in pure JS, row by row.
// Why not jSquash's WASM resize for downscaling: its heap grows to ~7x the INPUT RGBA bytes (it converts to
// f32 and does two passes) and the WASM memory never frees → a 12 MP image leaves ~330 MB on the isolate (limit
// 128 MB). This uses O(output width) memory: just the output image + 2 rows of f32 accumulators.
// For downscaling, area averaging has no ringing or aliasing; WASM (lanczos3) is reserved for upscaling.

interface Pixels {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

/** Source window to downscale (the `cover` crop): read in place, without copying the crop. */
export interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Coverage of each source pixel on the output axis: [output index, weight] (1 or 2 per pixel). */
function axisCoverage(sourceSize: number, targetSize: number): { first: Int32Array; split: Float32Array } {
	const scale = sourceSize / targetSize;
	const first = new Int32Array(sourceSize);
	const split = new Float32Array(sourceSize);
	for (let index = 0; index < sourceSize; index += 1) {
		const target = Math.floor(index / scale);
		const boundary = (target + 1) * scale;
		first[index] = target;
		// Fraction of the pixel that falls on `target`; the rest (if any) falls on `target + 1`.
		split[index] = boundary >= index + 1 ? 1 : boundary - index;
	}
	return { first, split };
}

export function areaDownscale(
	source: Pixels,
	width: number,
	height: number,
	region: Region = { x: 0, y: 0, width: source.width, height: source.height },
): Uint8ClampedArray<ArrayBuffer> {
	const horizontal = axisCoverage(region.width, width);
	const vertical = axisCoverage(region.height, height);
	const output = new Uint8ClampedArray(width * height * 4);
	const rowSum = new Float32Array(width * 4);
	let currentRow = new Float32Array(width * 4);
	let nextRow = new Float32Array(width * 4);
	const normalizer = 1 / ((region.width / width) * (region.height / height));

	for (let sourceY = 0; sourceY < region.height; sourceY += 1) {
		sumRowHorizontally(source, region, sourceY, horizontal, rowSum);
		const weight = vertical.split[sourceY];
		for (let index = 0; index < rowSum.length; index += 1) {
			currentRow[index] += rowSum[index] * weight;
			nextRow[index] += rowSum[index] * (1 - weight);
		}
		const isRowDone = sourceY === region.height - 1 || vertical.first[sourceY + 1] !== vertical.first[sourceY];
		if (!isRowDone) continue;
		writeRow(output, vertical.first[sourceY], currentRow, normalizer);
		[currentRow, nextRow] = [nextRow, currentRow];
		nextRow.fill(0);
	}
	return output;
}

// Accumulates alpha-premultiplied (RGB×A, A): without this, transparent pixels' color "bleeds" into the
// edges of a cropped PNG.
function sumRowHorizontally(
	source: Pixels,
	region: Region,
	sourceY: number,
	horizontal: { first: Int32Array; split: Float32Array },
	rowSum: Float32Array,
): void {
	rowSum.fill(0);
	const pixels = source.data;
	const lastTarget = rowSum.length - 4;
	let offset = ((region.y + sourceY) * source.width + region.x) * 4;
	for (let sourceX = 0; sourceX < region.width; sourceX += 1, offset += 4) {
		const target = horizontal.first[sourceX] * 4;
		const alpha = pixels[offset + 3];
		const weight = horizontal.split[sourceX] * alpha;
		addPixel(rowSum, target, pixels, offset, weight);
		if (weight < alpha && target < lastTarget) addPixel(rowSum, target + 4, pixels, offset, alpha - weight);
	}
}

function addPixel(row: Float32Array, target: number, pixels: Uint8ClampedArray, offset: number, weight: number): void {
	row[target] += pixels[offset] * weight;
	row[target + 1] += pixels[offset + 1] * weight;
	row[target + 2] += pixels[offset + 2] * weight;
	row[target + 3] += weight;
}

function writeRow(output: Uint8ClampedArray, targetY: number, row: Float32Array, normalizer: number): void {
	const start = targetY * row.length;
	for (let index = 0; index < row.length; index += 4) {
		const alphaSum = row[index + 3];
		const inverse = alphaSum > 0 ? 1 / alphaSum : 0;
		output[start + index] = row[index] * inverse;
		output[start + index + 1] = row[index + 1] * inverse;
		output[start + index + 2] = row[index + 2] * inverse;
		output[start + index + 3] = alphaSum * normalizer;
	}
}
