/**
 * Pixel diff: compare a built page against its Figma frame, section by section.
 *
 * The visual half of triage (see triage.js): it sees colour, theme, typography and
 * image content, which the wireframe diff ignores, but cannot say what is wrong.
 *
 * Usage:
 *   node pixel-diff.js --url <page-url> --width <1440|375> --out <dir> --figma-png <frame.png> \
 *     (--figma <figma-boxes.txt> | --sections <sections.json> | --file-key <key> --node-id <id>)
 *
 * --figma reads sections from figma-boxes.js output. With FIGMA_TOKEN set, --file-key and
 * --node-id fetch the frame render and sections from the REST API instead.
 *
 * Writes <out>/report.json plus <out>/<n>-<slug>.png (Figma | page | diff) per compared section,
 * and exits 1 when structure fails or any compared section is below threshold.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDeps } from './deps.js';
import { loadPage, pairSections, parseFigma } from './wireframe-diff.js';
import { evaluateWithSections, figmaSlug, loadConfig } from './config.js';

const { chromium, pixelmatch, PNG } = await loadDeps();

const DEFAULTS = {
	threshold: 0.9,
	heightTolerance: 24,
	maxShift: 16,
	viewportHeight: 900,
	maskMedia: true,
};

function parseArgs( argv ) {
	const args = { ...DEFAULTS };
	for ( let i = 0; i < argv.length; i++ ) {
		const key = argv[ i ].replace( /^--/, '' );
		if ( 'no-mask-media' === key ) {
			args.maskMedia = false;
			continue;
		}
		const camel = key.replace( /-([a-z])/g, ( m, c ) => c.toUpperCase() );
		args[ camel ] = argv[ ++i ];
	}
	args.width = Number( args.width );
	args.threshold = Number( args.threshold );
	args.heightTolerance = Number( args.heightTolerance );
	args.maxShift = Number( args.maxShift );
	args.viewportHeight = Number( args.viewportHeight );
	for ( const required of [ 'url', 'width', 'out' ] ) {
		if ( ! args[ required ] ) {
			throw new Error( `Missing --${ required }` );
		}
	}
	args.config = loadConfig( args.config );
	// Live feeds show real posts, so their pixels can't match the design either.
	args.mask = args.mask ?? [ ...args.config.mask, ...args.config.live ].join( ',' );
	return args;
}

async function fetchFigma( args ) {
	const token = process.env.FIGMA_TOKEN;
	if ( ! token ) {
		throw new Error( 'Pass --figma-png and --sections, or set FIGMA_TOKEN with --file-key and --node-id.' );
	}
	const id = args.nodeId.replace( '-', ':' );
	const headers = { 'X-Figma-Token': token };
	const nodes = await ( await fetch( `https://api.figma.com/v1/files/${ args.fileKey }/nodes?ids=${ encodeURIComponent( id ) }&depth=1`, { headers } ) ).json();
	const frame = nodes.nodes?.[ id ]?.document;
	if ( ! frame ) {
		throw new Error( `Figma node ${ id } not found: ${ JSON.stringify( nodes ).slice( 0, 200 ) }` );
	}
	const box = frame.absoluteBoundingBox;
	const sections = ( frame.children || [] )
		.filter( ( child ) => false !== child.visible )
		.map( ( child ) => ( {
			name: child.name,
			y: child.absoluteBoundingBox.y - box.y,
			height: child.absoluteBoundingBox.height,
		} ) );
	const images = await ( await fetch( `https://api.figma.com/v1/images/${ args.fileKey }?ids=${ encodeURIComponent( id ) }&format=png&scale=1`, { headers } ) ).json();
	const png = Buffer.from( await ( await fetch( images.images[ id ] ) ).arrayBuffer() );
	return { frame: { width: box.width, height: box.height }, sections, png: PNG.sync.read( png ) };
}

function loadFigma( args ) {
	const png = PNG.sync.read( fs.readFileSync( args.figmaPng ) );
	if ( args.figma ) {
		// Extractor output is authoritative, so it needs no tiling check.
		const { frame, sections } = parseFigma( args.figma, args.config );
		const images = ( s ) => s.boxes.filter( ( b ) => 'image' === b.type ).map( ( b ) => ( { x: b.x, y: b.y, width: b.w, height: b.h } ) );
		return { frame, sections: sections.map( ( s ) => ( { name: s.name, y: s.y, height: s.height, images: images( s ) } ) ), png, extracted: true };
	}
	return { ...JSON.parse( fs.readFileSync( args.sections, 'utf8' ) ), png };
}

/**
 * Transcribed sections must tile the frame; a gap or overlap means a copying error.
 *
 * @param {Array}  sections Visible sections sorted by y.
 * @param {Object} frame    Frame size.
 * @return {string[]} Problems found.
 */
