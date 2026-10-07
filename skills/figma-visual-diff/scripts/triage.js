/**
 * Triage: run the wireframe and pixel diffs and list every defect, per section, with who
 * fixes it (see lib/defects.js for the kinds).
 *
 * The wireframe diff says whether the right elements exist in the right places with the
 * right copy; the pixel diff sees colour, theme, typography and image content.
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
 * <out>/triage.json (shaped by triage.schema.json: every defect per section, and metrics),
 * <out>/report.html (for reviewing Jev's diagnoses against the defects and overlays),
 * appends the metrics to <runs-dir>/metrics.jsonl, keeps each diff's full output under
 * <out>/wireframe and <out>/pixel,
 * and prints what changed since the previous run in the same folder. --keep N deletes all
 * but the newest N runs there (default: keep every run).
 * When the Jev provider's key is set (OPENCODE_API_KEY for the default, OpenCode Zen), Jev
 * judges which defects a reviewer would ask to fix and whether they'd accept each module
 * (see lib/jev.js); --no-jev skips it, --jev-model
 * picks another model.
 * Exits 0 when every section is ok or dynamic.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { keepRunsLocal, loadConfig, runsDir } from './config.js';
import { loadDeps } from './deps.js';
import { fetchFigmaFrame } from './figma-rest.js';
import { isMain, parseFlags } from './lib/cli.js';
import { sectionDefects, structureDefects, verdictOf } from './lib/defects.js';
import { diagnose, jevEndpoint } from './lib/jev.js';
import { appendHistory, buildMetrics, metricsDelta } from './lib/metrics.js';
import { renderReport } from './lib/report-html.js';

const run = promisify( execFile );
const here = path.dirname( fileURLToPath( import.meta.url ) );

export const DEFAULTS = {
	wireframeThreshold: 0.85,
	// Calibrated on a built page: well-built sections score 75–88% (font rendering), real visual differences ≤ 55%.
	pixelThreshold: 0.7,
	alignmentShift: 40,
	tolerance: 8,
	// Non-text boxes (inputs, buttons) are sized exactly; a text box follows the font's metrics.
	sizeTolerance: 3,
	heightTolerance: 16,
	viewportHeight: 900,
};

/**
 * Parse triage's arguments and decide where this run and its Figma inputs live.
 *
 * @param {string[]} argv Arguments after the script path.
 * @return {Object} Parsed arguments, with out, runsDir and the Figma file paths resolved.
 * @throws {Error} When --url or --width is missing, or no Figma input is available.
 */
