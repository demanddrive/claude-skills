/**
 * Comparing pixels: line a page section up with its Figma section row by row (see align.js),
 * and score how much of the content matches.
 */

import fs from 'node:fs';
import { loadDeps } from '../deps.js';
import { alignedBox, alignedHeight, rowSources } from './align.js';
import { backgroundColor, crop } from './png.js';

const { pixelmatch, PNG } = await loadDeps();

/**
 * Render px per frame px. Figma pads a narrow frame's render to a minimum width (a 375px
 * frame comes back 648px wide: the frame at the left, blank canvas beside it), so the side
 * that isn't padded, the smaller ratio, is the scale.
 *
 * @param {{width: number, height: number}} png   The Figma render.
 * @param {{width: number, height: number}} frame The frame, from figma-boxes.txt.
 * @return {number}
 */
export function renderScale( png, frame ) {
	return Math.min( png.width / frame.width, png.height / frame.height );
}

/**
 * A page section's rows in the screenshot. Its y and height are fractional, so its edges are
 * rounded, not its height: rounding the height alone can take in the next section's first row.
 *
 * @param {{y: number, height: number}} section Page section box.
 * @return {{top: number, rows: number}}
 */
export function sectionRows( section ) {
	const top = Math.round( section.y );
	return { top, rows: Math.max( 1, Math.round( section.y + section.height ) - top ) };
}

/** Mask values: an image both sides have (magenta), a row only the other side has (grey stripes). */
const MEDIA = 1;
const GAP = 2;

/**
 * Where images are masked, per aligned pixel: where a Figma image and a page image overlap
 * and, in a gap, the rest of an image that overlaps one on the other side (an image taller on
 * one side: its size is a layout defect, not a pixel one). An image with no counterpart stays
 * compared, so masking can't blank content under an extra or displaced image. Neither can an
 * image covering half its section or more: it's a background with content on top.
 *
 * @param {Array}  segments    alignRows() result.
 * @param {number} width       Section width.
 * @param {Array}  figmaImages Figma image rects {x, y, width, height}, section-relative.
 * @param {Array}  pageImages  Page media rects, section-relative.
 * @param {number} figmaHeight Figma section height.
 * @param {number} pageHeight  Page section height.
 * @return {Uint8Array} MEDIA where masked.
 */
export function mediaMask( segments, width, figmaImages, pageImages, figmaHeight, pageHeight ) {
	const place = ( rects, side, height ) => rects
		.filter( ( r ) => r.width * r.height < 0.5 * width * height )
		.map( ( r ) => alignedBox( segments, side, { x: r.x, y: r.y, w: r.width, h: r.height } ) );
	const figma = place( figmaImages, 'figma', figmaHeight );
	const page = place( pageImages, 'page', pageHeight );
	const shared = [];
	const withPartner = { figma: new Set(), page: new Set() };
	for ( const f of figma ) {
		for ( const p of page ) {
			const x = Math.max( f.x, p.x );
			const y = Math.max( f.y, p.y );
			const w = Math.min( f.x + f.w, p.x + p.w ) - x;
			const h = Math.min( f.y + f.h, p.y + p.h ) - y;
			if ( w > 0 && h > 0 ) {
				shared.push( { x, y, w, h } );
				withPartner.figma.add( f );
				withPartner.page.add( p );
			}
		}
	}
	const [ fRows, pRows ] = rowSources( segments );
	const mask = new Uint8Array( width * fRows.length );
	for ( let row = 0; row < fRows.length; row++ ) {
		const rects = fRows[ row ] >= 0 && pRows[ row ] >= 0 ? shared : [ ...( fRows[ row ] >= 0 ? withPartner.figma : withPartner.page ) ];
		for ( const r of rects ) {
			if ( row >= r.y && row < r.y + r.h ) {
				mask.fill( MEDIA, row * width + Math.max( 0, Math.floor( r.x ) ), row * width + Math.min( width, Math.ceil( r.x + r.w ) ) );
			}
		}
	}
	return mask;
}

/** One aligned image: each row from its source row, grey stripes where the side has none. */
function alignedImage( src, rows, width ) {
	const out = new PNG( { width, height: rows.length } );
	for ( let row = 0; row < rows.length; row++ ) {
		if ( rows[ row ] >= 0 ) {
			src.data.copy( out.data, row * width * 4, rows[ row ] * width * 4, ( rows[ row ] + 1 ) * width * 4 );
			continue;
		}
		for ( let col = 0; col < width; col++ ) {
			out.data.writeUInt32BE( ( col + row ) % 12 < 6 ? 0xe6e6e6ff : 0xccccccff, ( row * width + col ) * 4 );
		}
	}
	return out;
}

