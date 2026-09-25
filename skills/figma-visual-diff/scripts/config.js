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
 *     "live": ["post-slider"],               // slugs whose copy comes from live posts
 *     "iconClassPattern": "(^|\\s)icon-"     // icon-font elements
 *   }
 *
 * CLI:
 *   node config.js figma-boxes <frame-id>     extractor code for use_figma, frame and ignore pattern filled in
 *   node config.js runs-dir <page-url> <width> [runs-root]  folder for this page and breakpoint's Figma files and runs
 *   node config.js setup                         install npm dependencies (if missing) and Playwright's Chromium
 */

import { execFileSync } from 'node:child_process';
import { installDeps } from './deps.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = {
	contentRoot: 'main',
	sectionSelector: null,
	slugPatterns: [ '^block-([a-z0-9-]+)$', '^wp-block-acf-([a-z0-9-]+)$', '^wp-block-([a-z0-9-]+)$' ],
	sectionMap: {},
	figmaIgnore: '^(Navigation|Footer|Header|Wireframe Filter)\\b',
	mask: [],
	live: [ 'post-slider' ],
	iconClassPattern: '(^|\\s)icon-',
};

const FILE = '.figma-visual-diff.json';

/**
 * Merge the nearest project config over the defaults.
 *
 * @param {string|undefined} explicit Path passed with --config.
 * @return {Object} Config with `source` set to the file used, if any.
 */
export function loadConfig( explicit ) {
	let file = explicit;
	for ( let dir = process.cwd(); ! file; dir = path.dirname( dir ) ) {
		if ( fs.existsSync( path.join( dir, FILE ) ) ) {
			file = path.join( dir, FILE );
		} else if ( fs.existsSync( path.join( dir, '.git' ) ) || path.dirname( dir ) === dir ) {
			break;
		}
	}
	let project = {};
	if ( file ) {
		try {
			project = JSON.parse( fs.readFileSync( file, 'utf8' ) );
		} catch ( error ) {
			throw new Error( `${ file } is not valid JSON: ${ error.message }` );
		}
	}
	return { ...DEFAULT_CONFIG, ...project, source: file || null };
}

/**
 * Page slug for a Figma top-level layer: "Content Cards (No Bg) / Desktop" → "content-cards",
 * unless the project's sectionMap names it explicitly.
 *
 * @param {string} name   Figma layer name.
 * @param {Object} config Loaded config.
 * @return {string} Section slug.
 */
export function figmaSlug( name, config = DEFAULT_CONFIG ) {
	const base = name.replace( /\s*\/\s*(Desktop|Mobile|Tablet)\s*$/i, '' ).trim();
	const mapped = Object.entries( config.sectionMap || {} ).find( ( [ key ] ) => key.toLowerCase() === base.toLowerCase() );
	if ( mapped ) {
		return mapped[ 1 ];
	}
	return base.replace( /\([^)]*\)/g, '' ).trim().toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' );
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

/**
 * Where a page and breakpoint's Figma files and dated runs live:
 * <runs-root>/<project>/<page-slug>/<width>. The root is the plugin's persistent data
 * directory when installed as a plugin (it survives updates), else runs/ beside the skill.
 *
 * @param {string} url     Page URL.
 * @param {number} width   Breakpoint width.
 * @param {Object} options { runsRoot, project } overrides.
 * @return {string} Directory path.
 */
export function runsDir( url, width, options = {} ) {
	// Outside a plugin install, "${CLAUDE_PLUGIN_DATA}" arrives unsubstituted; ignore it.
	const given = options.runsRoot && ! options.runsRoot.includes( '${' ) ? options.runsRoot : null;
	const root = given
		|| ( process.env.CLAUDE_PLUGIN_DATA && path.join( process.env.CLAUDE_PLUGIN_DATA, 'runs' ) )
		|| path.join( path.dirname( fileURLToPath( import.meta.url ) ), '..', 'runs' );
	const project = options.project || path.basename( process.env.CLAUDE_PROJECT_DIR || projectRoot( process.cwd() ) );
	const page = new URL( url ).pathname.replace( /^\/|\/$/g, '' ).replace( /[^a-z0-9]+/gi, '-' ) || 'home';
	return path.join( root, project, page, String( width ) );
}

