// wrangler bundlea `import x from "*.wasm"` como `WebAssembly.Module` (regla CompiledWasm).
declare module "*.wasm" {
	const wasmModule: WebAssembly.Module;
	export default wasmModule;
}
