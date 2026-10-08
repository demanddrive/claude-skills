/**
 * The Figma side: reduce a frame to typed boxes, and read them back.
 *
 * One extractor serves both ways of reaching Figma: figma-rest.js calls extractBoxes() on a
 * node from the REST API, and figmaScript() prints the same function for the Figma MCP's
 * use_figma tool to run inside Figma. Its output, figma-boxes.txt, has one line per item:
 *
 *   F|<width>|<height>                         the frame
 *   S|<index>|<name>|<y>|<height>|<lines>      a top-level section, in visual order; lines is 1
 *                                              when its L lines were recorded (files from
 *                                              before have none, so what they draw is unknown)
 *   B|<section>|<type>|x|y|w|h|<hash>|<text>|<mt>|<mb>|<style>|<cut>
 *                                              a box, section-relative; hash, text and the
 *                                              top/bottom margins for text only; style for
 *                                              text and surfaces; cut is 1 when a frame that
 *                                              clips its content hides part of the box (the
 *                                              box is then its visible part)
 *
 *   L|<section>|x|y|w|h                         a line the section draws, section-relative:
 *                                              any stroke's side, a LINE, a thin fill or a
 *                                              tight shadow, whatever it belongs to
 *   P|<part>|<parts>                           ends one part of a file use_figma returned in
 *                                              parts (see pagePart); joined, they are the file
 *
 * Box types are text, image, icon and surface. The style field holds design tokens as
 * key=value pairs separated by semicolons: text has font, size, lh (line-height, px), weight
 * and color; a surface has fill, radius and stroke (<color>/<width>), where set.
 */

import fs from 'node:fs';

/** Characters of each text box kept in figma-boxes.txt and reports; the hash covers all of it. */
export const TEXT_PREFIX = 28;

/**
 * Text as both sides compare it: typographic quotes and dashes folded, whitespace collapsed.
 *
 * @param {string} s Text.
 * @return {string}
 */
export const normText = ( s ) => s.normalize( 'NFKD' ).replace( /[‘’]/g, "'" ).replace( /[“”]/g, '"' ).replace( /[–—]/g, '-' ).replace( /\s+/g, ' ' ).trim().toLowerCase();

/**
 * A short, stable hash of normalised text (djb2), so copy compares without storing it all.
 *
 * @param {string} s Normalised text.
 * @return {string} Hex hash.
 */
export const hash = ( s ) => {
	let h = 5381;
	for ( let i = 0; i < s.length; i++ ) {
		h = ( ( h * 33 ) ^ s.charCodeAt( i ) ) >>> 0;
	}
	return h.toString( 16 );
};

/**
 * figma-boxes.txt for a frame node, from either Figma API.
 *
 * Runs in Node (REST) and inside Figma (printed by figmaScript), so it uses nothing but its
 * arguments, TEXT_PREFIX, normText and hash. The two APIs differ only in defaults: REST
 * leaves out `visible` and `opacity` when they are true and 1, and the plugin API reports
 * mixed paints as a symbol rather than an array.
 *
 * @param {Object}  frame           Frame node.
 * @param {Object}  options         Extraction options.
 * @param {string}  options.ignore  Pattern of top-level layers that aren't sections.
 * @param {boolean} options.section Treat the node as one section (a single block).
 * @return {string} figma-boxes.txt content.
 */
