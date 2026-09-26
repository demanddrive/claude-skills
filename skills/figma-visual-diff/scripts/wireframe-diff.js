/**
 * Wireframe diff: compare a built page against its Figma frame as boxes, not pixels.
 *
 * Both sides reduce to typed leaf boxes (text, image, icon, surface) per top-level section.
 * Boxes are paired by type, text and position, so the report names what is missing, extra,
 * moved or reworded instead of counting differing pixels.
 *
 * Usage:
 *   node wireframe-diff.js --url <page-url> --width <1440|375> --out <dir> --figma <figma-boxes.txt>
 *
 * figma-boxes.txt comes from the Figma extractor (see lib/figma.js).
 * Writes <out>/report.json and <out>/<n>-<slug>.png (Figma red, page blue) per section;
 * exits 1 when structure fails or a compared section is below threshold.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadDeps } from './deps.js';
import { loadConfig } from './config.js';
import { analyseSection, paddingOf, pairStructure, uniqueBoxes } from './lib/boxes.js';
import { withLoadedPage } from './lib/browser.js';
import { isMain, listOption, parseFlags, pct, sectionImage, signedPx } from './lib/cli.js';
import { hash, normText, parseFigma, TEXT_PREFIX } from './lib/figma.js';
import { measureTwice } from './lib/page.js';
import { drawBox, tint } from './lib/png.js';

const { PNG } = await loadDeps();

const DEFAULTS = {
	threshold: 0.85,
	tolerance: 8,
	viewportHeight: 900,
};

const COLORS = { figma: [ 230, 40, 40 ], page: [ 30, 90, 230 ] };

function parseArgs( argv ) {
	const args = parseFlags( argv, {
		defaults: DEFAULTS,
		numbers: [ 'width', 'threshold', 'tolerance', 'viewportHeight' ],
		required: [ 'url', 'width', 'out', 'figma' ],
	} );
	// --mask/--live override the project config; sections whose copy comes from live posts
	// are compared on geometry only.
	args.config = loadConfig( args.config );
	args.mask = args.mask ?? args.config.mask.join( ',' );
	args.live = args.live ?? args.config.live.join( ',' );
	return args;
}

/**
 * The page's sections as boxes, with each text box's copy normalised and hashed like Figma's.
 *
 * @param {Object} args Parsed arguments.
 * @return {Promise<Array>} Page sections.
 */
async function capturePage( args ) {
	const sections = await withLoadedPage( args, ( page ) => measureTwice( page, args.config ) );
	for ( const s of sections ) {
		s.boxes = uniqueBoxes( s.boxes );
		for ( const b of s.boxes ) {
			if ( undefined !== b.text ) {
				b.full = normText( b.text );
				b.hash = hash( b.full );
				b.text = b.full.slice( 0, TEXT_PREFIX );
			}
		}
	}
	return sections;
}

/** Shade a section's four padding bands; overlapping Figma and page bands read purple. */
function shadePadding( png, pad, width, height, color ) {
	if ( ! pad ) {
		return;
	}
	tint( png, 0, 0, width, pad.top, color, 0.18 );
	tint( png, 0, height - pad.bottom, width, pad.bottom, color, 0.18 );
	tint( png, 0, pad.top, pad.left, height - pad.top - pad.bottom, color, 0.18 );
	tint( png, width - pad.right, pad.top, pad.right, height - pad.top - pad.bottom, color, 0.18 );
}

/**
 * The section overlay: Figma boxes red, page boxes blue, unmatched ones thick, padding shaded,
 * and each side's section bottom marked.
 *
 * @param {number} width        Breakpoint width.
 * @param {number} height       Image height.
 * @param {Object} match        matchBoxes() result.
 * @param {Object} figmaSection Figma section.
 * @param {Object} pageSection  Page section.
 * @return {PNG}
 */
function renderOverlay( width, height, match, figmaSection, pageSection ) {
	const png = new PNG( { width, height: Math.max( 1, Math.ceil( height ) ) } );
	png.data.fill( 255 );
	shadePadding( png, paddingOf( figmaSection.boxes, width, figmaSection.height ), width, figmaSection.height, COLORS.figma );
	shadePadding( png, paddingOf( pageSection.boxes, width, pageSection.height ), width, pageSection.height, COLORS.page );
	// Each side's section bottom, so a height difference is visible at a glance.
	drawBox( png, { x: 0, y: figmaSection.height - 1, w: width - 1, h: 0 }, COLORS.figma, 2 );
	drawBox( png, { x: 0, y: pageSection.height - 1, w: width - 1, h: 0 }, COLORS.page, 2 );
	for ( const { f, p } of match.pairs ) {
		drawBox( png, f, COLORS.figma, 1 );
		drawBox( png, p, COLORS.page, 1 );
	}
	for ( const f of match.missing ) {
		drawBox( png, f, COLORS.figma, 4 );
	}
	for ( const p of match.extra ) {
		drawBox( png, p, COLORS.page, 4 );
	}
	return png;
}

/**
 * Compare one section pair, write its overlay, and return its report entry.
 *
 * @param {Object} args  Parsed arguments.
 * @param {number} i     Figma section index.
 * @param {Object} fs0   Figma section.
 * @param {Object} ps    Page section.
 * @param {Object} lists { masked, live } slug sets.
 * @return {Object} Report entry.
 */
