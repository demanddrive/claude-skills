/**
 * Comparing boxes: pair Figma sections with page sections, then elements within them, and
 * measure what differs.
 */

import { alignedRow, alignRows, anchorPoints } from './align.js';
import { hash, normText, TEXT_PREFIX } from './figma.js';

/** An element moved sideways by at least this much, at the same size, is an alignment change. */
export const ALIGNMENT_SHIFT = 40;

/** A box covering this share of a section in both directions is its background, not content. */
const BACKGROUND_SHARE = 0.8;

/** Page paragraphs merged at most into one Figma text layer. */
const MAX_MERGED_PARAGRAPHS = 12;

/** Largest per-element offsets kept in a section's report. */
export const MAX_OFFSETS = 12;

/** Relative aspect-ratio change an image may show before it counts: whole-pixel rounding. */
export const ASPECT_TOLERANCE = 0.02;
/** How much an image's shape changed: its page aspect ratio over its Figma one, minus 1. */
export const aspectChange = ( o ) => ( o.page.w / o.page.h ) / ( o.figma.w / o.figma.h ) - 1;

/**
 * Whether an offset's width or height changed past its tolerance, the rule sectionDefects()
 * applies: `t` for text, whose box follows the font's metrics; `size` for any other box.
 */
const sizeChange = ( m ) => Math.max( Math.abs( m.dw ), Math.abs( m.dh ) );
const resizedBy = ( m, t, size ) => {
	// An image scaled to the same shape isn't a defect (see sectionDefects), so it isn't resized.
	if ( 'image' === m.f.type && Math.abs( aspectChange( { figma: m.f, page: m.p } ) ) <= ASPECT_TOLERANCE ) {
		return false;
	}
	return sizeChange( m ) > ( 'text' === m.f.type ? t : size );
};

/** Whether box `o` lies within box `b`, give or take 2px of rounding. */
const inside = ( o, b ) => o.x >= b.x - 2 && o.y >= b.y - 2 && o.x + o.w <= b.x + b.w + 2 && o.y + o.h <= b.y + b.h + 2;

/** Whether a box covers most of its section (`c`) both ways: its background, not content. */
const background = ( b, c ) => b.w >= BACKGROUND_SHARE * c.w && b.h >= BACKGROUND_SHARE * c.h;

/** Text over more than one line: its width is its longest line, wherever the lines broke. */
const wrapped = ( b ) => 'text' === b.type && Number( b.style?.lh ) > 0 && b.h > 1.5 * Number( b.style.lh );

/**
 * How much wider a paired box is on the page. Wrapped text's ink is its longest line,
 * wherever the lines broke, so its layout boxes (where lines may run) compare instead, or
 * nothing when a side has none.
 *
 * @param {{f: Object, p: Object}} m Pair.
 * @return {number} Px.
 */
function widthChange( { f, p } ) {
	if ( ! wrapped( f ) && ! wrapped( p ) ) {
		return p.w - f.w;
	}
	return f.lw && p.lw ? p.lw - f.lw : 0;
}

/**
 * The sides of a box that aren't a layout edge: where wrapped text's lines end unevenly (the
 * right for left-aligned text, both for centred). Without an alignment, left is assumed.
 *
 * @param {Object} b Box.
 * @return {{left: boolean, right: boolean}}
 */
function ragged( b ) {
	const align = b.style?.align ?? 'left';
	return wrapped( b ) ? { left: 'right' === align || 'center' === align, right: 'left' === align || 'center' === align } : { left: false, right: false };
}

/**
 * Pair Figma sections with page sections: longest common subsequence of slugs. When the
 * names barely line up but the counts match (a theme whose classes don't name its
 * blocks), pair by position instead and say so.
 *
 * @param {string[]} a Figma slugs.
 * @param {string[]} b Page slugs.
 * @return {{pairs: Array<[number, number]>, byOrder: boolean}} Index pairs.
 */
export function pairSections( a, b ) {
	const dp = Array.from( { length: a.length + 1 }, () => new Array( b.length + 1 ).fill( 0 ) );
	for ( let i = a.length - 1; i >= 0; i-- ) {
		for ( let j = b.length - 1; j >= 0; j-- ) {
			dp[ i ][ j ] = a[ i ] === b[ j ] ? dp[ i + 1 ][ j + 1 ] + 1 : Math.max( dp[ i + 1 ][ j ], dp[ i ][ j + 1 ] );
		}
	}
	const pairs = [];
	for ( let i = 0, j = 0; i < a.length && j < b.length; ) {
		if ( a[ i ] === b[ j ] ) {
			pairs.push( [ i++, j++ ] );
		} else if ( dp[ i + 1 ][ j ] >= dp[ i ][ j + 1 ] ) {
			i++;
		} else {
			j++;
		}
	}
	if ( a.length === b.length && pairs.length < a.length / 2 ) {
		return { pairs: a.map( ( s, i ) => [ i, i ] ), byOrder: true };
	}
	return { pairs, byOrder: false };
}

/**
 * Pair Figma sections with page sections and list the ones without a partner.
 *
 * @param {Array} figmaSections Figma sections.
 * @param {Array} pageSections  Page sections.
 * @return {Object} pairs, byOrder, the missing and extra sections, and moved: slugs that are both.
 */
export function pairStructure( figmaSections, pageSections ) {
	const { pairs, byOrder } = pairSections( figmaSections.map( ( s ) => s.slug ), pageSections.map( ( s ) => s.slug ) );
	const matchedF = new Set( pairs.map( ( [ i ] ) => i ) );
	const matchedP = new Set( pairs.map( ( [ , j ] ) => j ) );
	const missing = figmaSections.map( ( s, i ) => ( { index: i + 1, slug: s.slug, figma: s.name } ) ).filter( ( s, i ) => ! matchedF.has( i ) );
	const extra = pageSections.map( ( s, j ) => ( { index: j + 1, slug: s.slug } ) ).filter( ( s, j ) => ! matchedP.has( j ) );
	const moved = missing.filter( ( m ) => extra.some( ( e ) => e.slug === m.slug ) ).map( ( m ) => m.slug );
	return { pairs, byOrder, missing, extra, moved };
}

/** Overlap of two boxes, each grown by `t` px so near-misses still count. */
function iou( a, b, t ) {
	const ax1 = a.x - t;
	const ay1 = a.y - t;
	const ax2 = a.x + a.w + t;
	const ay2 = a.y + a.h + t;
	const bx1 = b.x - t;
	const by1 = b.y - t;
	const bx2 = b.x + b.w + t;
	const by2 = b.y + b.h + t;
	const iw = Math.max( 0, Math.min( ax2, bx2 ) - Math.max( ax1, bx1 ) );
	const ih = Math.max( 0, Math.min( ay2, by2 ) - Math.max( ay1, by1 ) );
	const inter = iw * ih;
	return inter / ( ( ax2 - ax1 ) * ( ay2 - ay1 ) + ( bx2 - bx1 ) * ( by2 - by1 ) - inter );
}

/** Share of a text's letters a token's value needs to stand for the text (as the extractors use). */
const TEXT_MAJORITY = 0.6;