/** Paint masked images magenta: on the copies compared, so they match, and on the diff, to show what was left out. */
function paintMedia( png, mask ) {
	for ( let i = 0; i < mask.length; i++ ) {
		if ( MEDIA === mask[ i ] ) {
			png.data.writeUInt32BE( 0xff00ffff, i * 4 );
		}
	}
}

/** A pixel differs from its image's background: it's content. */
const isContent = ( png, i, bg ) => Math.abs( png.data[ i * 4 ] - bg[ 0 ] ) + Math.abs( png.data[ i * 4 + 1 ] - bg[ 1 ] ) + Math.abs( png.data[ i * 4 + 2 ] - bg[ 2 ] ) > 48;

/**
 * How far pixels may refine the alignment. Element boxes place text a pixel or two
 * differently in Figma and the browser (line-height handling), which costs a text-heavy
 * section ~10 points; a window this small can't reach another row of a repeating grid.
 */
export const REFINE = 3;

/**
 * Compare a Figma section against its page section, row by row as `segments` aligns them.
 *
 * Both panels show their whole section; a row only one side has is grey stripes on the other.
 * The score counts mismatches against content pixels, so empty background can't inflate it and
 * a wrong background colour drives it to zero. Rows only one side has cost what content they
 * hold: extra space is a spacing defect the wireframe diff reports, but an extra form field or
 * a missing card row is content the other side doesn't match. The page may shift ±`refine` rows
 * against the alignment; nothing wider, so a repeating grid can't slide onto the wrong row.
 *
 * @param {PNG}        a        Figma section crop (the whole section).
 * @param {PNG}        png      Full-page screenshot.
 * @param {Object}     section  Page section box: y and height, in page pixels.
 * @param {Array}      segments alignRows() result, for sectionRows( section ).rows page rows.
 * @param {number}     width    Crop width.
 * @param {Object|null} media   {figma, page} image rects to mask, section-relative; null masks none.
 * @param {number}     refine   Rows either way the page may shift (0 compares as aligned).
 * @return {Object} score, areaScore, maskedShare, refine (the shift used), rows (segments with
 *   the shift applied), and the Figma (a), page (b) and diff panels.
 */
