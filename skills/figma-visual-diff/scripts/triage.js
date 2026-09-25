/**
 * Triage: run the wireframe and pixel diffs and sort each section by what fixes it.
 *
 * The wireframe diff says whether the right elements exist in the right places with the
 * right copy; the pixel diff sees colour, theme, typography and image content. Together:
 *
 *   structure  sections missing, extra or out of order          → page: add/remove/reorder blocks
 *   content    elements missing or copy differs                  → page: fix blocks and copy
 *   alignment  everything present, consistently shifted sideways → page: align attribute
 *   layout     everything present, sizes or spacing differ       → developer: block CSS
 *   visual     geometry matches, pixels don't                    → page: theme/fontSize, else developer
 *   ok / dynamic
 *
 * Usage:
 *   node triage.js --url <page-url> --width <1440|375> [--out <dir>] \
 *     --figma <figma-boxes.txt> ( --figma-png <frame.png> | --figma-png-url <url> ) [--viewport-height 900]
 *
 * The Figma inputs can come from anywhere (a temp file is fine); they are stored in the runs
 * folder, so later runs for the same page and width can leave --figma/--figma-png out.
 * --figma-png-url downloads the render (e.g. the URL get_screenshot returns) instead.
 *
 * --out defaults to <runs-dir>/<timestamp> (see runsDir() in config.js; override with
 * --runs-root / --project), so every iteration is kept; <runs-dir>/latest is the newest. Writes
 * <out>/triage.json, with each diff's full output under <out>/wireframe and <out>/pixel,
 * and prints what changed since the previous run in the same folder. --keep N deletes all
 * but the newest N runs there (default: keep every run).
 * Exits 0 when every section is ok or dynamic.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runsDir } from './config.js';
import { fetchFigmaFrame } from './figma-rest.js';

const run = promisify( execFile );
const here = path.dirname( fileURLToPath( import.meta.url ) );

export const DEFAULTS = {
	wireframeThreshold: 0.85,
	// Calibrated on a built page: well-built sections score 75–88% (font rendering), real visual differences ≤ 55%.
	pixelThreshold: 0.7,
	alignmentShift: 40,
	tolerance: 8,
	heightTolerance: 24,
	viewportHeight: 900,
};

const ACTIONS = {
	structure: 'page: add, remove or reorder blocks to match Figma',
	content: 'page: add the missing elements and fix the copy',
	alignment: 'page: set the block or element alignment',
	layout: 'developer: block CSS (sizes/spacing) — not fixable in page content',
	visual: 'page: check theme, colour and text-size settings; if they are right, developer: styling',
	dynamic: 'none: live content, only presence is checked',
	ok: 'none',
};

const FLAGS = new Set( [ 'refreshFigma', 'section' ] );

export function parseArgs( argv ) {
	const args = { ...DEFAULTS };
	for ( let i = 0; i < argv.length; i++ ) {
		const key = argv[ i ].replace( /^--/, '' ).replace( /-([a-z])/g, ( m, c ) => c.toUpperCase() );
		args[ key ] = FLAGS.has( key ) ? true : argv[ ++i ];
	}
	for ( const required of [ 'url', 'width' ] ) {
		if ( ! args[ required ] ) {
			throw new Error( `Missing --${ required }` );
		}
	}
	if ( ! args.out ) {
		const now = new Date();
		const pad = ( n ) => String( n ).padStart( 2, '0' );
		const stamp = `${ now.getFullYear() }-${ pad( now.getMonth() + 1 ) }-${ pad( now.getDate() ) }_${ pad( now.getHours() ) }${ pad( now.getMinutes() ) }${ pad( now.getSeconds() ) }`;
		args.runsDir = runsDir( args.url, args.width, { runsRoot: args.runsRoot, project: args.project } );
		args.out = path.join( args.runsDir, stamp );
	}
	// Figma inputs live next to the runs: from the MCP workflow (--figma, --figma-png or
	// --figma-png-url, stored there by importFigma), fetched with FIGMA_TOKEN (--file-key and
	// --node-id), or left there by an earlier run.
	args.figmaDir = args.runsDir || path.dirname( args.out );
	args.figmaSource = args.figma;
	args.figmaPngSource = args.figmaPng;
	args.figma = path.join( args.figmaDir, 'figma-boxes.txt' );
	args.figmaPng = path.join( args.figmaDir, 'figma.png' );
	const fetching = args.fileKey && args.nodeId;
	const missing = [
		! args.figmaSource && ! fs.existsSync( args.figma ) && '--figma',
		! args.figmaPngSource && ! args.figmaPngUrl && ! fs.existsSync( args.figmaPng ) && '--figma-png (or --figma-png-url)',
	].filter( Boolean );
	if ( missing.length && ! fetching ) {
		throw new Error( `Missing ${ missing.join( ' and ' ) }: no stored Figma data in ${ args.figmaDir } (or pass --file-key and --node-id with FIGMA_TOKEN set)` );
	}
	return args;
}

/**
 * Store the Figma inputs in the runs folder: copy --figma/--figma-png from wherever they
 * were written, or download --figma-png-url.
 *
 * @param {Object}   args     Parsed arguments.
 * @param {Function} download fetch-compatible function (injectable for tests).
 */
