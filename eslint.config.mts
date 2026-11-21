import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'references/**',
		'.tmp/**',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// QuickAdd loads these scripts as JavaScript. Their JSDoc also supports type-aware linting.
		files: ['assets/templates/**/Integrations/*.js'],
		extends: [tseslint.configs.recommendedTypeChecked],
	},
);