export function compareSection( a, png, section, segments, width, media, refine = REFINE ) {
	const { top, rows: hp } = sectionRows( section );
	// Exactly the section's rows: nothing from the sections around it can show.
	const page = crop( png, top, hp, width );
	const n = alignedHeight( segments );
	const [ fRows, pRows ] = rowSources( segments );
	let best = null;
	for ( let delta = -refine; delta <= refine; delta++ ) {
		const shifted = segments.map( ( s ) => ( { ...s, page: null === s.page ? null : s.page + delta } ) );
		const rows = pRows.map( ( r ) => ( r >= 0 && r + delta >= 0 && r + delta < hp ? r + delta : -1 ) );
		// Masked where the images are with this shift: a page image moves with its rows.
		const media0 = media ? mediaMask( shifted, width, media.figma, media.page, a.height, hp ) : new Uint8Array( width * n );
		// The Figma and page panels keep their images, for a person to look at.
		const shown = alignedImage( a, fRows, width );
		const b = alignedImage( page, rows, width );
		// Rows one side lacks are striped on both copies compared, so pixelmatch sees no difference
		// there; their content is counted below instead.
		const mask = media0.slice();
		for ( let row = 0; row < n; row++ ) {
			if ( fRows[ row ] < 0 || rows[ row ] < 0 ) {
				mask.fill( GAP, row * width, ( row + 1 ) * width );
			}
		}
		const aa = new PNG( { width, height: n } );
		const bb = new PNG( { width, height: n } );
		shown.data.copy( aa.data );
		b.data.copy( bb.data );
		paintMedia( aa, media0 );
		paintMedia( bb, media0 );
		for ( let i = 0; i < mask.length; i++ ) {
			if ( GAP === mask[ i ] ) {
				aa.data.writeUInt32BE( 0xe6e6e6ff, i * 4 );
				bb.data.writeUInt32BE( 0xe6e6e6ff, i * 4 );
			}
		}
		const diff = new PNG( { width, height: n } );
		const mismatched = pixelmatch( aa.data, bb.data, diff.data, width, n, { threshold: 0.1, includeAA: false, alpha: 0.2 } );
		paintMedia( diff, media0 );
		// Each side's background, from its own rows (not its gaps or masked images).
		const own = ( rowsOf ) => {
			const m = media0.slice();
			for ( let row = 0; row < n; row++ ) {
				if ( rowsOf[ row ] < 0 ) {
					m.fill( GAP, row * width, ( row + 1 ) * width );
				}
			}
			return m;
		};
		const bgA = backgroundColor( shown, own( fRows ) );
		const bgB = backgroundColor( b, own( rows ) );
		let content = 0;
		let unmatched = 0;
		let area = 0;
		for ( let row = 0; row < n; row++ ) {
			const hasF = fRows[ row ] >= 0;
			const hasP = rows[ row ] >= 0;
			for ( let i = row * width; i < ( row + 1 ) * width; i++ ) {
				if ( MEDIA === media0[ i ] || ( ! hasF && ! hasP ) ) {
					continue;
				}
				area++;
				if ( hasF && hasP ) {
					content += isContent( shown, i, bgA ) || isContent( b, i, bgB ) ? 1 : 0;
				} else if ( hasF ? isContent( shown, i, bgA ) : isContent( b, i, bgB ) ) {
					// Content on one side only: shown red on its faded row.
					unmatched++;
					diff.data.writeUInt32BE( 0xff0000ff, i * 4 );
				}
			}
		}
		const missed = mismatched + unmatched;
		const score = Math.max( 0, 1 - missed / Math.max( content + unmatched, Math.ceil( 0.01 * area ) ) );
		// Ties go to the smaller shift, so the measured alignment wins when pixels can't tell.
		if ( ! best || score > best.score || ( score === best.score && Math.abs( delta ) < Math.abs( best.refine ) ) ) {
			best = {
				score,
				areaScore: area ? 1 - missed / area : 1,
				maskedShare: media0.reduce( ( k, m ) => k + ( m ? 1 : 0 ), 0 ) / ( width * n ),
				refine: delta,
				rows: shifted,
				a: shown,
				b,
				diff,
			};
		}
	}
	return best;
}

/**
 * The wireframe diff's sync points per Figma section, keyed by the section's top y.
 *
 * Sections are matched by where they sit in the Figma frame rather than by number: the
 * pixel diff leaves out overlays, so the two diffs can number the same section differently.
 *
 * @param {string|undefined} file Wireframe report.json; without one there is no alignment.
 * @return {Map<number, number[][]>} Figma top y → anchor points [f, p].
 */
export function readAnchors( file ) {
	const report = file ? JSON.parse( fs.readFileSync( file, 'utf8' ) ) : { sections: [] };
	return new Map( report.sections.filter( ( s ) => Array.isArray( s.anchors ) ).map( ( s ) => [ s.figmaY, s.anchors ] ) );
}

/**
 * The loaded images a full-page screenshot drew as one flat colour: Chromium sometimes skips
 * painting an image far down a long page, though the image is decoded and visible.
 *
 * @param {PNG}    png   Full-page screenshot.
 * @param {Object} block Page section: its y and media (x, y, width, height, loaded).
 * @return {Array} The media drawn blank.
 */
export function blankMedia( png, block ) {
	return block.media.filter( ( m ) => m.loaded && m.width >= 40 && m.height >= 40 ).filter( ( m ) => {
		const x0 = Math.max( 0, Math.round( m.x ) );
		const y0 = Math.max( 0, Math.round( block.y + m.y ) );
		const x1 = Math.min( png.width, Math.round( m.x + m.width ) );
		const y1 = Math.min( png.height, Math.round( block.y + m.y + m.height ) );
		const lo = [ 255, 255, 255 ];
		const hi = [ 0, 0, 0 ];
		for ( let y = y0; y < y1; y += 4 ) {
			for ( let x = x0; x < x1; x += 4 ) {
				const i = ( y * png.width + x ) * 4;
				for ( let c = 0; c < 3; c++ ) {
					lo[ c ] = Math.min( lo[ c ], png.data[ i + c ] );
					hi[ c ] = Math.max( hi[ c ], png.data[ i + c ] );
				}
			}
		}
		// A photo spans far more than 8 levels in some channel; a skipped paint is one fill.
		return x1 > x0 && y1 > y0 && hi.every( ( h, c ) => h - lo[ c ] <= 8 );
	} );
}