export async function importFigma( args, download = fetch ) {
	fs.mkdirSync( args.figmaDir, { recursive: true } );
	for ( const [ from, to ] of [ [ args.figmaSource, args.figma ], [ args.figmaPngSource, args.figmaPng ] ] ) {
		if ( from && path.resolve( from ) !== path.resolve( to ) ) {
			fs.copyFileSync( from, to );
		}
	}
	if ( args.figmaPngUrl ) {
		const response = await download( args.figmaPngUrl );
		if ( ! response.ok ) {
			throw new Error( `Couldn't download the Figma render (${ response.status }); take a new screenshot, its URL is short-lived.` );
		}
		fs.writeFileSync( args.figmaPng, Buffer.from( await response.arrayBuffer() ) );
	}
}

const RUN_DIR = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

/**
 * Delete all but the newest `keep` dated runs in a folder. Figma inputs and anything
 * that isn't a dated run folder are left alone.
 *
 * @param {string} dir  Page/breakpoint runs folder.
 * @param {number} keep Runs to keep (the newest).
 * @return {string[]} Names of the deleted runs.
 */
export function pruneRuns( dir, keep ) {
	if ( ! ( keep > 0 ) || ! fs.existsSync( dir ) ) {
		return [];
	}
	const runs = fs.readdirSync( dir ).filter( ( d ) => RUN_DIR.test( d ) ).sort();
	const doomed = runs.slice( 0, Math.max( 0, runs.length - keep ) );
	for ( const d of doomed ) {
		fs.rmSync( path.join( dir, d ), { recursive: true, force: true } );
	}
	return doomed;
}

/** The most recent earlier run in the same folder, if any. */
function previousRun( runsDir, current ) {
	if ( ! runsDir || ! fs.existsSync( runsDir ) ) {
		return null;
	}
	const earlier = fs.readdirSync( runsDir )
		.filter( ( d ) => RUN_DIR.test( d ) && d < path.basename( current ) && fs.existsSync( path.join( runsDir, d, 'triage.json' ) ) )
		.sort();
	return earlier.length ? path.join( runsDir, earlier[ earlier.length - 1 ] ) : null;
}

async function runDiff( script, argv ) {
	try {
		await run( process.execPath, [ path.join( here, script ), ...argv ], { maxBuffer: 16 * 1024 * 1024 } );
	} catch ( error ) {
		// Exit 1 is a failing comparison, which still writes a report.
		if ( 1 !== error.code ) {
			throw new Error( `${ script } failed: ${ error.stderr || error.message }` );
		}
	}
}

const SEVERITY = [ 'content', 'alignment', 'layout', 'visual' ];
const sign = ( n ) => `${ n > 0 ? '+' : '' }${ n }px`;