function checkTiling( sections, frame ) {
	const problems = [];
	for ( let i = 1; i < sections.length; i++ ) {
		const gap = sections[ i ].y - ( sections[ i - 1 ].y + sections[ i - 1 ].height );
		if ( Math.abs( gap ) > 2 ) {
			problems.push( `"${ sections[ i - 1 ].name }" and "${ sections[ i ].name }" are ${ gap.toFixed( 1 ) }px apart` );
		}
	}
	const last = sections[ sections.length - 1 ];
	if ( last && Math.abs( last.y + last.height - frame.height ) > 2 ) {
		problems.push( `sections end at ${ ( last.y + last.height ).toFixed( 1 ) }px, frame is ${ frame.height }px` );
	}
	return problems;
}

function chromiumPath() {
	const bundled = chromium.executablePath();
	if ( fs.existsSync( bundled ) ) {
		return undefined;
	}
	const cache = path.join( os.homedir(), '.cache', 'ms-playwright' );
	const builds = fs.existsSync( cache ) ? fs.readdirSync( cache ).filter( ( d ) => /^chromium-\d+$/.test( d ) ).sort( ( a, b ) => Number( b.split( '-' )[ 1 ] ) - Number( a.split( '-' )[ 1 ] ) ) : [];
	for ( const build of builds ) {
		for ( const dir of [ 'chrome-linux64', 'chrome-linux' ] ) {
			const candidate = path.join( cache, build, dir, 'chrome' );
			if ( fs.existsSync( candidate ) ) {
				return candidate;
			}
		}
	}
	throw new Error( 'No Chromium found; run `npx playwright install chromium`.' );
}

async function capturePage( args ) {
	const browser = await chromium.launch( { executablePath: chromiumPath() } );
	try {
		const page = await browser.newPage( {
			// vh-based sections (e.g. min-height: 100vh) size from this height.
			viewport: { width: args.width, height: args.viewportHeight },
			deviceScaleFactor: 1,
			reducedMotion: 'reduce',
			ignoreHTTPSErrors: true,
		} );
		await loadPage( page, args.url );
		const blocks = await evaluateWithSections( page, ( detect, cfg ) => detect( cfg )
				.map( ( { el, slug } ) => {
					const rect = el.getBoundingClientRect();
					const media = [ ...el.querySelectorAll( 'img, video, iframe, picture' ) ].map( ( m ) => {
						const r = m.getBoundingClientRect();
						return { x: r.left, y: r.top - rect.top, width: r.width, height: r.height };
					} ).filter( ( r ) => r.width > 0 && r.height > 0 );
					return { slug, y: rect.top + window.scrollY, height: rect.height, media };
				} ), args.config );
		const png = PNG.sync.read( await page.screenshot( { fullPage: true } ) );
		return { blocks, png };
	} finally {
		await browser.close();
	}
}

/** Crop rows [y, y+h) and scale to `width` with nearest-neighbour sampling. */
function crop( png, y, h, width, scale = 1 ) {
	const out = new PNG( { width, height: Math.max( 1, Math.round( h ) ) } );
	for ( let row = 0; row < out.height; row++ ) {
		const sy = Math.min( png.height - 1, Math.floor( ( y + row ) * scale ) );
		for ( let col = 0; col < width; col++ ) {
			const sx = Math.min( png.width - 1, Math.floor( col * scale ) );
			const s = ( sy * png.width + sx ) * 4;
			const d = ( row * width + col ) * 4;
			if ( sy < 0 ) {
				continue;
			}
			png.data.copy( out.data, d, s, s + 4 );
		}
	}
	return out;
}

