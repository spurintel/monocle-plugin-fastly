// Minimal stand-in for the Compute runtime's `fastly:logger` builtin. The
// real module only exists inside the Fastly runtime (the esbuild bundle marks
// fastly:* external), but Vite must still RESOLVE the specifier to transform
// modules that import it. Tests that care about Logger behaviour replace this
// with vi.mock('fastly:logger', ...).
export class Logger {
	constructor(_endpoint: string) {}
	log(_message: string): void {}
}
