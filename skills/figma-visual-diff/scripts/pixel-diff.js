/**
 * Pixel diff: compare a built page against its Figma frame, section by section.
 *
 * The visual half of triage (see triage.js): it sees colour, theme, typography and
 * image content, which the wireframe diff ignores, but cannot say what is wrong.
 *
 * Usage:
 *   node pixel-diff.js --url <page-url> --width <1440|375> --out <dir> \
 *     --figma <figma-boxes.txt> --figma-png <frame.png> [--align <wireframe report.json>]
 *
 * --align lines each page section up with its Figma section row by row, at the elements the
 * wireframe diff matched (triage passes it; see lib/align.js). Without it, sections are
 * lined up at their tops. Either way both sections are shown whole, and a page crop never
 * includes pixels from outside its own section.
 *
 * Writes <out>/report.json plus <out>/<n>-<slug>.png (Figma | page | diff) per compared section,
 * and exits 1 when structure fails or any compared section is below threshold.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadDeps } from './deps.js';
import { loadConfig } from './config.js';
import { pairStructure } from './lib/boxes.js';
import { withLoadedPage } from './lib/browser.js';
import { isMain, listOption, parseFlags, pct, sectionImage, signedPx } from './lib/cli.js';
import { figmaSlug, parseFigma, tileSections } from './lib/figma.js';
import { evaluateWithSections, sectionMedia } from './lib/page.js';
import { alignRows } from './lib/align.js';
import { compareSection, readAnchors, renderScale, sectionRows } from './lib/pixels.js';
import { crop, sideBySide } from './lib/png.js';

const { PNG } = await loadDeps();

const DEFAULTS = {
	threshold: 0.9,
	heightTolerance: 24,
	viewportHeight: 900,
};

function parseArgs( argv ) {
	const args = parseFlags( argv, {
		defaults: DEFAULTS,
		flags: [ 'noMaskMedia' ],
		numbers: [ 'width', 'threshold', 'heightTolerance', 'viewportHeight' ],
		required: [ 'url', 'width', 'out', 'figma', 'figmaPng' ],
	} );
	args.maskMedia = ! args.noMaskMedia;
	args.config = loadConfig( args.config );
	// Live feeds show real posts, so their pixels can't match the design either.
	args.mask = args.mask ?? [ ...args.config.mask, ...args.config.live ].join( ',' );
	return args;
}

/**
 * The Figma render and its sections, in visual order, with each section's image boxes.
 * Overlays that sit inside another section's span (e.g. a wireframe filter) aren't sections.
 *
 * @param {Object} args Parsed arguments.
 * @return {{png: PNG, scale: number, sections: Array}} Render, render px per frame px, sections.
 */
function loadFigma( args ) {
	const png = PNG.sync.read( fs.readFileSync( args.figmaPng ) );
	const { frame, sections } = parseFigma( args.figma, args.config );
	const byTop = sections.map( ( s ) => ( {
		name: s.name,
		y: s.y,
		height: s.height,
		images: s.boxes.filter( ( b ) => 'image' === b.type ).map( ( b ) => ( { x: b.x, y: b.y, width: b.w, height: b.h } ) ),
	} ) ).sort( ( a, b ) => a.y - b.y || b.height - a.height );
	const tops = byTop.filter( ( s ) => ! byTop.some( ( o ) => o !== s && o.y <= s.y && o.y + o.height >= s.y + s.height && o.height > s.height ) );
	const ignore = new RegExp( args.config.figmaIgnore, 'i' );
	return {
		png,
		scale: renderScale( png, frame ),
		sections: tileSections( tops ).filter( ( s ) => ! ignore.test( s.name ) ).map( ( s ) => ( { ...s, slug: figmaSlug( s.name, args.config ) } ) ),
	};
}

/**
 * The page's sections with their media, and a full-page screenshot.
 *
 * @param {Object} args Parsed arguments.
 * @return {Promise<{blocks: Array, png: PNG}>}
 */
function capturePage( args ) {
	return withLoadedPage( args, async ( page ) => {
		const blocks = await evaluateWithSections( page, sectionMedia, args.config );
		const png = PNG.sync.read( await page.screenshot( { fullPage: true } ) );
		return { blocks, png };
	} );
}

/**
 * Compare one section pair, write its Figma | page | diff image, and return its report entry.
 *
 * @param {Object} args    Parsed arguments.
 * @param {Object} figma   loadFigma() result.
 * @param {Object} page    capturePage() result.
 * @param {number} i       Figma section index.
 * @param {number} j       Page section index.
 * @param {Object} context { masked, anchors }: slugs compared by presence only, wireframe sync points.
 * @return {Object} Report entry.
 */
