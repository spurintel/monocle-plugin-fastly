import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The `fastly:*` modules exist only in the Compute runtime; tests run the handler in Node
// against the doubles in test/doubles.
const double = (name: string) => fileURLToPath(new URL(`./test/doubles/${name}.ts`, import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'fastly:config-store': double('config-store'),
			'fastly:secret-store': double('secret-store'),
			'fastly:cache': double('cache'),
			'fastly:cache-override': double('cache-override'),
			'fastly:html-rewriter': double('html-rewriter'),
			'fastly:env': double('env'),
			'fastly:websocket': double('websocket'),
		},
	},
	test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
