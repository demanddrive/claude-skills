/**
 * Project conventions for the diff scripts, overridable per project.
 *
 * Nothing here is specific to one theme: defaults suit Impulse-derived themes (sections
 * are elements with a block-{slug} class) and fall back to WordPress block classes, then
 * to the content area's direct children. A project that differs adds
 * .figma-visual-diff.json at its root (found by walking up from the working directory):
 *
 *   {
 *     "contentRoot": "main",                 // where page sections live
 *     "sectionSelector": null,               // explicit CSS selector for sections, skips detection
 *     "slugPatterns": ["^block-([a-z0-9-]+)$"],  // class → section slug (first capture group)
 *     "sectionMap": { "Hero Banner": "interior-header" },  // Figma name → page slug
 *     "figmaIgnore": "^(Navigation|Footer)\\b",   // Figma top-level layers that aren't sections
 *     "mask": [],                            // slugs compared by presence only
 *     "live": ["post-slider"],               // slugs showing live posts: only their template is compared
 *     "iconClassPattern": "(^|\\s)icon-",    // icon-font elements
 *     "jev": { "url": "...", "model": "...", "keyEnv": "..." }  // a Jev provider other than OpenCode Zen
 *   }
 *
 * Settings that belong to the machine rather than the project, such as a local Jev provider,
 * can go in ~/.config/figma-visual-diff/config.json (under $XDG_CONFIG_HOME when set), in the
 * same format; the project file overrides it.
 *
 * CLI:
 *   node config.js figma-boxes <frame-id> [--section]
 *                                             the Figma extractor for use_figma (see lib/figma.js), with
 *                                             this project's ignore pattern; --section treats the node
 *                                             as one section (a single block)
 *   node config.js runs-dir <page-url> <width> [runs-root]  folder for this page and breakpoint's Figma files and runs
 *   node config.js setup                         install npm dependencies (if missing) and Playwright's Chromium
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDeps } from './deps.js';
import { isMain } from './lib/cli.js';
import { figmaScript } from './lib/figma.js';

export const DEFAULT_CONFIG = {
	contentRoot: 'main',
	sectionSelector: null,
	slugPatterns: [ '^block-([a-z0-9-]+)$', '^wp-block-acf-([a-z0-9-]+)$', '^wp-block-([a-z0-9-]+)$' ],
	sectionMap: {},
	figmaIgnore: '^(Navigation|Footer|Header|Wireframe Filter)\\b',
	mask: [],
	live: [ 'post-slider' ],
	iconClassPattern: '(^|\\s)icon-',
	// Jev provider: null is OpenCode Zen (see lib/jev.js).
	jev: null,
};

const FILE = '.figma-visual-diff.json';

/**
 * The user-level config file: machine settings shared by every project.
 *
 * @param {Object} env Environment variables.
 * @return {string} Path (the file may not exist).
 */
export function userConfigFile( env = process.env ) {
	return path.join( env.XDG_CONFIG_HOME || path.join( os.homedir(), '.config' ), 'figma-visual-diff', 'config.json' );
}

function readConfig( file ) {
	try {
		return JSON.parse( fs.readFileSync( file, 'utf8' ) );
	} catch ( error ) {
		throw new Error( `${ file } is not valid JSON: ${ error.message }` );
	}
}

/**
 * The defaults, overridden by the user config, overridden by the nearest project config.
 *
 * @param {string} explicit A project config file to use instead of searching for one.
 * @param {string} userFile The user config file (see userConfigFile()).
 * @return {Object} Config, with `source` naming the project file (or null).
 */
export function loadConfig( explicit, userFile = userConfigFile() ) {
	let file = explicit;
	for ( let dir = process.cwd(); ! file; dir = path.dirname( dir ) ) {
		if ( fs.existsSync( path.join( dir, FILE ) ) ) {
			file = path.join( dir, FILE );
		} else if ( fs.existsSync( path.join( dir, '.git' ) ) || path.dirname( dir ) === dir ) {
			break;
		}
	}
	const user = fs.existsSync( userFile ) ? readConfig( userFile ) : {};
	const project = file ? readConfig( file ) : {};
	return { ...DEFAULT_CONFIG, ...user, ...project, source: file || null };
}