/**
 * Per-pixel mask of media rects. Media covering half the section or more is a
 * background with content on top, so it stays compared.
 *
 * @param {number} width  Crop width.
 * @param {number} height Crop height.
 * @param {Array}  rects  Media rects relative to the section.
 * @return {Uint8Array} 1 where masked.
 */
/**
 * Regions to mask: where a page image overlaps a Figma image. Masking every page image would
 * blank the Figma content under an extra or displaced one and inflate the score.
 *
 * @param {Array}      pageMedia Page media rects, section-relative.
 * @param {Array|null} figmaImages Figma image rects, section-relative; null when unknown.
 * @return {Array} Rects to mask.
 */
export function sharedMedia( pageMedia, figmaImages ) {
	if ( ! figmaImages ) {
		return pageMedia;
	}
	const shared = [];
	for ( const p of pageMedia ) {
		for ( const f of figmaImages ) {
			const x = Math.max( p.x, f.x );
			const y = Math.max( p.y, f.y );
			const width = Math.min( p.x + p.width, f.x + f.width ) - x;
			const height = Math.min( p.y + p.height, f.y + f.height ) - y;
			if ( width > 0 && height > 0 ) {
				shared.push( { x, y, width, height } );
			}
		}
	}
	return shared;
}

function mediaMask( width, height, rects ) {
	const mask = new Uint8Array( width * height );
	for ( const r of rects ) {
		if ( r.width * r.height >= 0.5 * width * height ) {
			continue;
		}
		for ( let y = Math.max( 0, Math.floor( r.y ) ); y < Math.min( height, Math.ceil( r.y + r.height ) ); y++ ) {
			mask.fill( 1, y * width + Math.max( 0, Math.floor( r.x ) ), y * width + Math.min( width, Math.ceil( r.x + r.width ) ) );
		}
	}
	return mask;
}

function applyMask( png, mask ) {
	for ( let i = 0; i < mask.length; i++ ) {
		if ( mask[ i ] ) {
			png.data.writeUInt32BE( 0xff00ffff, i * 4 );
		}
	}
}

/** Most common colour (quantised) among unmasked pixels: the section background. */
function backgroundColor( png, mask ) {
	const counts = new Map();
	for ( let i = 0; i < mask.length; i += 3 ) {
		if ( mask[ i ] ) {
			continue;
		}
		const d = i * 4;
		const key = ( ( png.data[ d ] >> 3 ) << 10 ) | ( ( png.data[ d + 1 ] >> 3 ) << 5 ) | ( png.data[ d + 2 ] >> 3 );
		counts.set( key, ( counts.get( key ) || 0 ) + 1 );
	}
	let best = 0;
	let bestCount = -1;
	for ( const [ key, count ] of counts ) {
		if ( count > bestCount ) {
			best = key;
			bestCount = count;
		}
	}
	return [ ( ( best >> 10 ) & 31 ) << 3, ( ( best >> 5 ) & 31 ) << 3, ( best & 31 ) << 3 ];
}

/** Pixels that differ from their own image's background in either image. */
function contentPixels( a, b, mask ) {
	const bgA = backgroundColor( a, mask );
	const bgB = backgroundColor( b, mask );
	const far = ( png, d, bg ) => Math.abs( png.data[ d ] - bg[ 0 ] ) + Math.abs( png.data[ d + 1 ] - bg[ 1 ] ) + Math.abs( png.data[ d + 2 ] - bg[ 2 ] ) > 48;
	let count = 0;
	for ( let i = 0; i < mask.length; i++ ) {
		if ( ! mask[ i ] && ( far( a, i * 4, bgA ) || far( b, i * 4, bgB ) ) ) {
			count++;
		}
	}
	return count;
}

