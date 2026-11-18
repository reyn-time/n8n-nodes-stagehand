import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			'n8n-workflow': fileURLToPath(
				new URL('./node_modules/n8n-workflow/dist/index.js', import.meta.url),
			),
		},
	},
});