/** The letters' case, as both extractors read it (see their caseOf): none under 3 letters. */
function caseOf( t ) {
	const letters = t.match( /\p{L}/gu ) || [];
	if ( letters.length < 3 ) {
		return undefined;
	}
	const upper = ( c ) => c === c.toUpperCase() && c !== c.toLowerCase();
	const lower = ( c ) => c === c.toLowerCase() && c !== c.toUpperCase();
	const words = t.split( /\s+/ ).map( ( w ) => w.match( /\p{L}/gu ) || [] ).filter( ( w ) => w.length );
	if ( letters.every( upper ) ) {
		return 'upper';
	}
	if ( letters.every( lower ) ) {
		return 'lower';
	}
	if ( words.every( ( w ) => upper( w[ 0 ] ) && w.slice( 1 ).every( lower ) ) ) {
		return 'title';
	}
	return upper( letters[ 0 ] ) && letters.slice( 1 ).every( lower ) ? 'sentence' : 'mixed';
}

/**
 * The style of page paragraphs merged into one text: each token by all their letters, as the
 * page extractor weighs one paragraph's runs, and the case of the whole.
 *
 * @param {Array} run Page text boxes, in order, with tally (letters per token value) and style.
 * @return {Object} Style.
 */
function mergedStyle( run ) {
	if ( ! run.every( ( b ) => b.tally ) ) {
		return run[ 0 ].style;
	}
	const letters = run.reduce( ( n, b ) => n + b.tally.letters, 0 );
	const style = {};
	for ( const key of Object.keys( run[ 0 ].tally ).filter( ( k ) => 'letters' !== k && 'text' !== k ) ) {
		const weights = new Map();
		for ( const b of run ) {
			for ( const [ v, n ] of b.tally[ key ] || [] ) {
				weights.set( v, ( weights.get( v ) || 0 ) + n );
			}
		}
		const [ best, most ] = [ ...weights ].reduce( ( a, b ) => ( b[ 1 ] > a[ 1 ] ? b : a ), [ undefined, -1 ] );
		if ( undefined !== best && letters && most / letters >= TEXT_MAJORITY ) {
			style[ key ] = best;
		}
	}
	if ( run[ 0 ].style?.align ) {
		style.align = run[ 0 ].style.align;
	}
	// The case of the paragraphs' text together, as the Figma layer holding them reads.
	if ( run.every( ( b ) => 'string' === typeof b.tally.text ) ) {
		const joined = caseOf( run.map( ( b ) => b.tally.text ).join( ' ' ) );
		if ( joined ) {
			style.case = joined;
		}
	}
	return style;
}

/**
 * One Figma text layer can hold several paragraphs the page renders as separate
 * elements. Merge a run of consecutive page text boxes whose joined text hashes to
 * an unmatched Figma text box, so granularity differences don't read as copy changes.
 *
 * @param {Array} fig Figma boxes.
 * @param {Array} pg  Page boxes (text boxes carry `full`, their whole normalised text).
 * @return {Array} Page boxes with merged runs.
 */
export function mergeTextRuns( fig, pg ) {
	const out = [ ...pg ];
	const pageHashes = new Set( pg.map( ( p ) => p.hash ).filter( Boolean ) );
	for ( const f of fig ) {
		if ( 'text' !== f.type || ! f.hash || pageHashes.has( f.hash ) ) {
			continue;
		}
		for ( let j = 0; j < out.length; j++ ) {
			// Figma keeps only a TEXT_PREFIX-character prefix, which can run past a short first paragraph.
			const prefix = f.text.trim();
			const n = out[ j ].full ? Math.min( prefix.length, out[ j ].full.length ) : 0;
			if ( 'text' !== out[ j ].type || ! n || out[ j ].full.slice( 0, n ) !== prefix.slice( 0, n ) ) {
				continue;
			}
			let joined = '';
			for ( let k = j; k < out.length && k - j < MAX_MERGED_PARAGRAPHS && 'text' === out[ k ].type; k++ ) {
				joined = joined ? `${ joined } ${ out[ k ].full }` : out[ k ].full;
				if ( k > j && hash( joined ) === f.hash ) {
					const run = out.slice( j, k + 1 );
					const x = Math.min( ...run.map( ( b ) => b.x ) );
					const y = Math.min( ...run.map( ( b ) => b.y ) );
					const w = Math.max( ...run.map( ( b ) => b.x + b.w ) ) - x;
					const h = Math.max( ...run.map( ( b ) => b.y + b.h ) ) - y;
					const merged = { type: 'text', x, y, w, h, full: joined, hash: f.hash, text: joined.slice( 0, TEXT_PREFIX ), mt: run[ 0 ].mt, mb: run[ run.length - 1 ].mb, style: mergedStyle( run ), style0: run[ 0 ].style0 };
					// The paragraphs' layout boxes together.
					if ( run.every( ( b ) => b.lw ) ) {
						merged.lx = Math.min( ...run.map( ( b ) => b.lx ) );
						merged.lw = Math.max( ...run.map( ( b ) => b.lx + b.lw ) ) - merged.lx;
					}
					out.splice( j, k - j + 1, merged );
					pageHashes.add( f.hash );
					j = out.length;
					break;
				}
			}
		}
	}
	return out;
}

/**
 * Boxes with stacked duplicates removed: the same type at the same position and size is one
 * visible element, whether it's drawn by one layer or several (a card's fill with an
 * overlay of the same size in Figma, a wrapper and its child on the page).
 *
 * @param {Array} boxes Boxes.
 * @return {Array} The first box of each position, size and type (and text, for text).
 */
export function uniqueBoxes( boxes ) {
	const seen = new Set();
	return boxes.filter( ( b ) => {
		const key = `${ b.type }|${ b.x }|${ b.y }|${ b.w }|${ b.h }|${ b.hash ?? '' }`;
		return ! seen.has( key ) && seen.add( key );
	} );
}

/**
 * Figma text layers the page renders as one text: a label and its required marker ("Email"
 * and "*" beside it) drawn as two layers, where the page has "Email *". Adjacent layers on
 * one line whose words, joined, are a page text's become one box, so they pair with it.
 *
 * @param {Array} fig Figma boxes.
 * @param {Array} pg  Page boxes (with `full` text).
 * @return {Array} Figma boxes, with such runs merged.
 */
export function mergeFigmaRuns( fig, pg ) {
	const pageHashes = new Set( pg.filter( ( p ) => 'text' === p.type && p.hash ).map( ( p ) => p.hash ) );
	// Only whole texts can be joined: a layer's text is kept to TEXT_PREFIX characters.
	const whole = ( b ) => 'text' === b.type && b.text && b.text.length < TEXT_PREFIX && ! pageHashes.has( b.hash );
	const out = [ ...fig ];
	for ( let i = 0; i < out.length; i++ ) {
		if ( ! whole( out[ i ] ) ) {
			continue;
		}
		const line = out.filter( ( b ) => whole( b ) && Math.abs( b.y - out[ i ].y ) <= 4 && b.x >= out[ i ].x ).sort( ( a, b ) => a.x - b.x );
		for ( let n = 2; n <= Math.min( 4, line.length ); n++ ) {
			const run = line.slice( 0, n );
			const adjacent = run.every( ( b, k ) => 0 === k || b.x - ( run[ k - 1 ].x + run[ k - 1 ].w ) <= 24 );
			const joined = normText( run.map( ( b ) => b.text ).join( ' ' ) );
			if ( adjacent && run[ 0 ] === out[ i ] && pageHashes.has( hash( joined ) ) ) {
				const x = Math.min( ...run.map( ( b ) => b.x ) );
				const y = Math.min( ...run.map( ( b ) => b.y ) );
				const merged = { ...run[ 0 ], x, y, w: Math.max( ...run.map( ( b ) => b.x + b.w ) ) - x, h: Math.max( ...run.map( ( b ) => b.y + b.h ) ) - y, hash: hash( joined ), text: joined.slice( 0, TEXT_PREFIX ) };
				out.splice( i, 1, merged );
				for ( const b of run.slice( 1 ) ) {
					out.splice( out.indexOf( b ), 1 );
				}
				break;
			}
		}
	}
	return out;
}