/**
 * Runs in the page: the top-level sections, in document order, with their slugs.
 * Serialised into page.evaluate(), so it must stay self-contained.
 *
 * @param {Object} cfg Loaded config.
 * @return {Array<{el: Element, slug: string}>} Sections.
 */
export function detectSections( cfg ) {
	const patterns = ( cfg.slugPatterns || [] ).map( ( p ) => new RegExp( p ) );
	const slugOf = ( el ) => {
		for ( const re of patterns ) {
			for ( const c of el.classList ) {
				const m = re.exec( c );
				if ( m ) {
					return m[ 1 ];
				}
			}
		}
		return null;
	};
	const visible = ( el ) => el.getBoundingClientRect().height > 0;
	const root = document.querySelector( cfg.contentRoot || 'main' ) || document.body;
	let tops;
	if ( cfg.sectionSelector ) {
		tops = [ ...document.querySelectorAll( cfg.sectionSelector ) ];
	} else {
		const all = [ ...root.querySelectorAll( '[class]' ) ].filter( ( el ) => slugOf( el ) && visible( el ) );
		tops = all.filter( ( el ) => ! all.some( ( o ) => o !== el && o.contains( el ) ) );
		if ( ! tops.length ) {
			// No class convention matched: the content area's children are the sections.
			let area = root;
			while ( 1 === area.children.length ) {
				area = area.children[ 0 ];
			}
			tops = [ ...area.children ].filter( ( el ) => ! /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test( el.tagName ) );
		}
	}
	return tops.filter( visible ).map( ( el ) => ( {
		el,
		slug: slugOf( el ) || el.id || [ ...el.classList ][ 0 ] || el.tagName.toLowerCase(),
	} ) );
}

/**
 * Evaluate `fn( detectSections, config )` in the page. Composed as one expression so it
 * works under strict Content-Security-Policy, where injected script tags would not.
 *
 * @param {import('playwright').Page} page   Page.
 * @param {Function}                  fn     Browser function taking (detect, cfg).
 * @param {Object}                    config Loaded config.
 * @return {Promise<*>} Serialisable result.
 */
export function evaluateWithSections( page, fn, config ) {
	return page.evaluate( `(${ fn })(${ detectSections }, ${ JSON.stringify( config ) })` );
}

if ( process.argv[ 1 ] === fileURLToPath( import.meta.url ) ) {
	const [ command, ...rest ] = process.argv.slice( 2 );
	if ( 'setup' === command ) {
		const pkgDir = installDeps();
		execFileSync( process.execPath, [ path.join( pkgDir, 'node_modules', 'playwright', 'cli.js' ), 'install', 'chromium' ], { stdio: 'inherit' } );
		process.exit( 0 );
	}
	if ( 'runs-dir' === command && rest.length >= 2 ) {
		const dir = runsDir( rest[ 0 ], rest[ 1 ], { runsRoot: rest[ 2 ] } );
		fs.mkdirSync( dir, { recursive: true } );
		process.stdout.write( `${ dir }\n` );
		process.exit( 0 );
	}
	const frameId = rest[ 0 ];
	if ( 'figma-boxes' !== command || ! frameId ) {
		console.error( 'Usage: node config.js figma-boxes <frame-id> | node config.js runs-dir <page-url> <width>' );
		process.exit( 2 );
	}
	const config = loadConfig();
	const code = fs.readFileSync( path.join( path.dirname( fileURLToPath( import.meta.url ) ), 'figma-boxes.js' ), 'utf8' )
		.split( '\n' ).filter( ( l ) => ! l.startsWith( '//' ) ).join( '\n' )
		.replace( 'FRAME_ID', frameId.replace( '-', ':' ) )
		.replace( 'FIGMA_IGNORE', config.figmaIgnore.replace( /\\/g, '\\\\' ).replace( /'/g, "\\'" ) );
	process.stdout.write( code );
}
