import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The fastly:* builtin modules exist only inside the Compute runtime (the
// esbuild bundle marks them --external). Vite still needs each imported
// specifier to resolve during test transforms, so alias them to local stubs;
// individual tests override behaviour with vi.mock where it matters.
export default defineConfig({
	resolve: {
		alias: {
			'fastly:logger': fileURLToPath(new URL('./test/stubs/fastly-logger.ts', import.meta.url)),
		},
	},
});