export function extractBoxes( frame, { ignore, section } ) {
	if ( ! frame?.absoluteBoundingBox ) {
		throw new Error( `Figma node ${ frame?.id ?? '(not found)' } is not a frame on the canvas; pass the page frame or the section's node id.` );
	}
	const ICON_MAX = 64;
	const VECTORS = [ 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'ELLIPSE' ];
	const IGNORE = new RegExp( ignore, 'i' );
	const fb = frame.absoluteBoundingBox;
	const r = Math.round;
	// The plugin API throws on a property a node doesn't have (REST's `style`, a group's
	// `fills` or `layoutMode`, a rectangle's `children`), so anything only some nodes or one
	// API has is read through prop().
	const prop = ( n, key ) => ( n && key in n ? n[ key ] : undefined );
	const paints = ( list ) => ( Array.isArray( list ) ? list : [] );
	const visible = ( n ) => false !== n.visible && ( n.opacity ?? 1 ) >= 0.01;
	const hasImage = ( n ) => paints( prop( n, 'fills' ) ).some( ( p ) => 'IMAGE' === p.type && false !== p.visible );
	const filled = ( n ) => paints( prop( n, 'fills' ) ).some( ( p ) => 'SOLID' === p.type && false !== p.visible && ( p.opacity ?? 1 ) > 0.01 );
	const stroked = ( n ) => paints( prop( n, 'strokes' ) ).some( ( p ) => false !== p.visible ) && ( 'number' !== typeof prop( n, 'strokeWeight' ) || n.strokeWeight > 0 );
	const sections = [];
	const boxes = [];
	const lines = [];

	// Design tokens. REST puts text styles in `style`, the plugin API on the node (figma.mixed
	// where a text has several; its first character's then stand for it), so both are read.
	const num = ( v ) => ( 'number' === typeof v ? v : undefined );
	const range = ( n, fn ) => ( 'function' === typeof n[ fn ] && n.characters ? n[ fn ]( 0, 1 ) : undefined );
	const hex = ( p ) => {
		const alpha = ( p.color.a ?? 1 ) * ( p.opacity ?? 1 );
		const c = [ p.color.r, p.color.g, p.color.b, ...( alpha < 0.99 ? [ alpha ] : [] ) ];
		return `#${ c.map( ( v ) => r( v * 255 ).toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`;
	};
	const solid = ( list ) => paints( list ).find( ( p ) => 'SOLID' === p.type && false !== p.visible && p.color );
	const tokens = ( pairs ) => pairs.filter( ( [ , v ] ) => undefined !== v && '' !== v ).map( ( [ k, v ] ) => `${ k }=${ String( v ).replace( /[|;=]/g, ' ' ) }` ).join( ';' );
	// A text's style is its runs' (Figma styles characters, not layers): each token is the value
	// on at least TEXT_MAJORITY of its letters, else none, as the page's is (see extractPageBoxes).
	// REST gives the base style and per-character overrides; the plugin API styled segments.
	const TEXT_MAJORITY = 0.6;
	// Title case capitalises a word's first letter wherever it falls, so it's applied across runs.
	const CASES = { UPPER: ( c ) => c.toUpperCase(), LOWER: ( c ) => c.toLowerCase(), TITLE: ( c, prev ) => ( ! prev || /\s/.test( prev ) ? c.toUpperCase() : c ), ORIGINAL: ( c ) => c };
	const textRuns = ( n ) => {
		const text = n.characters || '';
		if ( 'function' === typeof prop( n, 'getStyledTextSegments' ) ) {
			return n.getStyledTextSegments( [ 'fontName', 'fontSize', 'fontWeight', 'fills', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase' ] ).map( ( g ) => {
				const lh = g.lineHeight;
				const ls = g.letterSpacing;
				return {
					text: g.characters, family: g.fontName?.family, italic: /italic|oblique/i.test( g.fontName?.style ?? '' ), size: g.fontSize, weight: g.fontWeight,
					lh: lh && { PIXELS: lh.value, PERCENT: lh.value / 100 * g.fontSize }[ lh.unit ], ls: ls && ( 'PERCENT' === ls.unit ? ls.value / 100 * g.fontSize : ls.value ),
					fill: solid( g.fills ), deco: g.textDecoration, textCase: g.textCase,
				};
			} );
		}
		const base = prop( n, 'style' );
		// Neither API's runs: the node's own style, one run.
		if ( ! base ) {
			const lh = prop( n, 'lineHeight' );
			const ls = prop( n, 'letterSpacing' );
			const size = num( prop( n, 'fontSize' ) );
			return [ {
				text, family: prop( n, 'fontName' )?.family, italic: /italic|oblique/i.test( prop( n, 'fontName' )?.style ?? '' ), size, weight: num( prop( n, 'fontWeight' ) ),
				lh: lh && 'object' === typeof lh ? { PIXELS: lh.value, PERCENT: lh.value / 100 * size }[ lh.unit ] : undefined,
				ls: ls && 'object' === typeof ls ? ( 'PERCENT' === ls.unit ? ls.value / 100 * size : ls.value ) : undefined,
				fill: solid( prop( n, 'fills' ) ), deco: prop( n, 'textDecoration' ) ?? 'NONE', textCase: prop( n, 'textCase' ) ?? 'ORIGINAL',
			} ];
		}
		const table = prop( n, 'styleOverrideTable' ) || {};
		const overrides = prop( n, 'characterStyleOverrides' ) || [];
		const runs = [];
		for ( let k = 0; k < text.length; k++ ) {
			const id = overrides[ k ] || 0;
			if ( runs.length && runs[ runs.length - 1 ].id === id ) {
				runs[ runs.length - 1 ].text += text[ k ];
			} else {
				runs.push( { id, text: text[ k ] } );
			}
		}
		return runs.map( ( { id, text: t } ) => {
			const st = { ...base, ...( table[ id ] || {} ) };
			return {
				text: t, family: st.fontFamily, italic: Boolean( st.italic ), size: st.fontSize, weight: st.fontWeight,
				lh: 'INTRINSIC_%' !== st.lineHeightUnit ? st.lineHeightPx : undefined, ls: st.letterSpacing ?? 0,
				fill: solid( table[ id ]?.fills ?? prop( n, 'fills' ) ), deco: st.textDecoration ?? 'NONE', textCase: st.textCase ?? 'ORIGINAL',
			};
		} );
	};
	// The letters' case as they render: upper, lower, title, sentence or mixed; none under 3 letters.
	const caseOf = ( t ) => {
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
	};
	const majority = ( runs, pick ) => {
		const weights = new Map();
		let total = 0;
		for ( const run of runs ) {
			const n = ( run.text.match( /\S/g ) || [] ).length;
			const v = pick( run );
			total += n;
			weights.set( v, ( weights.get( v ) || 0 ) + n );
		}
		let best;
		let most = -1;
		for ( const [ v, w ] of weights ) {
			if ( w > most ) {
				[ best, most ] = [ v, w ];
			}
		}
		return total && most / total >= TEXT_MAJORITY ? best : undefined;
	};
	const textStyle = ( n ) => {
		const st = prop( n, 'style' ) || {};
		const runs = textRuns( n );
		const round = ( v ) => ( 'number' === typeof v ? Math.round( v * 10 ) / 10 : undefined );
		const align = prop( n, 'textAlignHorizontal' ) ?? st.textAlignHorizontal;
		// Small caps render neither case, so the case isn't told.
		let rendered = runs.every( ( run ) => CASES[ run.textCase ?? 'ORIGINAL' ] ) ? '' : null;
		for ( const run of null === rendered ? [] : runs ) {
			for ( const c of run.text ) {
				rendered += CASES[ run.textCase ?? 'ORIGINAL' ]( c, rendered[ rendered.length - 1 ] );
			}
		}
		return tokens( [
			[ 'font', majority( runs, ( run ) => run.family ) ],
			[ 'size', majority( runs, ( run ) => round( run.size ) ) ],
			[ 'lh', majority( runs, ( run ) => round( run.lh ) ) ],
			[ 'weight', majority( runs, ( run ) => run.weight ) ],
			[ 'color', majority( runs, ( run ) => run.fill && hex( run.fill ) ) ],
			[ 'align', { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[ align ] ],
			[ 'ls', majority( runs, ( run ) => round( run.ls ) ) ],
			[ 'italic', majority( runs, ( run ) => ( run.italic ? 'italic' : 'normal' ) ) ],
			[ 'deco', majority( runs, ( run ) => ( { UNDERLINE: 'underline', STRIKETHROUGH: 'strike' }[ run.deco ] ?? 'none' ) ) ],
			[ 'case', rendered ? caseOf( rendered ) : undefined ],
			// Marks a style taken from the runs; files from before took the first character's.
			[ 'runs', 1 ],
		] );
	};
	// Four values (corners clockwise from top-left, sides clockwise from top) as one when they agree.
	const perSide = ( values ) => ( values.every( ( v ) => v === values[ 0 ] ) ? String( values[ 0 ] ) : values.join( ' ' ) );
	// REST gives cornerRadius when the corners agree and rectangleCornerRadii when they don't
	// (and leaves out a zero radius); the plugin API gives figma.mixed and the four corners.
	// Radii that together overrun a side shrink by the same factor, as CSS draws them (see
	// extractPageBoxes), so a 999px pill reads as half its height on both sides.
	const fit = ( [ tl, tr, br, bl ], w, h ) => {
		const f = Math.min( 1, ...[ [ w, tl + tr ], [ w, bl + br ], [ h, tl + bl ], [ h, tr + br ] ].filter( ( [ , sum ] ) => sum > 0 ).map( ( [ side, sum ] ) => side / sum ) );
		return [ tl, tr, br, bl ].map( ( v ) => r( v * f ) );
	};
	const corners = ( n, b ) => {
		// A circle (an avatar's photo, a round mask) is half its width on each corner; an oval has
		// no one radius, so it's null, as the page's elliptical corners are.
		if ( 'ELLIPSE' === n.type ) {
			return Math.abs( b.width - b.height ) <= 1 ? new Array( 4 ).fill( r( b.width / 2 ) ) : null;
		}
		const list = prop( n, 'rectangleCornerRadii' );
		const one = num( prop( n, 'cornerRadius' ) );
		const each = [ 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius' ].map( ( k ) => num( prop( n, k ) ) ?? 0 );
		const values = Array.isArray( list ) ? list : ( undefined !== one ? [ one, one, one, one ] : each );
		return fit( values, b.width, b.height );
	};
	// A stroke's width per side; Figma has one colour for all of them. No visible stroke is none.
	const strokeOf = ( n ) => {
		const paint = solid( prop( n, 'strokes' ) );
		if ( ! paint || ! stroked( n ) || ( paint.color.a ?? 1 ) * ( paint.opacity ?? 1 ) < 0.01 ) {
			return 'none';
		}
		const sides = prop( n, 'individualStrokeWeights' );
		const weights = sides
			? [ sides.top, sides.right, sides.bottom, sides.left ]
			: ( 'number' === typeof prop( n, 'strokeWeight' ) ? new Array( 4 ).fill( n.strokeWeight ) : [ 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight' ].map( ( k ) => num( prop( n, k ) ) ?? 0 ) );
		return perSide( weights.map( ( w ) => ( w > 0 ? `${ hex( paint ) }/${ r( w * 10 ) / 10 }` : 'none' ) ) );
	};
	const surfaceStyle = ( n ) => {
		const fill = solid( prop( n, 'fills' ) );
		return tokens( [
			[ 'fill', fill && hex( fill ) ],
			[ 'radius', perSide( corners( n, n.absoluteBoundingBox ) ) ],
			[ 'stroke', strokeOf( n ) ],
		] );
	};
	// A frame or mask that clips an image rounds each corner of it that it shares (a rounded card
	// clipping a photo along its top rounds the photo's top corners): each corner is the roundest
	// of them, as on the page (see extractPageBoxes).
	const cornerPoints = ( b ) => [ [ b.x, b.y ], [ b.x + b.width, b.y ], [ b.x + b.width, b.y + b.height ], [ b.x, b.y + b.height ] ];
	const imageStyle = ( n, b, clippers ) => {
		const own = cornerPoints( b );
		const radius = clippers.reduce( ( acc, c ) => {
			const shares = cornerPoints( c.box ).map( ( [ x, y ], i ) => Math.abs( x - own[ i ][ 0 ] ) <= 1 && Math.abs( y - own[ i ][ 1 ] ) <= 1 );
			if ( ! shares.some( Boolean ) ) {
				return acc;
			}
			const radii = corners( c.node, c.box );
			return acc && radii ? acc.map( ( v, i ) => ( shares[ i ] ? Math.max( v, radii[ i ] ) : v ) ) : null;
		}, corners( n, b ) );
		return tokens( [ [ 'radius', radius ? perSide( radius ) : undefined ], [ 'stroke', strokeOf( n ) ] ] );
	};

	// A frame that clips its content (a carousel's track) hides what lies outside it: only the
	// visible part of a box is kept, and a box with nothing visible is left out.
	const add = ( s, type, x, y, w, h, clip, text, margins, style, layout ) => {
		const [ x0, y0 ] = [ Math.max( x, clip.left ), Math.max( y, clip.top ) ];
		const [ x1, y1 ] = [ Math.min( x + w, clip.right ), Math.min( y + h, clip.bottom ) ];
		// More than a pixel hidden counts as cut off; edges differ by fractions of one.
		const cut = x0 > x + 1 || y0 > y + 1 || x1 < x + w - 1 || y1 < y + h - 1;
		x = r( x0 - fb.x );
		y = r( y0 - fb.y - sections[ s ].y );
		w = r( x1 - x0 );
		h = r( y1 - y0 );
		if ( w < 1 || h < 1 || x >= fb.width || x + w <= 0 ) {
			return;
		}
		let extra = undefined === text ? '||' : `|${ hash( normText( text ) ) }|${ normText( text ).slice( 0, TEXT_PREFIX ).replace( /\|/g, '/' ) }|${ r( margins[ 0 ] ) }|${ r( margins[ 1 ] ) }`;
		if ( undefined !== style || cut || layout ) {
			extra += `${ undefined === text ? '||' : '' }|${ style ?? '' }`;
		}
		if ( cut || layout ) {
			extra += cut ? '|1' : '|';
		}
		// A text's layout box: where its lines may run, whatever width they reach.
		if ( layout ) {
			extra += `|${ r( layout.x - fb.x ) }/${ r( layout.width ) }`;
		}
		boxes.push( `B|${ s }|${ type }|${ x }|${ y }|${ w }|${ h }${ extra }` );
	};

	// A text layer alone in an auto-layout frame padded only above and below (a Text Block)
	// has that padding as its margins: the page's CSS margins on the same element. A frame
	// padded on the sides too is a padded box around the text (a button), not a margin.
	const margins = ( parent ) => {
		const layout = prop( parent, 'layoutMode' );
		const block = layout && 'NONE' !== layout && ! prop( parent, 'paddingLeft' ) && ! prop( parent, 'paddingRight' ) &&
			1 === ( prop( parent, 'children' ) || [] ).filter( visible ).length;
		return block ? [ prop( parent, 'paddingTop' ) || 0, prop( parent, 'paddingBottom' ) || 0 ] : [ 0, 0 ];
	};

	// Every line a node draws, whatever draws it: a border only one side has may be drawn another
	// way on the other (a divider rectangle, a LINE, a shadow ring), so both sides record them all.
	const THIN = 3;
	// Only the part a clipping frame leaves visible is drawn; a line it hides entirely isn't.
	const line = ( s, clip, x, y, w, h ) => {
		const [ x0, y0 ] = [ Math.max( x, clip.left ), Math.max( y, clip.top ) ];
		const [ x1, y1 ] = [ Math.min( x + Math.max( 1, w ), clip.right ), Math.min( y + Math.max( 1, h ), clip.bottom ) ];
		if ( x1 > x0 && y1 > y0 ) {
			lines.push( `L|${ s }|${ r( x0 - fb.x ) }|${ r( y0 - fb.y - sections[ s ].y ) }|${ Math.max( 1, r( x1 - x0 ) ) }|${ Math.max( 1, r( y1 - y0 ) ) }` );
		}
	};
	// The straight run of one side of a box (0 top, 1 right, 2 bottom, 3 left), `t` px thick and
	// clear of its rounded corners, as the page's (see extractPageBoxes).
	const straight = ( s, clip, b, side, t, radii ) => {
		if ( ! radii ) {
			return;
		}
		const [ tl, tr, br, bl ] = radii;
		const len = ( 0 === side || 2 === side ? b.width : b.height ) - [ tl + tr, tr + br, bl + br, tl + bl ][ side ];
		if ( len >= 1 ) {
			line( s, clip, ...[ [ b.x + tl, b.y, len, t ], [ b.x + b.width - t, b.y + tr, t, len ], [ b.x + bl, b.y + b.height - t, len, t ], [ b.x, b.y + tl, t, len ] ][ side ] );
		}
	};
	// A paint that shows: visible and not fully transparent.
	const shows = ( list ) => paints( list ).some( ( p ) => false !== p.visible && ( p.opacity ?? 1 ) * ( p.color?.a ?? 1 ) >= 0.01 );
	// Only straight-sided shapes draw their box's edges: a circle's or a vector's outline doesn't run
	// along them, unless the shape has no height or width (a straight vector line).
	const BOXY = [ 'FRAME', 'RECTANGLE', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'LINE' ];
	const drawnLines = ( n, s, b, clip ) => {
		// A mask decides what shows; it paints nothing of its own.
		if ( prop( n, 'isMask' ) ) {
			return;
		}
		if ( ( BOXY.includes( n.type ) || b.width < 1 || b.height < 1 ) && stroked( n ) && shows( prop( n, 'strokes' ) ) ) {
			const sides = prop( n, 'individualStrokeWeights' );
			const one = num( prop( n, 'strokeWeight' ) );
			const [ top, right, bottom, left ] = sides
				? [ sides.top, sides.right, sides.bottom, sides.left ]
				: [ 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight' ].map( ( k ) => num( prop( n, k ) ) ?? one ?? 1 );
			// A LINE's box has no height (or width): its stroke is the line.
			if ( 'LINE' === n.type || b.width < 1 || b.height < 1 ) {
				line( s, clip, b.x, b.y, b.width, b.height || one || 1 );
				return;
			}
			[ top, right, bottom, left ].forEach( ( w, k ) => w > 0 && straight( s, clip, b, k, w, corners( n, b ) ) );
		}
		// A thin filled shape is a rule.
		if ( ( filled( n ) || ( VECTORS.includes( n.type ) && shows( prop( n, 'fills' ) ) ) ) && Math.min( b.width, b.height ) <= THIN && Math.max( b.width, b.height ) >= 8 ) {
			line( s, clip, b.x, b.y, b.width, b.height );
		}
		// A shadow with (almost) no blur, offset or spread a few px, draws a rule on the sides it's
		// offset to (inside the box for an inner shadow, so on the opposite edge), or round the box
		// when it's spread; further off, it draws away from the edge. Only a straight-sided box's.
		for ( const e of BOXY.includes( n.type ) ? paints( prop( n, 'effects' ) ) : [] ) {
			const [ x, y ] = [ e.offset?.x ?? 0, e.offset?.y ?? 0 ];
			if ( ! /SHADOW/.test( e.type ) || false === e.visible || ( e.color?.a ?? 1 ) < 0.01 || ( e.radius ?? 0 ) > 2 || Math.max( Math.abs( x ), Math.abs( y ) ) > THIN || Math.abs( e.spread ?? 0 ) > THIN ) {
				continue;
			}
			const sides = ( e.spread ?? 0 ) > 0 ? [ 0, 1, 2, 3 ] : [ y < 0 && 0, x > 0 && 1, y > 0 && 2, x < 0 && 3 ].filter( ( v ) => false !== v );
			sides.map( ( side ) => ( 'INNER_SHADOW' === e.type ? ( side + 2 ) % 4 : side ) ).forEach( ( side ) => straight( s, clip, b, side, 1, corners( n, b ) ) );
		}
	};

	const within = ( c, b ) => ( { left: Math.max( c.left, b.x ), top: Math.max( c.top, b.y ), right: Math.min( c.right, b.x + b.width ), bottom: Math.min( c.bottom, b.y + b.height ) } );
	// lineClip also takes in masks: what a mask hides draws no line (a box keeps its own clip).
	const walk = ( n, s, isRoot, parent, clip, clippers = [], lineClip = clip ) => {
		if ( ! visible( n ) ) {
			return;
		}
		const b = n.absoluteBoundingBox;
		if ( b && 'TEXT' !== n.type ) {
			drawnLines( n, s, b, lineClip );
		}
		if ( 'TEXT' === n.type ) {
			if ( ( n.characters || '' ).trim() && b ) {
				// Ink width with line-box height: what the browser's text ranges measure.
				const ink = n.absoluteRenderBounds || b;
				add( s, 'text', ink.x, b.y, ink.width, b.height, clip, n.characters, margins( parent ), textStyle( n ), b );
			}
			return;
		}
		if ( hasImage( n ) && b ) {
			add( s, 'image', b.x, b.y, b.width, b.height, clip, undefined, undefined, imageStyle( n, b, clippers ) );
			return;
		}
		const surface = filled( n ) || stroked( n );
		if ( b && ( VECTORS.includes( n.type ) || ( /icon/i.test( n.name ) && b.width <= ICON_MAX && b.height <= ICON_MAX && ! surface ) ) ) {
			add( s, 'icon', b.x, b.y, b.width, b.height, clip );
			return;
		}
		if ( ! isRoot && surface && b && b.width < fb.width - 1 ) {
			add( s, 'surface', b.x, b.y, b.width, b.height, clip, undefined, undefined, surfaceStyle( n ) );
		}
		const inner = prop( n, 'clipsContent' ) && b
			? { left: Math.max( clip.left, b.x ), top: Math.max( clip.top, b.y ), right: Math.min( clip.right, b.x + b.width ), bottom: Math.min( clip.bottom, b.y + b.height ) }
			: clip;
		const holders = prop( n, 'clipsContent' ) && b ? [ ...clippers, { node: n, box: b } ] : clippers;
		// A mask clips the layers above it in its group, until the next mask.
		let mask = null;
		for ( const c of prop( n, 'children' ) || [] ) {
			const lines = prop( n, 'clipsContent' ) && b ? within( lineClip, b ) : lineClip;
			walk( c, s, false, n, inner, mask ? [ ...holders, mask ] : holders, mask ? within( lines, mask.box ) : lines );
			if ( prop( c, 'isMask' ) && visible( c ) && c.absoluteBoundingBox ) {
				mask = { node: c, box: c.absoluteBoundingBox };
			}
		}
	};

	// A page frame's children are its sections; a single block's node is its own only section.
	const tops = section ? [ frame ] : ( prop( frame, 'children' ) || [] )
		.filter( ( c ) => false !== c.visible && ! IGNORE.test( c.name ) && c.absoluteBoundingBox )
		.sort( ( a, b ) => a.absoluteBoundingBox.y - b.absoluteBoundingBox.y );
	for ( const top of tops ) {
		const b = top.absoluteBoundingBox;
		sections.push( { name: top.name, y: b.y - fb.y, h: b.height } );
		walk( top, sections.length - 1, true, undefined, { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity } );
	}

	return [
		`F|${ r( fb.width ) }|${ r( fb.height ) }`,
		// "|" separates fields, so a layer name can't contain it (text boxes do the same).
		...sections.map( ( s, i ) => `S|${ i }|${ s.name.replace( /\|/g, '/' ) }|${ r( s.y ) }|${ r( s.h ) }|1` ),
		...boxes,
		...lines,
	].join( '\n' );
}

/** use_figma cuts its result at 20 KB; the margin leaves room for the P line. */
export const PART_BYTES = 19000;

/**
 * One part of figma-boxes.txt, small enough for use_figma to return whole. Parts split at
 * line boundaries; a file that fits in one part comes back unchanged. Runs inside Figma
 * (printed by figmaScript), so it counts UTF-8 bytes by hand rather than with TextEncoder.
 *
 * @param {string} text The whole file.
 * @param {number} part Zero-based part to return.
 * @return {string} That part, ending with P|<part>|<parts> when there are several.
 */
export function pagePart( text, part ) {
	const bytes = ( s ) => {
		let n = 0;
		for ( const c of s ) {
			const code = c.codePointAt( 0 );
			if ( code < 0x80 ) {
				n += 1;
			} else if ( code < 0x800 ) {
				n += 2;
			} else if ( code < 0x10000 ) {
				n += 3;
			} else {
				n += 4;
			}
		}
		return n;
	};
	const parts = [ [] ];
	let size = 0;
	for ( const line of text.split( '\n' ) ) {
		const n = bytes( line ) + 1;
		if ( n > PART_BYTES ) {
			throw new Error( `A line is too long for one use_figma result; shorten this layer name: ${ line.slice( 0, 80 ) }` );
		}
		if ( size + n > PART_BYTES && parts[ parts.length - 1 ].length ) {
			parts.push( [] );
			size = 0;
		}
		parts[ parts.length - 1 ].push( line );
		size += n;
	}
	if ( 1 === parts.length && 0 === part ) {
		return text;
	}
	if ( part >= parts.length ) {
		return `No part ${ part }: this frame has ${ parts.length }.`;
	}
	return [ ...parts[ part ], `P|${ part }|${ parts.length }` ].join( '\n' );
}

/**
 * The script for the Figma MCP's use_figma tool: extractBoxes() on one node, read-only.
 * Run it unchanged and save the returned string verbatim as figma-boxes.txt.
 *
 * @param {string}  nodeId  Node id, as in the URL (16233-18647) or Figma's form (16233:18647).
 * @param {Object}  options Extraction options, as for extractBoxes(), plus part (default 0).
 * @return {string} JavaScript for use_figma.
 */
export function figmaScript( nodeId, { ignore, section, part = 0 } ) {
	return [
		`const TEXT_PREFIX = ${ TEXT_PREFIX };`,
		`const normText = ${ normText };`,
		`const hash = ${ hash };`,
		`const extractBoxes = ${ extractBoxes };`,
		`const PART_BYTES = ${ PART_BYTES };`,
		`const pagePart = ${ pagePart };`,
		`return pagePart( extractBoxes( await figma.getNodeByIdAsync( ${ JSON.stringify( nodeId.replace( '-', ':' ) ) } ), ${ JSON.stringify( { ignore, section } ) } ), ${ part } );`,
	].join( '\n' );
}

/**
 * Page slug for a Figma top-level layer: "Content Cards (No Bg) / Desktop" → "content-cards",
 * unless the project's sectionMap names it explicitly.
 *
 * @param {string} name   Figma layer name.
 * @param {Object} config Loaded config (only sectionMap is read).
 * @return {string} Section slug.
 */
export function figmaSlug( name, config = {} ) {
	const base = name.replace( /\s*\/\s*(Desktop|Mobile|Tablet)\s*$/i, '' ).trim();
	const mapped = Object.entries( config.sectionMap || {} ).find( ( [ key ] ) => key.toLowerCase() === base.toLowerCase() );
	if ( mapped ) {
		return mapped[ 1 ];
	}
	return base.replace( /\([^)]*\)/g, '' ).trim().toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' );
}

/**
 * Read figma-boxes.txt.
 *
 * @param {string} file   Path to figma-boxes.txt.
 * @param {Object} config Loaded config, for section slugs.
 * @return {{frame: {width: number, height: number}, sections: Array}} Sections with their boxes.
 * @throws {Error} When the file holds no frame or sections.
 */
export function parseFigma( file, config ) {
	const frame = {};
	const sections = [];
	for ( const line of fs.readFileSync( file, 'utf8' ).split( '\n' ) ) {
		const f = line.split( '|' );
		if ( 'F' === f[ 0 ] ) {
			frame.width = Number( f[ 1 ] );
			frame.height = Number( f[ 2 ] );
		} else if ( 'S' === f[ 0 ] ) {
			sections[ Number( f[ 1 ] ) ] = { name: f[ 2 ], slug: figmaSlug( f[ 2 ], config ), y: Number( f[ 3 ] ), height: Number( f[ 4 ] ), boxes: [], ...( '1' === f[ 5 ] ? { lines: [] } : {} ) };
		} else if ( 'L' === f[ 0 ] ) {
			sections[ Number( f[ 1 ] ) ].lines?.push( { x: Number( f[ 2 ] ), y: Number( f[ 3 ] ), w: Number( f[ 4 ] ), h: Number( f[ 5 ] ) } );
		} else if ( 'B' === f[ 0 ] ) {
			const box = { type: f[ 2 ], x: Number( f[ 3 ] ), y: Number( f[ 4 ] ), w: Number( f[ 5 ] ), h: Number( f[ 6 ] ), hash: f[ 7 ] || null, text: f[ 8 ] || null };
			if ( 'text' === box.type ) {
				// Files extracted before margins were recorded have none: 0.
				box.mt = Number( f[ 9 ] ) || 0;
				box.mb = Number( f[ 10 ] ) || 0;
			}
			if ( f[ 11 ] ) {
				box.style = Object.fromEntries( f[ 11 ].split( ';' ).map( ( kv ) => kv.split( '=' ) ) );
			}
			if ( '1' === f[ 12 ] ) {
				box.clipped = true;
			}
			// Files extracted before layout boxes were recorded have none.
			if ( f[ 13 ] ) {
				[ box.lx, box.lw ] = f[ 13 ].split( '/' ).map( Number );
			}
			sections[ Number( f[ 1 ] ) ].boxes.push( box );
		}
	}
	if ( ! frame.width || ! sections.length ) {
		throw new Error( `${ file } holds no frame or sections; extract the frame again.` );
	}
	return { frame, sections };
}

/**
 * End each section where the next one starts.
 *
 * Figma positions are fractional and the extractor rounds a section's top and height
 * separately, so a section can reach 1px into the next. That row belongs to the neighbour,
 * and a page crop (which never leaves its section) can't match it.
 *
 * @param {Array} sections Sections in visual order, each with y and height.
 * @return {Array} The same sections, heights clamped to the next section's top.
 */
export function tileSections( sections ) {
	return sections.map( ( s, i ) => {
		const next = sections[ i + 1 ];
		return next && next.y > s.y && s.y + s.height > next.y ? { ...s, height: next.y - s.y } : s;
	} );
}