/**
 * Compare a Figma section crop against the page, trying small vertical shifts
 * so a uniform offset is reported as an offset rather than a total mismatch.
 * The score counts mismatches against content pixels, so empty background
 * cannot inflate it; a wrong background colour drives it to zero.
 */
function compareSection( a, page, blockY, h, width, media, maxShift ) {
	const mask = media ? mediaMask( width, a.height, media ) : new Uint8Array( width * a.height );
	applyMask( a, mask );
	const area = mask.length - mask.reduce( ( sum, m ) => sum + m, 0 );
	let best = null;
	for ( let shift = -maxShift; shift <= maxShift; shift++ ) {
		const b = crop( page.png, blockY + shift, h, width );
		applyMask( b, mask );
		const diff = new PNG( { width, height: a.height } );
		const mismatched = pixelmatch( a.data, b.data, diff.data, width, a.height, { threshold: 0.1, includeAA: false, alpha: 0.2 } );
		const content = Math.max( contentPixels( a, b, mask ), Math.ceil( 0.01 * area ) );
		const score = Math.max( 0, 1 - mismatched / content );
		if ( ! best || score > best.score ) {
			best = { score, shift, b, diff, areaScore: area ? 1 - mismatched / area : 1, maskedShare: 1 - area / mask.length };
		}
	}
	return best;
}

function sideBySide( images ) {
	const gap = 8;
	const width = images.reduce( ( sum, img ) => sum + img.width, 0 ) + gap * ( images.length - 1 );
	const height = Math.max( ...images.map( ( img ) => img.height ) );
	const out = new PNG( { width, height } );
	out.data.fill( 255 );
	let x0 = 0;
	for ( const img of images ) {
		PNG.bitblt( img, out, 0, 0, img.width, img.height, x0, 0 );
		x0 += img.width + gap;
	}
	return out;
}