/**
 * Pair Figma and page boxes of the same type. Identical text pairs first at any
 * distance; those pairs then anchor the rest, so every other box is looked for where
 * its nearest anchor moved it. Large drift inside a section (e.g. vh-sized panels)
 * then reads as drift, not as elements missing in one place and extra in another.
 *
 * @param {Array}  fig Figma boxes.
 * @param {Array}  pg  Page boxes.
 * @param {number} t   Tolerance in px: boxes grow by this much when measuring overlap.
 * @return {{pairs: Array, missing: Array, extra: Array}} Pairs {f, p, overlap} and leftovers.
 */
export function matchBoxes( fig, pg, t ) {
	const centre = ( b ) => [ b.x + b.w / 2, b.y + b.h / 2 ];
	const usedF = new Set();
	const usedP = new Set();
	const pairs = [];
	const take = ( candidates ) => {
		candidates.sort( ( a, b ) => a.rank - b.rank );
		for ( const c of candidates ) {
			if ( usedF.has( c.i ) || usedP.has( c.j ) ) {
				continue;
			}
			usedF.add( c.i );
			usedP.add( c.j );
			pairs.push( { f: fig[ c.i ], p: pg[ c.j ], overlap: iou( fig[ c.i ], pg[ c.j ], t ) } );
		}
	};

	const textCandidates = [];
	fig.forEach( ( f, i ) => pg.forEach( ( p, j ) => {
		if ( 'text' === f.type && f.hash && f.hash === p.hash ) {
			const [ fx, fy ] = centre( f );
			const [ px, py ] = centre( p );
			textCandidates.push( { i, j, rank: Math.hypot( fx - px, fy - py ) } );
		}
	} ) );
	take( textCandidates );
	const anchors = pairs.map( ( m ) => ( { at: centre( m.f ), dx: m.p.x - m.f.x, dy: m.p.y - m.f.y } ) );

	const rest = [];
	fig.forEach( ( f, i ) => {
		if ( usedF.has( i ) ) {
			return;
		}
		const [ fx, fy ] = centre( f );
		let shift = { dx: 0, dy: 0 };
		let nearest = Infinity;
		for ( const a of anchors ) {
			const d = Math.hypot( a.at[ 0 ] - fx, a.at[ 1 ] - fy );
			if ( d < nearest ) {
				nearest = d;
				shift = a;
			}
		}
		const reach = Math.max( 120, 1.5 * Math.max( f.w, f.h ) );
		pg.forEach( ( p, j ) => {
			if ( usedP.has( j ) || f.type !== p.type ) {
				return;
			}
			const [ px, py ] = centre( p );
			const dist = Math.hypot( fx + shift.dx - px, fy + shift.dy - py );
			if ( dist <= reach ) {
				rest.push( { i, j, rank: dist } );
			}
		} );
	} );
	take( rest );

	// Last pass: a leftover Figma box and a leftover page box of the same kind and similar
	// size, anywhere in the section, are one element moved far (e.g. slider arrows placed
	// above the slides instead of beside them), not one missing and one extra.
	const similar = ( a, b ) => {
		const ratio = ( x, y ) => Math.min( x, y ) / Math.max( x, y );
		return ratio( a.w, b.w ) >= 0.5 && ratio( a.h, b.h ) >= 0.5;
	};
	const far = [];
	fig.forEach( ( f, i ) => {
		if ( usedF.has( i ) || 'text' === f.type ) {
			return;
		}
		pg.forEach( ( p, j ) => {
			if ( ! usedP.has( j ) && f.type === p.type && similar( f, p ) ) {
				far.push( { i, j, rank: Math.hypot( f.x - p.x, f.y - p.y ) } );
			}
		} );
	} );
	take( far );
	return { pairs, missing: fig.filter( ( f, i ) => ! usedF.has( i ) ), extra: pg.filter( ( p, j ) => ! usedP.has( j ) ) };
}

/**
 * How far (px) the nearest text with the same copy on both sides still says where a text with
 * different copy should be. Measured on edited-copy simulations: further off, its drift no
 * longer describes the text's, and right pairs start being dropped.
 */
export const COPY_CONTEXT = 360;

/**
 * Keep a pair of texts with different copy only where it is plausibly one element reworded.
 * The matcher pairs leftover texts by position within ~120px, so two different elements (a
 * "Company" label and a "File upload" one, a label and the hint under the next field) pair up
 * too and read as copy changes. A reworded element stays where its surroundings put it: its
 * top within a line of where the section's row alignment puts it, or of where the nearest text
 * with the same copy on both sides moved. One that is neither is a missing element and an extra
 * one. Either test alone drops real rewordings: rows can't follow two columns, and the nearest
 * text can drift differently.
 *
 * @param {Object}     match       matchBoxes() result.
 * @param {number[][]} anchors     anchorPoints() of the section.
 * @param {number}     figmaHeight Figma section height.
 * @param {number}     pageHeight  Page section height.
 * @param {number}     t           Tolerance in px: the least a line can be.
 * @return {Object} The match, with implausible copy pairs moved to missing and extra.
 */
export function trustCopy( match, anchors, figmaHeight, pageHeight, t ) {
	const reworded = ( m ) => 'text' === m.f.type && m.f.hash !== m.p.hash;
	const centre = ( b ) => [ b.x + b.w / 2, b.y + b.h / 2 ];
	const same = match.pairs.filter( ( m ) => 'text' === m.f.type && m.f.hash && m.f.hash === m.p.hash );
	const rows = alignRows( anchors, figmaHeight, pageHeight );
	const plausible = ( { f, p } ) => {
		const line = Math.max( t, Number.parseFloat( f.style?.lh ) || 1.2 * Number.parseFloat( f.style?.size ) || t );
		const overlaps = ( dx ) => Math.min( f.x + dx + f.w, p.x + p.w ) - Math.max( f.x + dx, p.x ) > 0;
		if ( overlaps( 0 ) && Math.abs( alignedRow( rows, 'page', p.y ) - alignedRow( rows, 'figma', f.y ) ) <= line ) {
			return true;
		}
		const [ fx, fy ] = centre( f );
		let near = null;
		let distance = Infinity;
		for ( const m of same ) {
			const [ ax, ay ] = centre( m.f );
			const d = Math.hypot( ax - fx, ay - fy );
			if ( d < distance ) {
				distance = d;
				near = m;
			}
		}
		// Nothing close says where it should be: the matcher's pairing stands.
		if ( ! near || distance > COPY_CONTEXT ) {
			return true;
		}
		return overlaps( near.p.x - near.f.x ) && Math.abs( p.y - ( f.y + near.p.y - near.f.y ) ) <= line;
	};
	const dropped = match.pairs.filter( ( m ) => reworded( m ) && ! plausible( m ) );
	return {
		pairs: match.pairs.filter( ( m ) => ! dropped.includes( m ) ),
		missing: [ ...match.missing, ...dropped.map( ( m ) => m.f ) ],
		extra: [ ...match.extra, ...dropped.map( ( m ) => m.p ) ],
	};
}