/**
 * The repository root above `dir` (nearest folder with .git), so a shell that has cd'd
 * into a subfolder still files runs under the project.
 *
 * @param {string} dir Starting directory.
 * @return {string} Repository root, or `dir` when not inside a repository.
 */
export function projectRoot( dir ) {
	for ( let d = dir; ; d = path.dirname( d ) ) {
		if ( fs.existsSync( path.join( d, '.git' ) ) ) {
			return d;
		}
		if ( path.dirname( d ) === d ) {
			return dir;
		}
	}
}

const LOCAL_DIR = path.join( '.claude', 'figma-visual-diff' );

/** The project's own runs folder, <repo>/.claude/figma-visual-diff/runs: local to this checkout. */
export function localRunsRoot( dir = process.env.CLAUDE_PROJECT_DIR || process.cwd() ) {
	return path.join( projectRoot( dir ), LOCAL_DIR, 'runs' );
}

/**
 * Keep a runs folder under .claude/figma-visual-diff out of git with a .gitignore of its own,
 * so no project's .gitignore needs editing. Leaves any other folder, and an existing file, alone.
 *
 * @param {string} dir A runs folder, or any folder inside one.
 */
export function keepRunsLocal( dir ) {
	const resolved = path.resolve( dir );
	// Whole path components only: other.claude/figma-visual-diff is someone else's folder.
	const at = resolved.lastIndexOf( path.sep + LOCAL_DIR + path.sep );
	if ( at < 0 ) {
		return;
	}
	const base = resolved.slice( 0, at + 1 + LOCAL_DIR.length );
	fs.mkdirSync( base, { recursive: true } );
	// Created only if absent, in one step: parallel page agents reach here at once.
	try {
		fs.writeFileSync( path.join( base, '.gitignore' ), '*\n', { flag: 'wx' } );
	} catch ( error ) {
		if ( 'EEXIST' !== error.code ) {
			throw error;
		}
	}
}

/**
 * Where a page and breakpoint's Figma files and dated runs live:
 * <runs-root>/<project>/<page-slug>/<width>. The root is localRunsRoot() unless given, so every
 * agent and session in a project shares one history, whatever plugin data it has.
 *
 * @param {string} url     Page URL.
 * @param {number} width   Breakpoint width.
 * @param {Object} options { runsRoot, project } overrides.
 * @return {string} Directory path.
 */
export function runsDir( url, width, options = {} ) {
	// An unsubstituted "${CLAUDE_PLUGIN_DATA}" from an older command line means no root was given.
	const given = options.runsRoot && ! options.runsRoot.includes( '${' ) ? options.runsRoot : null;
	const root = given || localRunsRoot();
	const project = options.project || path.basename( process.env.CLAUDE_PROJECT_DIR || projectRoot( process.cwd() ) );
	const page = new URL( url ).pathname.replace( /^\/|\/$/g, '' ).replace( /[^a-z0-9]+/gi, '-' ) || 'home';
	return path.join( root, project, page, String( width ) );
}

if ( isMain( import.meta.url ) ) {
	const [ command, ...rest ] = process.argv.slice( 2 );
	if ( 'setup' === command ) {
		const pkgDir = installDeps();
		execFileSync( process.execPath, [ path.join( pkgDir, 'node_modules', 'playwright', 'cli.js' ), 'install', 'chromium' ], { stdio: 'inherit' } );
		process.exit( 0 );
	}
	if ( 'runs-dir' === command && rest.length >= 2 ) {
		const dir = runsDir( rest[ 0 ], rest[ 1 ], { runsRoot: rest[ 2 ] } );
		fs.mkdirSync( dir, { recursive: true } );
		keepRunsLocal( dir );
		process.stdout.write( `${ dir }\n` );
		process.exit( 0 );
	}
	const nodeId = rest[ 0 ];
	if ( 'figma-boxes' !== command || ! nodeId ) {
		console.error( 'Usage: node config.js figma-boxes <frame-id> [--section] | node config.js runs-dir <page-url> <width> | node config.js setup' );
		process.exit( 2 );
	}
	process.stdout.write( figmaScript( nodeId, { ignore: loadConfig().figmaIgnore, section: rest.includes( '--section' ) } ) );
}