export function parseArgs( argv ) {
	const args = parseFlags( argv, { defaults: DEFAULTS, flags: [ 'refreshFigma', 'section', 'noJev' ], required: [ 'url', 'width' ] } );
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
	keepRunsLocal( args.figmaDir );
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

/** Defects printed per section; triage.json lists them all. */
const CONSOLE_DEFECTS = 6;

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
/**
 * What this run compared against: the Figma boxes file by content, its section names, and
 * the node id when known. A page folder holds runs against every variant and state of a
 * design, so a run is only comparable with one that had the same inputs.
 *
 * @param {Object} args Parsed arguments, with figma (the stored boxes file) and its source.
 * @return {{hash: string, sections: string[], nodeId?: string}}
 */
export function figmaIdentity( args ) {
	const text = fs.readFileSync( args.figma, 'utf8' );
	// The MCP route names the temp file for its frame (SKILL.md): figma-boxes-<node-id>.txt.
	const fromFile = /figma-boxes-(\d+)-(\d+)/.exec( path.basename( args.figmaSource || '' ) );
	const nodeId = args.nodeId?.replace( '-', ':' ) ?? ( fromFile ? `${ fromFile[ 1 ] }:${ fromFile[ 2 ] }` : undefined );
	return {
		hash: crypto.createHash( 'sha1' ).update( text ).digest( 'hex' ).slice( 0, 12 ),
		sections: text.split( '\n' ).filter( ( l ) => l.startsWith( 'S|' ) ).map( ( l ) => l.split( '|' )[ 2 ] ),
		...( nodeId ? { nodeId } : {} ),
	};
}

/**
 * The newest earlier run to compare this one with: the same URL and the same Figma inputs,
 * that compared at least one section. Runs from before inputs were recorded match on the URL.
 *
 * @param {string} runsDir Page/breakpoint runs folder.
 * @param {string} current This run's folder.
 * @param {Object} inputs  { url, figma: figmaIdentity() }.
 * @return {{dir: string, triage: Object}|null} The run and its triage.json.
 */
export function previousRun( runsDir, current, { url, figma } ) {
	if ( ! runsDir || ! fs.existsSync( runsDir ) ) {
		return null;
	}
	const earlier = fs.readdirSync( runsDir )
		.filter( ( d ) => RUN_DIR.test( d ) && d < path.basename( current ) )
		.sort()
		.reverse();
	for ( const d of earlier ) {
		let triage;
		try {
			triage = JSON.parse( fs.readFileSync( path.join( runsDir, d, 'triage.json' ), 'utf8' ) );
		} catch {
			continue;
		}
		// The same boxes from another node (a duplicated frame) is another design to track; a run
		// that knew no node id only matches one that didn't either.
		const sameNode = triage.figma?.nodeId === figma.nodeId;
		if ( triage.url === url && triage.sections?.length && ( ! triage.figma || ( triage.figma.hash === figma.hash && sameNode ) ) ) {
			return { dir: path.join( runsDir, d ), triage };
		}
	}
	return null;
}

/** Sections whose content sits this much further across than in the run before moved with the capture, not the build. */
const X_ORIGIN_JUMP = 8;

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

const SCHEMA = path.join( here, '..', 'triage.schema.json' );

/**
 * Throw unless a report matches triage.schema.json: the shape the skill and developers rely on.
 *
 * @param {Object} report triage.json content.
 * @throws {Error} Listing the first mismatches.
 */
export async function validateReport( report ) {
	const { Ajv } = await loadDeps();
	const validate = new Ajv( { allErrors: true } ).compile( JSON.parse( fs.readFileSync( SCHEMA, 'utf8' ) ) );
	if ( ! validate( report ) ) {
		const errors = validate.errors.slice( 0, 5 ).map( ( e ) => `${ e.instancePath || '/' } ${ e.message }` ).join( '; ' );
		throw new Error( `triage.json doesn't match triage.schema.json: ${ errors }` );
	}
}

/**
 * One section's triage entry: its defects, numbered <index>.<n>, and its verdict.
 *
 * @param {Object}      w    Wireframe report section.
 * @param {Object|null} p    Pixel report section, if compared.
 * @param {Object}      args Parsed arguments (thresholds).
 * @return {Object} Section entry.
 */
export function triageSection( w, p, args ) {
	const defects = sectionDefects( w, p, args ).map( ( d, n ) => ( { id: `${ w.index }.${ n + 1 }`, ...d } ) );
	return {
		index: w.index,
		slug: w.slug,
		figma: w.figma,
		verdict: verdictOf( w, defects ),
		live: Boolean( w.live ),
		wireframeScore: w.score,
		pixelScore: p?.score,
		pixelHeight: p?.height,
		pixelRows: p?.rows,
		figmaY: w.figmaY,
		figmaHeight: w.figmaHeight,
		pageHeight: w.pageHeight,
		heightDelta: w.heightDelta,
		drift: w.drift,
		defects,
		images: { wireframe: w.image && `wireframe/${ w.image }`, pixel: p?.image && `pixel/${ p.image }` },
	};
}

/**
 * Find a wireframe section's pixel result by the section's top y in the Figma frame. Section
 * numbers can disagree between the two reports, because the pixel diff leaves out overlays.
 *
 * @param {Array} pixelSections Pixel report sections.
 * @return {function(Object): (Object|undefined)} Lookup for a wireframe section.
 */
export function sameSection( pixelSections ) {
	const byY = new Map( pixelSections.map( ( s ) => [ s.figmaY, s ] ) );
	return ( w ) => byY.get( w.figmaY );
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
		const pixelOf = sameSection( pixel.sections );
		let total = 0;
		let drift = 0;
		for ( const s of wireframe.sections ) {
			const p = pixelOf( s );
			if ( p ) {
				total += s.pageHeight;
				drift += Math.abs( s.pageHeight - p.pageHeight );
			}
		}
		return total ? drift / total : 0;
	};
	let reports;
	let unstable = false;
	for ( let attempt = 1; attempt <= 2; attempt++ ) {
		// Sequential on purpose: two browsers loading the page at once perturb each other's
		// capture (lazy media, slider timing), which made scores vary between runs.
		await runDiff( 'wireframe-diff.js', [ ...common, '--out', path.join( args.out, 'wireframe' ), '--figma', args.figma, '--threshold', String( args.wireframeThreshold ), '--size-tolerance', String( args.sizeTolerance ) ] );
		// Pixels are lined up at the elements the wireframe diff just matched, never searched for.
		await runDiff( 'pixel-diff.js', [
			...common,
			'--out', path.join( args.out, 'pixel' ),
			'--figma', args.figma,
			'--figma-png', args.figmaPng,
			'--threshold', String( args.pixelThreshold ),
			'--align', path.join( args.out, 'wireframe', 'report.json' ),
		] );
		reports = readReports();
		unstable = renderDrift( reports ) > 0.02;
		if ( ! unstable ) {
			break;
		}
	}
	const { wireframe, pixel } = reports;
	const pixelOf = sameSection( pixel.sections );

	const sections = wireframe.sections.map( ( w ) => triageSection( w, pixelOf( w ), args ) );
	const structure = structureDefects( wireframe.structure ).map( ( d, n ) => ( { id: `S.${ n + 1 }`, ...d } ) );
	const report = {
		warnings: [
			...( wireframe.warnings || [] ),
			...( pixel.warnings || [] ),
			...( unstable ? [ 'The page rendered differently between loads (section heights disagree), even after a retry. Verdicts are unreliable; check the site for failing or late assets.' ] : [] ),
		],
		unstable,
		url: args.url,
		width: Number( args.width ),
		pass: ! unstable && ! structure.length && sections.every( ( s ) => 'ok' === s.verdict || 'dynamic' === s.verdict ),
		figma: figmaIdentity( args ),
		structure,
		sections,
	};
	const previous = previousRun( args.runsDir, args.out, report );
	const before = previous?.triage;
	if ( before ) {
		// The same page and design, captured again: a section whose content now sits further
		// across was measured from another x-origin, and its alignment and spacing defects say so.
		const byIndex = new Map( before.sections.map( ( s ) => [ s.index, s ] ) );
		for ( const s of sections ) {
			const b = byIndex.get( s.index );
			const jump = s.drift && b?.drift && b.slug === s.slug ? Math.abs( s.drift.dx - b.drift.dx ) : 0;
			if ( jump >= X_ORIGIN_JUMP ) {
				report.warnings.push( `Section #${ s.index } ${ s.slug }: its content sits ${ s.drift.dx }px across from Figma, ${ b.drift.dx }px in run ${ path.basename( previous.dir ) } with the same inputs. Either the page's layout changed or the capture's x-origin did; run again before fixing its alignment and spacing defects.` );
			}
		}
	}
	const jev = args.noJev ? null : jevEndpoint( loadConfig( args.config ).jev, process.env, args.jevModel );
	if ( jev?.key ) {
		report.warnings.push( ...await diagnose( report, jev ) );
	}
	report.metrics = buildMetrics( report, wireframe, pixel );
	if ( before ) {
		const byIndex = new Map( before.sections.map( ( s ) => [ s.index, s ] ) );
		report.previous = path.basename( previous.dir );
		report.changes = sections
			.map( ( s ) => ( { index: s.index, slug: s.slug, before: byIndex.get( s.index )?.verdict, after: s.verdict } ) )
			.filter( ( c ) => c.before !== c.after );
		// Runs from before metrics existed have none to compare with.
		if ( before.metrics ) {
			report.metricsDelta = metricsDelta( report.metrics, before.metrics );
		}
	}
	await validateReport( report );
	fs.writeFileSync( path.join( args.out, 'triage.json' ), JSON.stringify( report, null, '\t' ) );
	fs.writeFileSync( path.join( args.out, 'report.html' ), renderReport( report, path.basename( args.out ), args.out ) );
	// A run that compared nothing (no section paired) has no scores worth a place in the history.
	if ( args.runsDir && sections.length ) {
		appendHistory( args.runsDir, path.basename( args.out ), report );
	}
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

	const m = report.metrics;
	const pc = ( n ) => `${ ( n * 100 ).toFixed( 1 ) }%`;
	console.log( `${ report.pass ? 'PASS' : 'FAIL' } ${ report.width }px  correctness ${ pc( m.correctness ) } (${ m.sections.ok }/${ m.sections.figma - m.sections.dynamic } sections ok)  wireframe ${ pc( m.scores.wireframe ) }  pixels ${ pc( m.scores.pixel ) }` );
	if ( m.diagnosis ) {
		console.log( `  jev ${ m.diagnosis.model }: expected correctness ${ pc( m.diagnosis.expectedCorrectness ) }, ${ m.diagnosis.signedOff } signed off, ${ m.diagnosis.needsReview } to review, ${ m.diagnosis.rejected } rejected; ${ m.diagnosis.expectedFixes } fixes expected, ${ m.diagnosis.negligible } defects negligible` );
	} else if ( jev && ! jev.key ) {
		console.log( `  jev: set ${ jev.keyEnv } to diagnose each module (provider ${ jev.url })` );
	}
	console.log( `  defects ${ m.defects.total }: page ${ m.defects.byOwner.page }, developer ${ m.defects.byOwner.developer }, page-or-developer ${ m.defects.byOwner[ 'page-or-developer' ] }` );
	for ( const w of report.warnings ) {
		console.log( `  warning: ${ w }` );
	}
	for ( const d of structure ) {
		console.log( `  structure  ${ d.id } ${ d.summary }` );
	}
	for ( const s of sections ) {
		const scores = undefined === s.pixelScore ? '' : `  wire ${ ( s.wireframeScore * 100 ).toFixed( 0 ) }% px ${ ( s.pixelScore * 100 ).toFixed( 0 ) }%`;
		console.log( `  ${ s.verdict.padEnd( 10 ) } #${ String( s.index ).padStart( 2 ) } ${ s.slug.padEnd( 28 ) }${ scores }` );
		// With Jev, the defects a reviewer would most likely ask to fix come first.
		const defects = s.diagnosis ? [ ...s.defects ].sort( ( a, b ) => b.matters - a.matters ) : s.defects;
		if ( s.diagnosis ) {
			const fixes = s.defects.filter( ( d ) => d.matters >= 0.5 ).length;
			console.log( `      jev    accept ${ ( s.diagnosis.correct * 100 ).toFixed( 0 ) }%  ${ fixes } of ${ s.defects.length } defects worth fixing` );
		}
		for ( const d of defects.slice( 0, CONSOLE_DEFECTS ) ) {
			const matters = undefined === d.matters ? '' : `${ String( Math.round( d.matters * 100 ) ).padStart( 3 ) }%  `;
			console.log( `      ${ d.id.padEnd( 6 ) } ${ d.kind.padEnd( 10 ) } ${ matters }${ d.summary }` );
		}
		if ( s.defects.length > CONSOLE_DEFECTS ) {
			console.log( `      … ${ s.defects.length - CONSOLE_DEFECTS } more in triage.json` );
		}
	}
	const pruned = args.runsDir && args.keep ? pruneRuns( args.runsDir, Number( args.keep ) ) : [];
	if ( pruned.length ) {
		console.log( `  pruned ${ pruned.length } older run(s), keeping the newest ${ args.keep }` );
	}
	if ( ! sections.length ) {
		console.log( '  nothing compared (no section paired): not added to metrics.jsonl' );
	}
	if ( ! report.previous && args.runsDir ) {
		console.log( `  first run of ${ report.figma.nodeId ? `Figma node ${ report.figma.nodeId }` : 'these Figma inputs' } against this URL: nothing to compare with` );
	}
	if ( report.previous ) {
		const changes = report.changes.map( ( c ) => `#${ c.index } ${ c.slug } ${ c.before || 'new' } → ${ c.after }` ).join( ', ' );
		console.log( `  since ${ report.previous }: ${ changes || 'no verdict changes' }` );
		const d = report.metricsDelta;
		if ( d ) {
			const s = ( n, unit = '' ) => `${ n > 0 ? '+' : '' }${ n }${ unit }`;
			console.log( `  metrics since ${ report.previous }: correctness ${ s( Number( ( d.correctness * 100 ).toFixed( 1 ) ), 'pt' ) }, defects ${ s( d.defects ) } (page ${ s( d.pageDefects ) }, developer ${ s( d.developerDefects ) }), wireframe ${ s( Number( ( d.wireframe * 100 ).toFixed( 1 ) ), 'pt' ) }, pixels ${ s( Number( ( d.pixel * 100 ).toFixed( 1 ) ), 'pt' ) }${ undefined === d.expectedCorrectness ? '' : `, jev expected correctness ${ s( Number( ( d.expectedCorrectness * 100 ).toFixed( 1 ) ), 'pt' ) }` }` );
		}
	}
	console.log( `  triage: ${ path.join( args.out, 'triage.json' ) }` );
	console.log( `  review: ${ path.join( args.out, 'report.html' ) }` );
	process.exitCode = report.pass ? 0 : 1;
}

if ( isMain( import.meta.url ) ) {
	main().catch( ( error ) => {
		console.error( error.message );
		process.exitCode = 2;
	} );
}