/**
 * Matched area weighted by overlap, over Figma's area plus unmatched page area. A section
 * Figma draws empty scores 1 only if the page adds nothing either.
 *
 * @param {Array}  fig   Figma boxes.
 * @param {Object} match matchBoxes() result.
 * @return {number} Score in [0, 1].
 */
export function sectionScore( fig, match, section = null ) {
	const area = ( b ) => b.w * b.h;
	const figArea = fig.reduce( ( s, b ) => s + area( b ), 0 );
	// A page background with no Figma box (Figma paints it as the frame's fill) covers the
	// section, and would outweigh everything matched; it isn't content on either side.
	// Covering the section where it is, not merely as large: a big photo hanging off one side is content.
	const covers = ( b ) => Math.min( b.x + b.w, section.w ) - Math.max( b.x, 0 ) >= BACKGROUND_SHARE * section.w && Math.min( b.y + b.h, section.h ) - Math.max( b.y, 0 ) >= BACKGROUND_SHARE * section.h;
	const extra = match.extra.filter( ( b ) => ! section || ! [ 'image', 'surface' ].includes( b.type ) || ! covers( b ) );
	const extraArea = extra.reduce( ( s, b ) => s + area( b ), 0 );
	if ( ! figArea ) {
		return extra.length ? 0 : 1;
	}
	return match.pairs.reduce( ( s, m ) => s + m.overlap * area( m.f ), 0 ) / ( figArea + extraArea );
}

/**
 * Space between a section's edges and its content, per side, as the CSS padding it would be:
 * the wireframe overlay shades it. Backgrounds (images or surfaces covering most of the
 * section) aren't content, and content is clipped to the section (off-screen slides and
 * overflow aren't where content visibly sits).
 *
 * Text counts with its vertical margins (`mt`, `mb`): Figma draws a heading's margin as its
 * Text Block's padding and the page as CSS margin, and where a theme drops the margin at a
 * section's edge (e.g. a last child's), it drops on the page side and the padding matches.
 *
 * @param {Array}  boxes  Section boxes.
 * @param {number} width  Section width.
 * @param {number} height Section height.
 * @return {{top: number, right: number, bottom: number, left: number}|null} Null when empty.
 */
export function paddingOf( boxes, width, height ) {
	const content = boxes
		.filter( ( b ) => ! background( b, { w: width, h: height } ) )
		.map( ( b ) => ( { ...b, x: Math.max( 0, b.x ), w: Math.min( width, b.x + b.w ) - Math.max( 0, b.x ) } ) )
		.filter( ( b ) => b.w > 0 );
	if ( ! content.length ) {
		return null;
	}
	const top = Math.min( ...content.map( ( b ) => b.y - ( b.mt || 0 ) ) );
	const left = Math.min( ...content.map( ( b ) => b.x ) );
	const bottom = Math.max( ...content.map( ( b ) => b.y + b.h + ( b.mb || 0 ) ) );
	const right = Math.max( ...content.map( ( b ) => b.x + b.w ) );
	return { top: Math.round( top ), right: Math.round( width - right ), bottom: Math.round( height - bottom ), left: Math.round( left ) };
}

/**
 * A box as reports carry it: type and geometry, plus the (shortened) copy of a text box.
 *
 * @param {Object} b Box.
 * @return {{type: string, x: number, y: number, w: number, h: number, text?: string}}
 */
export function element( b ) {
	const { type, x, y, w, h, text } = b;
	return 'text' === type ? { type, x, y, w, h, text } : { type, x, y, w, h };
}

/**
 * A box as one line of text: `text 126×23 at 745,127 "how we work"`.
 *
 * @param {Object} b Box or element().
 * @return {string}
 */
export const describe = ( b ) => `${ b.type } ${ b.w }×${ b.h } at ${ b.x },${ b.y }${ b.text ? ` "${ b.text }"` : '' }`;

/** How far a design token may differ before it counts: px for sizes, 0-255 per colour channel. */
const TOKEN_TOLERANCE = { size: 0.5, lh: 1, weight: 0, radius: 1, strokeWidth: 0.5, channel: 2, ls: 0.3 };

/** A font family as both sides name it: case, spaces and a variable font's suffix aside. */
const fontName = ( v ) => v.trim().toLowerCase().replace( /[\s_-]+(variable|vf)$/, '' ).replace( /[\s_-]+/g, '' );

const channels = ( hex ) => ( hex.match( /[0-9a-f]{2}/gi ) || [] ).map( ( c ) => parseInt( c, 16 ) );
const sameColor = ( a, b ) => {
	const [ ca, cb ] = [ channels( a ), channels( b ) ];
	// A missing alpha is opaque.
	return [ 0, 1, 2, 3 ].every( ( i ) => Math.abs( ( ca[ i ] ?? 255 ) - ( cb[ i ] ?? 255 ) ) <= TOKEN_TOLERANCE.channel );
};

/** Four values (corners clockwise from top-left, or sides from top) from one or four. */
const four = ( v ) => {
	const parts = String( v ).trim().split( /\s+/ );
	return 1 === parts.length ? [ parts[ 0 ], parts[ 0 ], parts[ 0 ], parts[ 0 ] ] : parts;
};

/** Four values back as one when they agree, as the extractors write them. */
const collapse = ( values ) => ( values.every( ( v ) => v === values[ 0 ] ) ? String( values[ 0 ] ) : values.join( ' ' ) );

/**
 * Corner radii as they draw on a box: radii that together overrun a side shrink by the same
 * factor, as CSS draws them. Both extractors do this, but a Figma file extracted before they did
 * records a pill as 999, so it's done again here with each side's own box.
 *
 * @param {string} radius Radius token.
 * @param {Object} b      The box it's on.
 * @return {string}
 */
export function fitRadius( radius, b ) {
	const [ tl, tr, br, bl ] = four( radius ).map( Number );
	const f = Math.min( 1, ...[ [ b.w, tl + tr ], [ b.w, bl + br ], [ b.h, tl + bl ], [ b.h, tr + br ] ].filter( ( [ , sum ] ) => sum > 0 ).map( ( [ side, sum ] ) => side / sum ) );
	return collapse( [ tl, tr, br, bl ].map( ( v ) => Math.round( v * f ) ) );
}