/**
 * Every independent problem in a section, most severe first. One section can be short of
 * logos and have a misaligned heading at once; each needs its own fix.
 */
export function classify( w, p, args ) {
	if ( 'masked' === w.status ) {
		return [ { kind: 'dynamic', why: 'masked: only presence checked' } ];
	}
	w = { missing: [], extra: [], copy: [], shifted: [], offsets: [], drift: { dx: 0, dy: 0, resized: 0 }, heightDelta: 0, ...w };
	const findings = [];
	// Live sections (post feeds) show real titles, so their text boxes can't be expected to match.
	const missing = w.live ? w.missing.filter( ( m ) => ! m.startsWith( 'text ' ) ) : w.missing;
	if ( missing.length ) {
		findings.push( { kind: 'content', why: `${ missing.length } element(s) missing: ${ missing.slice( 0, 3 ).join( '; ' ) }${ missing.length > 3 ? '; …' : '' }` } );
	}
	// Elements Figma doesn't have (e.g. a 4th card where the design shows 3).
	const extra = w.live ? w.extra.filter( ( m ) => ! m.startsWith( 'text ' ) ) : w.extra;
	if ( extra.length ) {
		findings.push( { kind: 'content', why: `${ extra.length } extra element(s) not in Figma: ${ extra.slice( 0, 3 ).join( '; ' ) }${ extra.length > 3 ? '; …' : '' }` } );
	}
	if ( w.copy.length ) {
		findings.push( { kind: 'content', why: `${ w.copy.length } copy mismatch(es): ${ w.copy.slice( 0, 2 ).map( ( c ) => `"${ c.figma }" → "${ c.page }"` ).join( '; ' ) }` } );
	}
	const { dx, dy, resized } = w.drift;
	if ( w.shifted?.length ) {
		findings.push( { kind: 'alignment', why: w.shifted.map( ( e ) => `${ e.element } shifted ${ sign( e.dx ) }` ).join( '; ' ) } );
	} else if ( Math.abs( dx ) >= args.alignmentShift && Math.abs( dx ) > Math.abs( dy ) ) {
		findings.push( { kind: 'alignment', why: `section content shifted ${ sign( dx ) } horizontally` } );
	}
	if ( 'fail' === w.status && ( resized || Math.abs( dy ) > args.tolerance || Math.abs( w.heightDelta ) > args.heightTolerance ) || Math.abs( w.heightDelta ) > args.heightTolerance ) {
		const worst = w.offsets.find( ( o ) => ! w.shifted?.some( ( e ) => e.element === o.element ) );
		const detail = worst ? `; largest: ${ worst.element } moved ${ sign( worst.dx ) }/${ sign( worst.dy ) }, resized ${ sign( worst.dw ) }/${ sign( worst.dh ) }` : '';
		findings.push( { kind: 'layout', why: `${ resized } element(s) resized, median drift ${ sign( dy ) } vertically, height ${ sign( w.heightDelta ) }${ detail }` } );
	}
	// Padding is its own finding: the most common spacing fix, and it names the side to change.
	const padDelta = w.padding?.delta ? Object.entries( w.padding.delta ).filter( ( [ , d ] ) => Math.abs( d ) > args.tolerance ) : [];
	if ( padDelta.length ) {
		const sides = padDelta.map( ( [ side, d ] ) => `${ side } ${ w.padding.figma[ side ] } → ${ w.padding.page[ side ] } (${ sign( d ) })` ).join( ', ' );
		findings.push( { kind: 'layout', why: `padding differs from Figma: ${ sides }` } );
	}
		// Pixels only add information once geometry agrees; otherwise they re-report the layout.
	if ( ! findings.some( ( f ) => 'layout' === f.kind ) && p && undefined !== p.score && p.score < args.pixelThreshold ) {
		findings.push( { kind: 'visual', why: `geometry matches, pixels ${ ( p.score * 100 ).toFixed( 1 ) }%` } );
	}
	// A failing wireframe score must never read as ok, even when no single rule explains it.
	if ( ! findings.length && 'fail' === w.status ) {
		findings.push( { kind: 'layout', why: `boxes overlap Figma's by ${ ( ( w.score ?? 0 ) * 100 ).toFixed( 1 ) }%, below the threshold, without one dominant offset` } );
	}
	findings.sort( ( a, b ) => SEVERITY.indexOf( a.kind ) - SEVERITY.indexOf( b.kind ) );
	return findings.length ? findings : [ { kind: 'ok', why: '' } ];
}

