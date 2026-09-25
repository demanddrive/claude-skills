/**
 * Load the npm dependencies from wherever the plugin is running.
 *
 * Claude Code may run a plugin from its install cache (where it installs dependencies) or
 * in place from the marketplace source (where it doesn't), so a bare `import 'playwright'`
 * can fail. This resolves the packages from the package.json that declares them and, if
 * they're missing, installs them there once (`npm ci`) before loading.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname( fileURLToPath( import.meta.url ) );

/**
 * The nearest folder above the scripts whose package.json declares playwright: the plugin
 * root when installed, the repository root in a clone.
 *
 * @return {string} Directory path.
 */
export function packageRoot() {
	for ( let dir = here; ; dir = path.dirname( dir ) ) {
		const pkg = path.join( dir, 'package.json' );
		if ( fs.existsSync( pkg ) && fs.readFileSync( pkg, 'utf8' ).includes( '"playwright"' ) ) {
			return dir;
		}
		if ( path.dirname( dir ) === dir ) {
			throw new Error( 'No package.json declaring playwright found above the figma-visual-diff scripts.' );
		}
	}
}

/**
 * Install the dependencies into packageRoot() (skipping when they're already there).
 *
 * @param {boolean} force Reinstall even if present.
 * @return {string} The package root.
 */
export function installDeps( force = false ) {
	const root = packageRoot();
	if ( force || ! fs.existsSync( path.join( root, 'node_modules', 'playwright' ) ) ) {
		process.stderr.write( `[figma-visual-diff] installing dependencies in ${ root } (one-time)…\n` );
		const lock = fs.existsSync( path.join( root, 'package-lock.json' ) );
		execFileSync( 'npm', [ lock ? 'ci' : 'install', '--no-audit', '--no-fund', '--ignore-scripts' ], { cwd: root, stdio: [ 'ignore', 'ignore', 'inherit' ] } );
	}
	return root;
}

async function importFrom( root, name ) {
	const resolved = createRequire( path.join( root, 'package.json' ) ).resolve( name );
	return import( pathToFileURL( resolved ).href );
}

let loaded = null;

/**
 * @return {Promise<{chromium: Object, pixelmatch: Function, PNG: Function}>} The dependencies.
 */
export function loadDeps() {
	if ( ! loaded ) {
		loaded = ( async () => {
			let root = packageRoot();
			try {
				createRequire( path.join( root, 'package.json' ) ).resolve( 'playwright' );
			} catch {
				root = installDeps();
			}
			const [ playwright, pixelmatch, pngjs ] = await Promise.all( [ importFrom( root, 'playwright' ), importFrom( root, 'pixelmatch' ), importFrom( root, 'pngjs' ) ] );
			return { chromium: playwright.chromium ?? playwright.default.chromium, pixelmatch: pixelmatch.default ?? pixelmatch, PNG: pngjs.PNG ?? pngjs.default.PNG };
		} )();
	}
	return loaded;
}