/** Whether a border token draws a line on any side. */
const bordered = ( v ) => four( v ).some( ( side ) => 'none' !== side && ! /^#[0-9a-f]{6}00\//i.test( side ) );

/** How far (px) a line may sit from an edge and still draw it; lines cover at least half of it. */
const EDGE_REACH = 3;

/**
 * Whether some line draws a box's edge: runs along it, within EDGE_REACH, over half its length.
 *
 * @param {Array}  lines Lines, section-relative {x, y, w, h}.
 * @param {Object} b     Box.
 * @param {number} side  0 top, 1 right, 2 bottom, 3 left.
 * @return {boolean}
 */
export function drawsEdge( lines, b, side ) {
	const horizontal = 0 === side || 2 === side;
	const at = [ b.y, b.x + b.w, b.y + b.h, b.x ][ side ];
	return lines.some( ( l ) => {
		const [ from, to ] = horizontal ? [ l.y, l.y + l.h ] : [ l.x, l.x + l.w ];
		const [ start, end, len ] = horizontal ? [ l.x, l.x + l.w, b.w ] : [ l.y, l.y + l.h, b.h ];
		const [ edgeStart, edgeEnd ] = horizontal ? [ b.x, b.x + b.w ] : [ b.y, b.y + b.h ];
		return from <= at + EDGE_REACH && to >= at - EDGE_REACH && Math.min( end, edgeEnd ) - Math.max( start, edgeStart ) >= len / 2;
	} );
}

/**
 * Whether two borders draw the same, side by side (see styleDiffs): both border a side alike,
 * neither does, or one does and the other draws that edge some other way (or can't be told).
 */
const sameBorders = ( figma, page, f, p, lines ) => {
	const [ sf, sp ] = [ four( figma ), four( page ) ];
	return sf.every( ( v, i ) => {
		const [ inFigma, onPage ] = [ bordered( v ), bordered( sp[ i ] ) ];
		if ( inFigma && onPage ) {
			return sameStroke( v, sp[ i ] );
		}
		if ( inFigma === onPage ) {
			return true;
		}
		if ( ! lines.figma || ! lines.page ) {
			return true;
		}
		return inFigma ? drawsEdge( lines.page, p, i ) : drawsEdge( lines.figma, f, i );
	} );
};

/** One side's border, `#rrggbb(aa)/<width>` or none; a fully transparent one is none. */
const sameStroke = ( a, b ) => {
	[ a, b ] = [ a, b ].map( ( v ) => ( /^#[0-9a-f]{6}00\//i.test( v ) ? 'none' : v ) );
	if ( 'none' === a || 'none' === b ) {
		return a === b;
	}
	const [ [ colorA, widthA ], [ colorB, widthB ] ] = [ a.split( '/' ), b.split( '/' ) ];
	return sameColor( colorA, colorB ) && Math.abs( Number( widthA ) - Number( widthB ) ) <= TOKEN_TOLERANCE.strokeWidth;
};

/**
 * Whether one design token has the same value on both sides, as the two sides spell it.
 *
 * @param {string} key Token name (see lib/figma.js).
 * @param {string} a   Figma value.
 * @param {string} b   Page value.
 * @return {boolean}
 */
export function sameToken( key, a, b ) {
	if ( 'font' === key ) {
		return fontName( a ) === fontName( b );
	}
	if ( 'align' === key || 'italic' === key || 'deco' === key || 'case' === key ) {
		return a.trim().toLowerCase() === b.trim().toLowerCase();
	}
	if ( 'color' === key || 'fill' === key ) {
		return sameColor( a, b );
	}
	// Borders side by side and radii corner by corner: a bottom-only divider isn't a full border.
	if ( 'stroke' === key ) {
		const [ sa, sb ] = [ four( a ), four( b ) ];
		return sa.every( ( v, i ) => sameStroke( v, sb[ i ] ) );
	}
	if ( 'radius' === key ) {
		const [ ca, cb ] = [ four( a ), four( b ) ];
		return ca.every( ( v, i ) => Math.abs( Number( v ) - Number( cb[ i ] ) ) <= TOKEN_TOLERANCE.radius );
	}
	return Math.abs( Number( a ) - Number( b ) ) <= ( TOKEN_TOLERANCE[ key ] ?? 0 );
}

const translucent = ( hex ) => 4 === channels( hex ).length && channels( hex )[ 3 ] < 255;

/**
 * Whether a token can be judged: set on both sides, and for a colour, either both or neither
 * translucent (a 5% black over an unknown backdrop can't be compared with an opaque grey).
 */
const comparable = ( key, a, b ) => undefined !== a && undefined !== b &&
	! ( ( 'color' === key || 'fill' === key ) && translucent( a ) !== translucent( b ) );

/**
 * The page style a Figma box compares with: a Figma text style from a file extracted before
 * styles were read from runs is its first character's, so the page's first character's.
 *
 * @param {Object} f Figma box.
 * @param {Object} p Page box.
 * @return {Object|undefined}
 */
const pageStyleFor = ( f, p ) => ( 'text' === f.type && ! f.style?.runs ? p.style0 ?? p.style : p.style );

/**
 * Design tokens that differ between paired boxes. Text is compared only where both say the
 * same thing: a pair with different copy may well be two different elements (a label paired
 * with a heading), whose tokens say nothing about each other.
 *
 * Borders are compared side by side. A side only one of them borders counts only where the
 * other draws no line along that edge at all: it may draw it as a divider element, a `::after`
 * rule or a box-shadow ring, none of which is a border (`lines`, what each side draws). Without
 * both sides' lines (a Figma file extracted before they were recorded, whose per-side borders
 * aren't reliable either) such a side isn't judged. `presence` compares them as borders only,
 * for an image's frame (see analyseSection).
 *
 * @param {Array}    pairs            matchBoxes() pairs.
 * @param {Function} hiddenFill       Whether a pair's fill is hidden (under an image on both sides).
 * @param {Object}   options          Comparison options.
 * @param {boolean}  options.presence Report a border one side lacks.
 * @param {Object}   options.lines    Lines each side draws: { figma, page }, section-relative.
 * @return {Array<{property: string, figma: string, page: string, element: Object}>}
 */
export function styleDiffs( pairs, hiddenFill = () => false, { presence = false, lines = {} } = {} ) {
	const diffs = [];
	for ( const m of pairs ) {
		const { f, p } = m;
		if ( 'text' === f.type && f.hash !== p.hash ) {
			continue;
		}
		const pageStyle = pageStyleFor( f, p );
		for ( const [ key, value ] of Object.entries( f.style || {} ) ) {
			if ( 'runs' === key ) {
				continue;
			}
			if ( 'fill' === key && hiddenFill( m ) ) {
				continue;
			}
			// A line's alignment shows only once text wraps; a single line sits where its box does.
			if ( 'align' === key && ! ( wrapped( f ) && wrapped( p ) ) ) {
				continue;
			}
			let [ figma, page ] = [ value, pageStyle?.[ key ] ];
			if ( 'stroke' === key && ! presence && ( undefined === page || sameBorders( figma, page, f, p, lines ) ) ) {
				continue;
			}
			if ( 'radius' === key && undefined !== page ) {
				[ figma, page ] = [ fitRadius( figma, f ), fitRadius( page, p ) ];
			}
			if ( comparable( key, figma, page ) && ! sameToken( key, figma, page ) ) {
				diffs.push( { property: key, figma, page, element: element( f ) } );
			}
		}
	}
	return diffs;
}

const TEXT_TOKENS = [ 'font', 'size', 'lh', 'weight', 'color' ];

/**
 * Text styles the design uses that no page text has, whatever the words: how a live section's
 * text is checked, since its copy (and so any pairing by copy) comes from the posts.
 *
 * @param {Array} figmaBoxes Figma boxes.
 * @param {Array} pageBoxes  Page boxes.
 * @return {Array<{property: string, figma: string, page: string, element: Object}>} One per
 *   missing style, with property `text-style` and the closest page style.
 */
export function missingTextStyles( figmaBoxes, pageBoxes ) {
	const texts = ( boxes ) => boxes.filter( ( b ) => 'text' === b.type && b.style );
	const same = ( a, b ) => TEXT_TOKENS.every( ( k ) => ! comparable( k, a[ k ], b[ k ] ) || sameToken( k, a[ k ], b[ k ] ) );
	const differing = ( a, b ) => TEXT_TOKENS.filter( ( k ) => comparable( k, a[ k ], b[ k ] ) && ! sameToken( k, a[ k ], b[ k ] ) ).length;
	const signature = ( st ) => TEXT_TOKENS.map( ( k ) => st[ k ] ?? '' ).join( '/' );
	const page = texts( pageBoxes );
	const seen = new Set();
	const missing = [];
	for ( const f of texts( figmaBoxes ) ) {
		const styleOf = ( p ) => pageStyleFor( f, p );
		if ( seen.has( signature( f.style ) ) || page.some( ( p ) => same( f.style, styleOf( p ) ) ) ) {
			continue;
		}
		seen.add( signature( f.style ) );
		const closest = page.reduce( ( best, p ) => ( ! best || differing( f.style, styleOf( p ) ) < differing( f.style, styleOf( best ) ) ? p : best ), null );
		missing.push( { property: 'text-style', figma: signature( f.style ), page: closest ? signature( styleOf( closest ) ) : '', element: element( f ) } );
	}
	return missing;
}

/**
 * How far a space may differ before it counts: a quarter of the design's space (a 4px gap off
 * by 4 is double; a 96px padding off by 4 is not), at least SPACING_FLOOR px for rounding, and
 * at most the tolerance.
 */
const SPACING_SHARE = 0.25;
const SPACING_FLOOR = 4;
export const spacingTolerance = ( space, t ) => Math.min( t, Math.max( SPACING_FLOOR, SPACING_SHARE * Math.abs( space ) ) );

const rect = ( x, y, w, h ) => ( { x: Math.round( x ), y: Math.round( y ), w: Math.max( 1, Math.round( w ) ), h: Math.max( 1, Math.round( h ) ) } );

/** Per edge of a container `c`: the space to box `b`, the margin facing it, and that space as a box. */
const EDGES = {
	top: { space: ( b, c ) => b.y - c.y, margin: 'mt', area: ( b, c ) => rect( b.x, c.y, b.w, b.y - c.y ) },
	bottom: { space: ( b, c ) => c.y + c.h - b.y - b.h, margin: 'mb', area: ( b, c ) => rect( b.x, b.y + b.h, b.w, c.y + c.h - b.y - b.h ) },
	left: { space: ( b, c ) => b.x - c.x, area: ( b, c ) => rect( c.x, b.y, b.x - c.x, b.h ) },
	right: { space: ( b, c ) => c.x + c.w - b.x - b.w, area: ( b, c ) => rect( b.x + b.w, b.y, c.x + c.w - b.x - b.w, b.h ) },
};

/** Per direction: the axis boxes follow each other along, and the margins between them. */
const AXES = {
	vertical: { pos: 'y', size: 'h', cross: 'x', crossSize: 'w', margins: [ 'mb', 'mt' ] },
	horizontal: { pos: 'x', size: 'w', cross: 'y', crossSize: 'h', margins: [] },
};

/** How much of a space is the margin facing it: none of a space the margin doesn't fit in. */
const marginIn = ( b, key, space ) => ( key ? Math.max( 0, Math.min( b[ key ] || 0, space ) ) : 0 );

/**
 * Spacing that differs: every visible space between elements the two sides share, as the
 * difference someone sees, however each side builds it. Figma spaces a column with auto-layout
 * gaps and Text Block padding, CSS with margins that collapse and padding; the visible space is
 * what both must agree on, and the margins are reported alongside to say where to fix it.
 *
 * - between: two elements next to each other (above and below, or side by side) with nothing
 *   between them on either side.
 * - inside:  an element's edge and the content nearest it within (a card's padding).
 * - edge:    the section's edge and the content nearest it.
 *
 * A space is compared only where the same element bounds it on both sides: where one side has
 * something else there, the space measures that, and the element is reported on its own. Nor
 * is a page space that changes with the viewport's height (page boxes measured at a taller
 * viewport carry `alt`): a 100vh slide's spacing isn't a design value.
 *
 * @param {Object}   o           Section, as analyseSection() sees it.
 * @param {Array}    o.fig       Figma boxes.
 * @param {Array}    o.page      Page boxes.
 * @param {Array}    o.reliable  Pairs to measure between and inside.
 * @param {Array}    o.atEdges   Pairs to measure to the section's edges.
 * @param {Object}   o.sections  Each side's section box: { figma, page }.
 * @param {Function} o.asElement The Figma element a box stands for (an image for its frame).
 * @param {number}   o.t         Tolerance.
 * @return {Array} One entry per differing space: where, side or axis, the bounding elements,
 *   both spaces, the margins in them (`from`: the first element's, `to`: the second's) and
 *   the space on each side as a box.
 */
export function spacingDiffs( { fig, page, reliable, atEdges, sections, asElement, t } ) {
	const out = [];
	const differs = ( s ) => Math.abs( s.page - s.figma ) > spacingTolerance( s.figma, t );
	const add = ( s ) => differs( s ) && out.push( s );
	// Whether a page measure between boxes changes with the viewport's height.
	const moves = ( measure, ...boxes ) => boxes.every( ( b ) => b.alt ) && Math.abs( measure( ...boxes.map( ( b ) => b.alt ) ) - measure( ...boxes ) ) > 1;

	// The same element nearest one edge of a container on both sides, and the space to it.
	const inset = ( side, [ figContent, pageContent ], [ fc, pc ], pairs ) => {
		if ( ! figContent.length || ! pageContent.length ) {
			return null;
		}
		const e = EDGES[ side ];
		// Everything as near as the nearest, give or take a pixel: two columns start level.
		const nearest = ( boxes, c ) => {
			const least = Math.min( ...boxes.map( ( b ) => e.space( b, c ) ) );
			return boxes.filter( ( b ) => e.space( b, c ) <= least + 1 );
		};
		const pageNearest = nearest( pageContent, pc );
		let f, p, pair;
		for ( f of nearest( figContent, fc ) ) {
			pair = pairs.find( ( m ) => m.f === asElement( f ) );
			// The page's nearest may be part of the pair's page element (merged paragraphs).
			p = pair && pageNearest.find( ( b ) => inside( b, pair.p ) );
			if ( p ) {
				break;
			}
		}
		if ( ! p || moves( e.space, p, pc ) || ragged( f )[ side ] || ragged( p )[ side ] ) {
			return null;
		}
		const [ figma, pg ] = [ e.space( f, fc ), e.space( p, pc ) ];
		return {
			side,
			from: element( pair.f ),
			figma: Math.round( figma ),
			page: Math.round( pg ),
			margins: { figma: { from: marginIn( f, e.margin, figma ) }, page: { from: marginIn( p, e.margin, pg ) } },
			area: { figma: e.area( f, fc ), page: e.area( p, pc ) },
		};
	};

	// Section edges: to the content, not a background behind it.
	const content = ( boxes, c ) => boxes.filter( ( b ) => ! background( b, c ) );
	for ( const side of Object.keys( EDGES ) ) {
		const s = inset( side, [ content( fig, sections.figma ), content( page, sections.page ) ], [ sections.figma, sections.page ], atEdges );
		if ( s ) {
			add( { where: 'edge', ...s } );
		}
	}

	// Containers: from a surface's or image's edges to what lies within it.
	const within = ( boxes, c ) => boxes.filter( ( b ) => b !== c && inside( b, c ) && ! inside( c, b ) );
	// A section's background holds all of it: the space inside it is the space to the edge.
	const holders = reliable.filter( ( r ) => ( 'surface' === r.f.type || 'image' === r.f.type ) && ! background( r.f, sections.figma ) && ! background( r.p, sections.page ) );
	for ( const m of holders ) {
		for ( const side of Object.keys( EDGES ) ) {
			const s = inset( side, [ within( fig, m.f ), within( page, m.p ) ], [ m.f, m.p ], reliable );
			if ( s ) {
				add( { where: 'inside', ...s, container: element( m.f ) } );
			}
		}
	}

	// Neighbours: b follows a along the axis, they overlap across it, and nothing else (but
	// what holds both) lies in the space between. Something holding one of them (the circle
	// around an icon, the card around a text) is in that space: the space runs to it.
	for ( const [ axis, { pos, size, cross, crossSize, margins: [ before, after ] } ] of Object.entries( AXES ) ) {
		const overlap = ( a, b ) => Math.min( a[ cross ] + a[ crossSize ], b[ cross ] + b[ crossSize ] ) - Math.max( a[ cross ], b[ cross ] );
		const gap = ( a, b ) => b[ pos ] - a[ pos ] - a[ size ];
		const between = ( a, b ) => ( { [ pos ]: a[ pos ] + a[ size ], [ size ]: gap( a, b ), [ cross ]: Math.max( a[ cross ], b[ cross ] ), [ crossSize ]: overlap( a, b ) } );
		const area = ( a, b ) => {
			const r = between( a, b );
			return rect( r.x, r.y, r.w, r.h );
		};
		const clear = ( boxes, a, b ) => {
			const r = between( a, b );
			return r.w <= 0 || r.h <= 0 || ! boxes.some( ( o ) => o !== a && o !== b && ! ( inside( a, o ) && inside( b, o ) ) &&
				o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h > r.y );
		};
		for ( const a of reliable ) {
			for ( const b of reliable ) {
				// Following in Figma (touching counts), still following and overlapping across on the
				// page (not rearranged), and nothing between them on either side.
				if ( a === b || gap( a.f, b.f ) < -1 || overlap( a.f, b.f ) <= 0 || b.p[ pos ] <= a.p[ pos ] || overlap( a.p, b.p ) <= 0 || ! clear( fig, a.f, b.f ) || ! clear( page, a.p, b.p ) ) {
					continue;
				}
				// Wrapped text's uneven side isn't an edge to measure from.
				const unevenFacing = 'horizontal' === axis && ( ragged( a.f ).right || ragged( a.p ).right || ragged( b.f ).left || ragged( b.p ).left );
				if ( unevenFacing || moves( gap, a.p, b.p ) ) {
					continue;
				}
				const [ figma, pg ] = [ gap( a.f, b.f ), gap( a.p, b.p ) ];
				add( {
					where: 'between',
					axis,
					from: element( a.f ),
					to: element( b.f ),
					figma: Math.round( figma ),
					page: Math.round( pg ),
					margins: {
						figma: { from: marginIn( a.f, before, figma ), to: marginIn( b.f, after, figma ) },
						page: { from: marginIn( a.p, before, pg ), to: marginIn( b.p, after, pg ) },
					},
					area: { figma: area( a.f, b.f ), page: area( a.p, b.p ) },
				} );
			}
		}
	}
	return out;
}

/**
 * Compare one Figma section with its page section, box by box.
 *
 * @param {Object}  figma           Figma section: height and boxes.
 * @param {Object}  page            Page section: height and boxes.
 * @param {Object}  options         Comparison settings.
 * @param {number}  options.tolerance Px differences at or under this are ignored.
 * @param {boolean} options.live    Content comes from live posts: text, and boxes sized by it,
 *                                  aren't expected to match; only the template is compared.
 * @param {number}  options.width   Section width (the breakpoint).
 * @return {Object} The match, its score, and what differs: missing and extra elements, copy,
 *   sideways shifts, overall drift, spacing, the largest per-element offsets and design tokens;
 *   and the sync points that line the section's rows up for the pixel diff.
 */
export function analyseSection( figma, page, { tolerance: t, sizeTolerance = t, live, width } ) {
	const fig = mergeFigmaRuns( figma.boxes, page.boxes );
	const pageBoxes = mergeTextRuns( fig, page.boxes );
	const matched = matchBoxes( fig, pageBoxes, t );
	// In a live section the posts decide the text and everything sized by it: a surface holding
	// text (a card, a tag pill, a button) grows with titles and term names, and there are as
	// many as the posts have. Only the rest (images, icons, empty surfaces, padding) is the
	// template, so only it is compared.
	const template = ( boxes ) => ( b ) => ! live || ( 'text' !== b.type && ! ( 'surface' === b.type && boxes.some( ( o ) => 'text' === o.type && inside( o, b ) ) ) );
	const inFigmaTemplate = template( fig );
	const inPageTemplate = template( page.boxes );
	const median = ( values ) => {
		const v = [ ...values ].sort( ( a, b ) => a - b );
		return v.length ? v[ Math.floor( v.length / 2 ) ] : 0;
	};
	// An element cut off (by a carousel, the frame's edge) shows only part of itself, so its
	// size and shape aren't comparable.
	const cutOff = ( b ) => b.clipped || b.x < 0 || b.x + b.w > width;
	const sameWords = ( m ) => ! ( 'text' === m.f.type && m.f.hash !== m.p.hash );
	// Elements known to be the same on both sides: whole, part of the template, and for text, the
	// same words. They say which rows correspond (a text occurring once on each side can't have
	// been matched to the wrong copy), and space is compared between them.
	const reliable = matched.pairs.filter( ( m ) => ! cutOff( m.f ) && ! cutOff( m.p ) && inFigmaTemplate( m.f ) && sameWords( m ) );
	const once = ( boxes, h ) => 1 === boxes.filter( ( b ) => 'text' === b.type && b.hash === h ).length;
	const anchors = anchorPoints( reliable.map( ( m ) => ( { ...m, unique: 'text' === m.f.type && once( fig, m.f.hash ) && once( pageBoxes, m.p.hash ) } ) ), figma.height, page.height );
	// A live section's copy comes from the posts: its texts are paired by position on purpose.
	const match = live ? matched : trustCopy( matched, anchors, figma.height, page.height, t );
	const whole = match.pairs.filter( ( m ) => ! cutOff( m.f ) && ! cutOff( m.p ) );
	const offsets = match.pairs
		// A text's size follows its words, so it's only compared where both say the same thing.
		.filter( ( m ) => inFigmaTemplate( m.f ) && ! ( 'text' === m.f.type && m.f.hash !== m.p.hash ) )
		.filter( ( m ) => ! cutOff( m.f ) && ! cutOff( m.p ) )
		.map( ( m ) => ( { ...m, dx: m.p.x - m.f.x, dy: m.p.y - m.f.y, dw: widthChange( m ), dh: m.p.h - m.f.h } ) )
		// Kept when it moved or resized; a box resized in place counts from its own tolerance.
		.filter( ( m ) => Math.max( Math.abs( m.dx ), Math.abs( m.dy ), Math.abs( m.dw ), Math.abs( m.dh ) ) > t || resizedBy( m, t, sizeTolerance ) )
		// Elements that changed size first: only they become defects, and what a resized element
		// pushes down (moved, so overlapping least) would otherwise take the report's places.
		// Resized first, the largest change first (so a card twice as wide outranks inputs 4px
		// taller); then what moved, least overlap first.
		.sort( ( a, b ) => ( resizedBy( b, t, sizeTolerance ) - resizedBy( a, t, sizeTolerance ) )
			|| ( resizedBy( a, t, sizeTolerance ) ? sizeChange( b ) - sizeChange( a ) : a.overlap - b.overlap ) )
		.slice( 0, MAX_OFFSETS )
		.map( ( m ) => ( {
			figma: element( m.f ), page: element( m.p ), dx: m.dx, dy: m.dy, dw: m.dw, dh: m.dh,
			// Wrapped text's width change is its layout box's.
			...( ( wrapped( m.f ) || wrapped( m.p ) ) && m.f.lw && m.p.lw ? { textBox: { figma: m.f.lw, page: m.p.lw } } : {} ),
		} ) );
	const copy = live ? [] : match.pairs.filter( ( m ) => 'text' === m.f.type && m.f.hash !== m.p.hash ).map( ( m ) => ( { figma: element( m.f ), page: element( m.p ) } ) );
	// Same size, moved sideways: an alignment difference on that element (e.g. centred vs left).
	const shifted = match.pairs
		.filter( ( m ) => inFigmaTemplate( m.f ) && ! ragged( m.f ).left && ! ragged( m.p ).left )
		.filter( ( m ) => Math.abs( m.p.x - m.f.x ) >= ALIGNMENT_SHIFT && Math.abs( m.p.w - m.f.w ) <= 2 * t && Math.abs( ( m.p.x + m.p.w / 2 ) - ( m.f.x + m.f.w / 2 ) ) >= ALIGNMENT_SHIFT )
		.map( ( m ) => ( { figma: element( m.f ), page: element( m.p ), dx: m.p.x - m.f.x } ) );
	// Consistent drift across all matched boxes: sideways means alignment, vertical means spacing.
	const drift = {
		dx: median( match.pairs.map( ( m ) => m.p.x - m.f.x ) ),
		dy: median( match.pairs.map( ( m ) => m.p.y - m.f.y ) ),
		resized: match.pairs.filter( ( m ) => Math.abs( m.p.w - m.f.w ) > t || Math.abs( m.p.h - m.f.h ) > t ).length,
	};
	// A Figma surface exactly behind a paired image is that image's frame (a border, a radius),
	// not an element of its own: where the page has no frame there, it's the frame's style that
	// differs. Its fill is under the image either way.
	const covered = ( b, boxes ) => boxes.some( ( o ) => 'image' === o.type && o !== b && inside( b, o ) && inside( o, b ) );
	const framing = ( b ) => match.pairs.find( ( m ) => 'image' === m.f.type && inside( b, m.f ) && inside( m.f, b ) );
	const frames = match.missing.filter( ( b ) => 'surface' === b.type && framing( b ) );
	// The frame's border is drawn over the photo, so it is the image's border, compared with the
	// page image's (a page wrapper with a border is larger than the photo, so it pairs with the
	// frame as a surface instead, and the frame isn't here). Where the frame has none (a fill
	// behind the photo), the image's own stands. Its corners are the image's as extracted (its
	// own, or those of the frames that clip it): a frame that doesn't clip doesn't round the photo,
	// and an image from a file extracted before images had corners has none to compare.
	const framed = new Set( frames.map( ( b ) => framing( b ) ) );
	const frameStyles = frames.flatMap( ( b ) => {
		const m = framing( b );
		// A cut-off photo shows only part of its corners and border, as a cut-off surface does.
		if ( cutOff( b ) || cutOff( m.f ) || cutOff( m.p ) ) {
			return [];
		}
		const stroke = undefined !== b.style?.stroke && bordered( b.style.stroke ) ? b.style.stroke : m.f.style?.stroke;
		const style = Object.fromEntries( Object.entries( { radius: m.f.style?.radius, stroke } ).filter( ( [ , v ] ) => undefined !== v ) );
		// A page image without a border token (a background image drawn smaller than its box) has none.
		const p = { ...m.p, style: { ...m.p.style, stroke: m.p.style?.stroke ?? 'none' } };
		return styleDiffs( [ { f: { ...b, style }, p } ], () => false, { presence: true } );
	} );
	// An image's frame stands for the image it frames.
	const asElement = ( b ) => ( frames.includes( b ) ? framing( b ).f : b );
	// At a section's edge a live section's text counts too: the posts change its words, not
	// where it starts.
	const spacing = spacingDiffs( {
		fig, page: pageBoxes, t, asElement,
		reliable,
		atEdges: whole.filter( ( m ) => live || sameWords( m ) ),
		sections: {
			figma: { x: 0, y: 0, w: width, h: figma.height },
			page: { x: 0, y: 0, w: width, h: page.height, ...( page.altHeight ? { alt: { x: 0, y: 0, w: width, h: page.altHeight } } : {} ) },
		},
	} );
	const missing = match.missing.filter( ( b ) => inFigmaTemplate( b ) && ! frames.includes( b ) );
	const drawnLines = { figma: figma.lines, page: page.lines };
	// A fill under an image that covers it, on both sides, can't be seen.
	const hiddenFill = ( m ) => 'surface' === m.f.type && covered( m.f, fig ) && covered( m.p, pageBoxes );
	return {
		match,
		score: sectionScore( fig, match, { w: width, h: page.height } ),
		structural: missing,
		missing: missing.map( element ),
		extra: match.extra.filter( inPageTemplate ).map( element ),
		copy,
		shifted,
		drift,
		anchors,
		spacing,
		offsets,
		// Tokens are the template itself, so live sections compare them too: surfaces as paired,
		// text by the styles it uses, since posts change its copy.
		// A cut-off element's corners and edges may be hidden, and its pairing rests on a
		// fragment, so its tokens aren't compared either.
		styles: [
			...frameStyles,
			...( live
				? [ ...styleDiffs( whole.filter( ( m ) => 'text' !== m.f.type && ! framed.has( m ) ), hiddenFill, { lines: drawnLines } ), ...missingTextStyles( fig, page.boxes ) ]
				: styleDiffs( whole.filter( ( m ) => ! framed.has( m ) ), hiddenFill, { lines: drawnLines } ) ),
		],
	};
}