function compareSectionPair( args, figma, page, i, j, { masked, anchors } ) {
	const fs0 = figma.sections[ i ];
	const block = page.blocks[ j ];
	const heightDelta = Math.round( block.height - fs0.height );
	const entry = { index: i + 1, slug: fs0.slug, figma: fs0.name, figmaY: fs0.y, figmaHeight: Math.round( fs0.height ), pageHeight: Math.round( block.height ), heightDelta };
	if ( masked.has( fs0.slug ) ) {
		return { ...entry, status: 'masked', reason: 'dynamic content' };
	}
	const a = crop( figma.png, fs0.y, fs0.height, args.width, figma.scale );
	const rows = alignRows( anchors.get( fs0.y ) ?? [], a.height, sectionRows( block ).rows );
	const best = compareSection( a, page.png, block, rows, args.width, args.maskMedia ? { figma: fs0.images, page: block.media } : null );
	const file = sectionImage( i, fs0.slug );
	fs.writeFileSync( path.join( args.out, file ), PNG.sync.write( sideBySide( [ best.a, best.b, best.diff ] ) ) );
	const pass = best.score >= args.threshold && Math.abs( heightDelta ) <= args.heightTolerance;
	return {
		...entry,
		status: pass ? 'pass' : 'fail',
		score: Number( best.score.toFixed( 4 ) ),
		areaScore: Number( best.areaScore.toFixed( 4 ) ),
		aligned: anchors.has( fs0.y ),
		refine: best.refine,
		height: best.a.height,
		rows: best.rows,
		maskedShare: Number( best.maskedShare.toFixed( 3 ) ),
		image: file,
	};
}

function printReport( report, args, pageScore ) {
	const { missing, extra, moved } = report.structure;
	console.log( `${ report.pass ? 'PASS' : 'FAIL' } ${ args.width }px  page score ${ pct( pageScore ) }  (threshold ${ pct( args.threshold ) }, height ±${ args.heightTolerance }px)` );
	for ( const m of missing ) {
		console.log( `  missing #${ m.index } ${ m.slug }${ moved.includes( m.slug ) ? ' (moved)' : '' }` );
	}
	for ( const e of extra ) {
		console.log( `  extra   page block #${ e.index } ${ e.slug }${ moved.includes( e.slug ) ? ' (moved)' : '' }` );
	}
	for ( const r of report.sections ) {
		const masked = r.maskedShare > 0.2 ? `  (${ pct( r.maskedShare ) } masked)` : '';
		const detail = 'masked' === r.status ? r.reason : `${ pct( r.score ) }  Δh ${ signedPx( r.heightDelta ) }  gaps ${ r.rows.filter( ( s ) => null === s.figma || null === s.page ).length }${ masked }`;
		console.log( `  ${ r.status.padEnd( 6 ) } #${ String( r.index ).padStart( 2 ) } ${ r.slug.padEnd( 28 ) } ${ detail }` );
	}
	console.log( `  report: ${ path.join( args.out, 'report.json' ) }` );
}

async function main() {
	const args = parseArgs( process.argv.slice( 2 ) );
	fs.mkdirSync( args.out, { recursive: true } );
	const figma = loadFigma( args );
	const page = await capturePage( args );

	const { pairs, missing, extra, moved } = pairStructure( figma.sections, page.blocks );

	const context = { masked: listOption( args.mask ), anchors: readAnchors( args.align ) };
	const results = pairs.map( ( [ i, j ] ) => compareSectionPair( args, figma, page, i, j, context ) );

	// The page score weighs each section by the height compared.
	const compared = results.filter( ( r ) => undefined !== r.score );
	const area = compared.reduce( ( sum, r ) => sum + Math.min( r.figmaHeight, r.pageHeight ), 0 );
	const pageScore = area ? compared.reduce( ( sum, r ) => sum + r.score * Math.min( r.figmaHeight, r.pageHeight ), 0 ) / area : 0;
	const report = {
		url: args.url,
		width: args.width,
		threshold: args.threshold,
		heightTolerance: args.heightTolerance,
		pass: ! missing.length && ! extra.length && compared.every( ( r ) => 'pass' === r.status ),
		pageScore: Number( pageScore.toFixed( 4 ) ),
		structure: { figmaSections: figma.sections.length, pageSections: page.blocks.length, missing, extra, moved },
		sections: results,
	};
	fs.writeFileSync( path.join( args.out, 'report.json' ), JSON.stringify( report, null, '\t' ) );
	// The unrounded score: the report keeps four decimals, which can move the printed digit.
	printReport( report, args, pageScore );
	process.exitCode = report.pass ? 0 : 1;
}

if ( isMain( import.meta.url ) ) {
	main().catch( ( error ) => {
		console.error( error.message );
		process.exitCode = 2;
	} );
}