async function main() {
	const args = parseArgs( process.argv.slice( 2 ) );
	await importFigma( args );
	if ( args.fileKey && args.nodeId && ( args.refreshFigma || ! fs.existsSync( args.figma ) || ! fs.existsSync( args.figmaPng ) ) ) {
		await fetchFigmaFrame( { fileKey: args.fileKey, nodeId: args.nodeId, out: args.figmaDir, section: Boolean( args.section ) } );
		console.log( `  fetched Figma frame ${ args.nodeId } from the REST API` );
	}
	fs.mkdirSync( args.out, { recursive: true } );
	const common = [ '--url', args.url, '--width', String( args.width ), '--viewport-height', String( args.viewportHeight ) ];
	if ( args.config ) {
		common.push( '--config', args.config );
	}
	const readReports = () => ( {
		wireframe: JSON.parse( fs.readFileSync( path.join( args.out, 'wireframe', 'report.json' ), 'utf8' ) ),
		pixel: JSON.parse( fs.readFileSync( path.join( args.out, 'pixel', 'report.json' ), 'utf8' ) ),
	} );
	// The two diffs load the page separately; if their section heights disagree, one of
	// the loads rendered differently and its verdicts can't be trusted.
	const renderDrift = ( { wireframe, pixel } ) => {
		const pixelHeights = new Map( pixel.sections.map( ( s ) => [ s.index, s.pageHeight ] ) );
		let total = 0;
		let drift = 0;
		for ( const s of wireframe.sections ) {
			if ( pixelHeights.has( s.index ) ) {
				total += s.pageHeight;
				drift += Math.abs( s.pageHeight - pixelHeights.get( s.index ) );
			}
		}
		return total ? drift / total : 0;
	};
	let reports;
	let unstable = false;
	for ( let attempt = 1; attempt <= 2; attempt++ ) {
		// Sequential on purpose: two browsers loading the page at once perturb each other's
		// capture (lazy media, slider timing), which made scores vary between runs.
		await runDiff( 'wireframe-diff.js', [ ...common, '--out', path.join( args.out, 'wireframe' ), '--figma', args.figma, '--threshold', String( args.wireframeThreshold ) ] );
		await runDiff( 'pixel-diff.js', [ ...common, '--out', path.join( args.out, 'pixel' ), '--figma', args.figma, '--figma-png', args.figmaPng, '--threshold', String( args.pixelThreshold ) ] );
		reports = readReports();
		unstable = renderDrift( reports ) > 0.02;
		if ( ! unstable ) {
			break;
		}
	}
	const { wireframe, pixel } = reports;
	const pixelByIndex = new Map( pixel.sections.map( ( s ) => [ s.index, s ] ) );

	const sections = wireframe.sections.map( ( w ) => {
		const p = pixelByIndex.get( w.index );
		const findings = classify( w, p, args ).map( ( f ) => ( { ...f, action: ACTIONS[ f.kind ] } ) );
		return {
			index: w.index,
			slug: w.slug,
			verdict: findings[ 0 ].kind,
			findings,
			wireframeScore: w.score,
			pixelScore: p?.score,
			heightDelta: w.heightDelta,
			missing: w.missing || [],
			extra: w.extra || [],
			copy: w.copy || [],
			images: { wireframe: w.image && `wireframe/${ w.image }`, pixel: p?.image && `pixel/${ p.image }` },
		};
	} );
	const { missing, extra, moved } = wireframe.structure;
	const structure = [
		...missing.map( ( m ) => ( { verdict: 'structure', why: `section #${ m.index } ${ m.slug } missing${ moved.includes( m.slug ) ? ' (moved)' : '' }`, action: ACTIONS.structure } ) ),
		...extra.map( ( e ) => ( { verdict: 'structure', why: `page block #${ e.index } ${ e.slug } not in Figma${ moved.includes( e.slug ) ? ' (moved)' : '' }`, action: ACTIONS.structure } ) ),
	];
	const report = {
		warnings: [
			...( wireframe.warnings || [] ),
			...( unstable ? [ 'The page rendered differently between loads (section heights disagree), even after a retry. Verdicts are unreliable; check the site for failing or late assets.' ] : [] ),
		],
		unstable,
		url: args.url,
		width: Number( args.width ),
		pass: ! unstable && ! structure.length && sections.every( ( s ) => 'ok' === s.verdict || 'dynamic' === s.verdict ),
		structure,
		sections,
	};
	const previous = previousRun( args.runsDir, args.out );
	if ( previous ) {
		const before = JSON.parse( fs.readFileSync( path.join( previous, 'triage.json' ), 'utf8' ) );
		const byIndex = new Map( before.sections.map( ( s ) => [ s.index, s ] ) );
		report.previous = path.basename( previous );
		report.changes = sections
			.map( ( s ) => ( { index: s.index, slug: s.slug, before: byIndex.get( s.index )?.verdict, after: s.verdict } ) )
			.filter( ( c ) => c.before !== c.after );
	}
	fs.writeFileSync( path.join( args.out, 'triage.json' ), JSON.stringify( report, null, '\t' ) );
	if ( args.runsDir ) {
		const latest = path.join( args.runsDir, 'latest' );
		try {
			try {
				fs.unlinkSync( latest );
			} catch ( error ) {
				if ( 'ENOENT' !== error.code ) {
					throw error;
				}
			}
			fs.symlinkSync( path.basename( args.out ), latest );
		} catch {
			// Symlinks can be unavailable (e.g. some Windows setups); the dated folder is what matters.
		}
	}

	console.log( `${ report.pass ? 'PASS' : 'FAIL' } ${ report.width }px` );
	for ( const w of report.warnings ) {
		console.log( `  warning: ${ w }` );
	}
	for ( const s of structure ) {
		console.log( `  structure  ${ s.why }` );
	}
	for ( const s of sections ) {
		const scores = undefined === s.pixelScore ? '' : `  wire ${ ( s.wireframeScore * 100 ).toFixed( 0 ) }% px ${ ( s.pixelScore * 100 ).toFixed( 0 ) }%`;
		console.log( `  ${ s.verdict.padEnd( 10 ) } #${ String( s.index ).padStart( 2 ) } ${ s.slug.padEnd( 28 ) }${ scores }` );
		for ( const f of s.findings ) {
			if ( f.why ) {
				console.log( `      ${ f.kind.padEnd( 10 ) } ${ f.why }` );
			}
		}
	}
	const pruned = args.runsDir && args.keep ? pruneRuns( args.runsDir, Number( args.keep ) ) : [];
	if ( pruned.length ) {
		console.log( `  pruned ${ pruned.length } older run(s), keeping the newest ${ args.keep }` );
	}
	if ( report.previous ) {
		console.log( `  since ${ report.previous }: ${ report.changes.length ? report.changes.map( ( c ) => `#${ c.index } ${ c.slug } ${ c.before || 'new' } → ${ c.after }` ).join( ', ' ) : 'no verdict changes' }` );
	}
	console.log( `  triage: ${ path.join( args.out, 'triage.json' ) }` );
	process.exitCode = report.pass ? 0 : 1;
}

if ( process.argv[ 1 ] === fileURLToPath( import.meta.url ) ) {
	main().catch( ( error ) => {
		console.error( error.message );
		process.exitCode = 2;
	} );
}