function compareSectionPair( args, i, fs0, ps, { masked, live } ) {
	const entry = { index: i + 1, slug: fs0.slug, figma: fs0.name, figmaY: fs0.y, figmaHeight: fs0.height, pageHeight: Math.round( ps.height ), heightDelta: Math.round( ps.height - fs0.height ) };
	if ( masked.has( fs0.slug ) ) {
		return { ...entry, status: 'masked', reason: 'dynamic content' };
	}
	const isLive = live.has( fs0.slug );
	const a = analyseSection( fs0, ps, { tolerance: args.tolerance, live: isLive, width: args.width } );
	const file = sectionImage( i, fs0.slug );
	fs.writeFileSync( path.join( args.out, file ), PNG.sync.write( renderOverlay( args.width, Math.max( fs0.height, ps.height ), a.match, fs0, ps ) ) );
	const pass = a.score >= args.threshold && ! a.structural.length && ! a.copy.length && ! a.shifted.length;
	return {
		...entry,
		status: pass ? 'pass' : 'fail',
		live: isLive,
		score: Number( a.score.toFixed( 4 ) ),
		boxes: { figma: fs0.boxes.length, page: ps.boxes.length, matched: a.match.pairs.length },
		missing: a.missing,
		extra: a.extra,
		copy: a.copy,
		shifted: a.shifted,
		drift: a.drift,
		anchors: a.anchors,
		spacing: a.spacing,
		offsets: a.offsets,
		styles: a.styles,
		image: file,
	};
}

function printReport( report, args ) {
	const { missing, extra, moved } = report.structure;
	console.log( `${ report.pass ? 'PASS' : 'FAIL' } ${ args.width }px  mean section score ${ pct( report.pageScore ) }  (threshold ${ pct( args.threshold ) }, tolerance ${ args.tolerance }px)` );
	for ( const w of report.warnings ) {
		console.log( `  warning: ${ w }` );
	}
	for ( const m of missing ) {
		console.log( `  missing section #${ m.index } ${ m.slug }${ moved.includes( m.slug ) ? ' (moved)' : '' }` );
	}
	for ( const e of extra ) {
		console.log( `  extra   page block #${ e.index } ${ e.slug }${ moved.includes( e.slug ) ? ' (moved)' : '' }` );
	}
	for ( const r of report.sections ) {
		if ( 'masked' === r.status ) {
			console.log( `  masked #${ String( r.index ).padStart( 2 ) } ${ r.slug }` );
			continue;
		}
		const boxes = `boxes ${ r.boxes.matched }/${ r.boxes.figma } (+${ r.extra.length } extra)`;
		const copy = r.copy.length ? `  copy×${ r.copy.length }` : '';
		console.log( `  ${ r.status.padEnd( 6 ) } #${ String( r.index ).padStart( 2 ) } ${ r.slug.padEnd( 28 ) } ${ pct( r.score ).padStart( 6 ) }  Δh ${ signedPx( r.heightDelta ) }  ${ boxes }${ copy }` );
	}
	console.log( `  report: ${ path.join( args.out, 'report.json' ) }` );
}

async function main() {
	const args = parseArgs( process.argv.slice( 2 ) );
	fs.mkdirSync( args.out, { recursive: true } );
	const figma = parseFigma( args.figma, args.config );
	for ( const s of figma.sections ) {
		s.boxes = uniqueBoxes( s.boxes );
	}
	const lists = { masked: listOption( args.mask ), live: listOption( args.live ) };
	const page = await capturePage( args );
	// What the page extraction saw, for debugging a comparison; `full` text stays out.
	const pageBoxes = page.map( ( s ) => ( { slug: s.slug, y: Math.round( s.y ), height: Math.round( s.height ), boxes: s.boxes.map( ( { full, ...b } ) => b ) } ) );
	fs.writeFileSync( path.join( args.out, 'page-boxes.json' ), JSON.stringify( pageBoxes, null, '\t' ) );

	const { pairs, byOrder, missing, extra, moved } = pairStructure( figma.sections, page );
	const warnings = byOrder ? [ 'Section names did not match Figma, so sections were paired by position. Set sectionMap or slugPatterns in .figma-visual-diff.json.' ] : [];
	const results = pairs.map( ( [ i, j ] ) => compareSectionPair( args, i, figma.sections[ i ], page[ j ], lists ) );

	const compared = results.filter( ( r ) => undefined !== r.score );
	const report = {
		url: args.url,
		width: args.width,
		threshold: args.threshold,
		pass: ! missing.length && ! extra.length && compared.every( ( r ) => 'pass' === r.status ),
		pageScore: Number( ( compared.reduce( ( s, r ) => s + r.score, 0 ) / ( compared.length || 1 ) ).toFixed( 4 ) ),
		structure: { figmaSections: figma.sections.length, pageSections: page.length, missing, extra, moved, byOrder },
		warnings,
		sections: results,
	};
	fs.writeFileSync( path.join( args.out, 'report.json' ), JSON.stringify( report, null, '\t' ) );
	printReport( report, args );
	process.exitCode = report.pass ? 0 : 1;
}

if ( isMain( import.meta.url ) ) {
	main().catch( ( error ) => {
		console.error( error.stack || error.message );
		process.exitCode = 2;
	} );
}
