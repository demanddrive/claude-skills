/**
 * Lining up a Figma section's rows with its page section's, the way a side-by-side text diff
 * lines up two files.
 *
 * Elements matched on both sides are the sync points: an element's top on one side is its top
 * on the other. Between two sync points rows pair one for one, and where one side has more
 * rows (more space, an extra form field, text wrapping to another line) the other side gets a
 * gap. Both sections stay whole, whatever their heights: no single offset can line up a
 * section whose content drifts further the lower it is, and one that tries cuts off its top.
 */

/**
 * Shift changes (px) that don't open a gap. A text box's top sits a pixel or two differently
 * in Figma and the browser (line-height handling); pixel-diff refines what is left over.
 */
export const BAND_TOLERANCE = 3;

/** The longest chain of points strictly increasing on both sides; on a tie, the steadier shift. */
function longestChain( points ) {
	const length = points.map( () => 1 );
	const prev = points.map( () => -1 );
	const shift = ( k ) => points[ k ][ 1 ] - points[ k ][ 0 ];
	for ( let i = 0; i < points.length; i++ ) {
		for ( let j = 0; j < i; j++ ) {
			if ( points[ j ][ 0 ] >= points[ i ][ 0 ] || points[ j ][ 1 ] >= points[ i ][ 1 ] ) {
				continue;
			}
			const steadier = length[ j ] + 1 === length[ i ] && Math.abs( shift( j ) - shift( i ) ) < Math.abs( shift( prev[ i ] ) - shift( i ) );
			if ( length[ j ] + 1 > length[ i ] || steadier ) {
				length[ i ] = length[ j ] + 1;
				prev[ i ] = j;
			}
		}
	}
	let end = -1;
	for ( let i = 0; i < points.length; i++ ) {
		if ( -1 === end || length[ i ] > length[ end ] ) {
			end = i;
		}
	}
	const chain = [];
	for ( let k = end; -1 !== k; k = prev[ k ] ) {
		chain.unshift( points[ k ] );
	}
	return chain;
}

/**
 * Sync points from matched elements: each one's top and bottom, as [figma row, page row].
 *
 * Chosen the way patience diff chooses lines. Elements that occur once on each side (a
 * heading, a paragraph: `unique` pairs) anchor first, the longest chain of them running in the
 * same order on both sides. Repeated ones (the same bullet or button in every card) can be
 * matched into the wrong card, so they only fill in between two neighbouring anchors, and only
 * where they fall between them on both sides. An element matched far away (arrows moved above
 * a slider) is dropped the same way.
 *
 * @param {Array}  pairs        Matched elements {f, p, unique}, section-relative boxes (x, y, w, h).
 * @param {number} figmaHeight  Figma section height.
 * @param {number} pageHeight   Page section height.
 * @return {number[][]} Points [f, p], strictly increasing on both sides, inside both sections.
 */
export function anchorPoints( pairs, figmaHeight, pageHeight ) {
	const points = ( subset ) => {
		const seen = new Set();
		return subset
			.flatMap( ( { f, p } ) => [ [ f.y, p.y ], [ f.y + f.h, p.y + p.h ] ] )
			.map( ( [ f, p ] ) => [ Math.round( f ), Math.round( p ) ] )
			.filter( ( [ f, p ] ) => f > 0 && p > 0 && f < figmaHeight && p < pageHeight )
			.filter( ( [ f, p ] ) => ! seen.has( `${ f },${ p }` ) && seen.add( `${ f },${ p }` ) )
			.sort( ( a, b ) => a[ 0 ] - b[ 0 ] || a[ 1 ] - b[ 1 ] );
	};
	const anchors = longestChain( points( pairs.filter( ( m ) => m.unique ) ) );
	const repeated = points( pairs.filter( ( m ) => ! m.unique ) );
	const bounds = [ [ 0, 0 ], ...anchors, [ figmaHeight, pageHeight ] ];
	const chain = [];
	for ( let k = 1; k < bounds.length; k++ ) {
		const [ [ f0, p0 ], [ f1, p1 ] ] = [ bounds[ k - 1 ], bounds[ k ] ];
		chain.push( ...longestChain( repeated.filter( ( [ f, p ] ) => f > f0 && f < f1 && p > p0 && p < p1 ) ) );
		if ( k < bounds.length - 1 ) {
			chain.push( bounds[ k ] );
		}
	}
	return chain;
}