async function main() {
	const args = parseArgs( process.argv.slice( 2 ) );
	fs.mkdirSync( args.out, { recursive: true } );
	const figma = args.figmaPng ? loadFigma( args ) : await fetchFigma( args );
	const ignore = new RegExp( args.config.figmaIgnore, 'i' );
	const masked = new Set( args.mask.split( ',' ).map( ( s ) => s.trim() ).filter( Boolean ) );

	// Overlays (e.g. a wireframe filter) sit inside another section's span; they are not sections.
	const visible = figma.sections.filter( ( s ) => ! s.hidden ).sort( ( a, b ) => a.y - b.y || b.height - a.height );
	const sections = visible.filter( ( s ) => ! visible.some( ( o ) => o !== s && o.y <= s.y && o.y + o.height >= s.y + s.height && o.height > s.height ) );
	const tiling = figma.extracted ? [] : checkTiling( sections, figma.frame );
	const figmaSections = sections.filter( ( s ) => ! ignore.test( s.name ) ).map( ( s ) => ( { ...s, slug: figmaSlug( s.name, args.config ) } ) );
	const scale = figma.png.width / figma.frame.width;

	const page = await capturePage( args );
	const { pairs } = pairSections( figmaSections.map( ( s ) => s.slug ), page.blocks.map( ( b ) => b.slug ) );
	const matchedFigma = new Set( pairs.map( ( [ i ] ) => i ) );
	const matchedPage = new Set( pairs.map( ( [ , j ] ) => j ) );
	const missing = figmaSections.filter( ( s, i ) => ! matchedFigma.has( i ) ).map( ( s ) => ( { index: figmaSections.indexOf( s ) + 1, slug: s.slug, figma: s.name } ) );
	const extra = page.blocks.filter( ( b, j ) => ! matchedPage.has( j ) ).map( ( b ) => ( { index: page.blocks.indexOf( b ) + 1, slug: b.slug } ) );
	const moved = missing.filter( ( m ) => extra.some( ( e ) => e.slug === m.slug ) ).map( ( m ) => m.slug );

	const results = [];
	for ( const [ i, j ] of pairs ) {
		const fs0 = figmaSections[ i ];
		const block = page.blocks[ j ];
		const heightDelta = Math.round( block.height - fs0.height );
		const entry = { index: i + 1, slug: fs0.slug, figma: fs0.name, figmaHeight: Math.round( fs0.height ), pageHeight: Math.round( block.height ), heightDelta };
		if ( masked.has( fs0.slug ) ) {
			results.push( { ...entry, status: 'masked', reason: 'dynamic content' } );
			continue;
		}
		const h = Math.min( fs0.height, block.height );
		const a = crop( figma.png, fs0.y, h, args.width, scale );
		const best = compareSection( a, page, block.y, h, args.width, args.maskMedia ? sharedMedia( block.media, fs0.images ?? null ) : null, args.maxShift );
		const file = `${ String( i + 1 ).padStart( 2, '0' ) }-${ fs0.slug }.png`;
		fs.writeFileSync( path.join( args.out, file ), PNG.sync.write( sideBySide( [ a, best.b, best.diff ] ) ) );
		const pass = best.score >= args.threshold && Math.abs( heightDelta ) <= args.heightTolerance;
		results.push( {
			...entry,
			status: pass ? 'pass' : 'fail',
			score: Number( best.score.toFixed( 4 ) ),
			areaScore: Number( best.areaScore.toFixed( 4 ) ),
			shift: best.shift,
			maskedShare: Number( best.maskedShare.toFixed( 3 ) ),
			image: file,
		} );
	}

	const compared = results.filter( ( r ) => undefined !== r.score );
	const area = compared.reduce( ( sum, r ) => sum + Math.min( r.figmaHeight, r.pageHeight ), 0 );
	const pageScore = area ? compared.reduce( ( sum, r ) => sum + r.score * Math.min( r.figmaHeight, r.pageHeight ), 0 ) / area : 0;
	const structureOk = ! missing.length && ! extra.length && ! tiling.length;
	const report = {
		url: args.url,
		width: args.width,
		threshold: args.threshold,
		heightTolerance: args.heightTolerance,
		pass: structureOk && compared.every( ( r ) => 'pass' === r.status ),
		pageScore: Number( pageScore.toFixed( 4 ) ),
		structure: { figmaSections: figmaSections.length, pageSections: page.blocks.length, missing, extra, moved, tiling },
		sections: results,
	};
	fs.writeFileSync( path.join( args.out, 'report.json' ), JSON.stringify( report, null, '\t' ) );

	const pct = ( n ) => `${ ( n * 100 ).toFixed( 1 ) }%`;
	console.log( `${ report.pass ? 'PASS' : 'FAIL' } ${ args.width }px  page score ${ pct( pageScore ) }  (threshold ${ pct( args.threshold ) }, height ±${ args.heightTolerance }px)` );
	for ( const t of tiling ) {
		console.log( `  sections file: ${ t }` );
	}
	for ( const m of missing ) {
		console.log( `  missing #${ m.index } ${ m.slug }${ moved.includes( m.slug ) ? ' (moved)' : '' }` );
	}
	for ( const e of extra ) {
		console.log( `  extra   page block #${ e.index } ${ e.slug }${ moved.includes( e.slug ) ? ' (moved)' : '' }` );
	}
	for ( const r of results ) {
		const detail = 'masked' === r.status ? r.reason : `${ pct( r.score ) }  Δh ${ r.heightDelta > 0 ? '+' : '' }${ r.heightDelta }px  shift ${ r.shift }px${ r.maskedShare > 0.2 ? `  (${ pct( r.maskedShare ) } masked)` : '' }`;
		console.log( `  ${ r.status.padEnd( 6 ) } #${ String( r.index ).padStart( 2 ) } ${ r.slug.padEnd( 28 ) } ${ detail }` );
	}
	console.log( `  report: ${ path.join( args.out, 'report.json' ) }` );
	process.exitCode = report.pass ? 0 : 1;
}

if ( import.meta.url === `file://${ process.argv[ 1 ] }` ) {
	main().catch( ( error ) => {
		console.error( error.message );
		process.exitCode = 2;
	} );
}