/**
 * The row alignment: segments in order, each `length` rows starting at aligned row `at`, from
 * Figma row `figma` and page row `page`. A null side is a gap: rows only the other side has.
 *
 * The section tops and bottoms are sync points too. Between two sync points the rows pair from
 * the first, and the longer side's extra rows come last, just before the next point. A point
 * whose shift is within `tolerance` of the last one kept opens no gap.
 *
 * @param {number[][]} anchors     anchorPoints() of the section; [] aligns the tops.
 * @param {number}     figmaHeight Figma section height (rows).
 * @param {number}     pageHeight  Page section height (rows).
 * @param {number}     tolerance   Shift change (px) that opens a gap.
 * @return {Array<{at: number, figma: (number|null), page: (number|null), length: number}>}
 */
export function alignRows( anchors, figmaHeight, pageHeight, tolerance = BAND_TOLERANCE ) {
	const [ hf, hp ] = [ Math.round( figmaHeight ), Math.round( pageHeight ) ];
	const kept = [ [ 0, 0 ] ];
	for ( const [ f, p ] of anchors ) {
		const [ lf, lp ] = kept[ kept.length - 1 ];
		if ( f > lf && p > lp && f < hf && p < hp && Math.abs( ( p - f ) - ( lp - lf ) ) > tolerance ) {
			kept.push( [ f, p ] );
		}
	}
	kept.push( [ hf, hp ] );
	const segments = [];
	let at = 0;
	const add = ( figma, page, length ) => {
		if ( length <= 0 ) {
			return;
		}
		const last = segments[ segments.length - 1 ];
		const continues = last && ( null === figma ) === ( null === last.figma ) && ( null === page ) === ( null === last.page ) &&
			( null === figma || figma === last.figma + last.length ) && ( null === page || page === last.page + last.length );
		if ( continues ) {
			last.length += length;
		} else {
			segments.push( { at, figma, page, length } );
		}
		at += length;
	};
	for ( let k = 1; k < kept.length; k++ ) {
		const [ f0, p0 ] = kept[ k - 1 ];
		const [ f1, p1 ] = kept[ k ];
		const common = Math.min( f1 - f0, p1 - p0 );
		add( f0, p0, common );
		add( f0 + common, null, f1 - f0 - common );
		add( null, p0 + common, p1 - p0 - common );
	}
	return segments;
}

/** Rows in the alignment. */
export const alignedHeight = ( segments ) => segments.reduce( ( n, s ) => n + s.length, 0 );

/**
 * The aligned row showing one side's row y. A row past that side's last is placed after it.
 *
 * @param {Array}           segments alignRows() result.
 * @param {'figma'|'page'}  side     Which side y is on.
 * @param {number}          y        Row on that side.
 * @return {number} Aligned row.
 */
export function alignedRow( segments, side, y ) {
	let last = 0;
	for ( const s of segments ) {
		if ( null === s[ side ] ) {
			continue;
		}
		if ( y < s[ side ] ) {
			return s.at;
		}
		if ( y < s[ side ] + s.length ) {
			return s.at + y - s[ side ];
		}
		last = s.at + s.length;
	}
	return last;
}

/**
 * A box on one side, placed in the alignment: its top and bottom rows mapped, so a gap
 * opening inside it stretches it.
 *
 * @param {Array}          segments alignRows() result.
 * @param {'figma'|'page'} side     Which side the box is on.
 * @param {Object}         box      Section-relative box: y and h (other fields are kept).
 * @return {Object} The box with y and h in aligned rows.
 */
export function alignedBox( segments, side, box ) {
	const y = alignedRow( segments, side, box.y );
	const bottom = box.h > 0 ? alignedRow( segments, side, box.y + box.h - 1 ) + 1 : y;
	return { ...box, y, h: bottom - y };
}

/**
 * Each aligned row's source rows: [figma row or -1, page row or -1].
 *
 * @param {Array} segments alignRows() result.
 * @return {Int32Array[]} [figmaRows, pageRows], one entry per aligned row.
 */
export function rowSources( segments ) {
	const n = alignedHeight( segments );
	const figma = new Int32Array( n ).fill( -1 );
	const page = new Int32Array( n ).fill( -1 );
	for ( const s of segments ) {
		for ( let k = 0; k < s.length; k++ ) {
			if ( null !== s.figma ) {
				figma[ s.at + k ] = s.figma + k;
			}
			if ( null !== s.page ) {
				page[ s.at + k ] = s.page + k;
			}
		}
	}
	return [ figma, page ];
}
