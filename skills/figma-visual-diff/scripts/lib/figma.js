/**
 * The Figma side: reduce a frame to typed boxes, and read them back.
 *
 * One extractor serves both ways of reaching Figma: figma-rest.js calls extractBoxes() on a
 * node from the REST API, and figmaScript() prints the same function for the Figma MCP's
 * use_figma tool to run inside Figma. Its output, figma-boxes.txt, has one line per item:
 *
 *   F|<width>|<height>                         the frame
 *   S|<index>|<name>|<y>|<height>              a top-level section, in visual order
 *   B|<section>|<type>|x|y|w|h|<hash>|<text>|<mt>|<mb>|<style>|<cut>
 *                                              a box, section-relative; hash, text and the
 *                                              top/bottom margins for text only; style for
 *                                              text and surfaces; cut is 1 when a frame that
 *                                              clips its content hides part of the box (the
 *                                              box is then its visible part)
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
	const textStyle = ( n ) => {
		const st = prop( n, 'style' ) || {};
		const size = num( n.fontSize ) ?? num( range( n, 'getRangeFontSize' ) ) ?? st.fontSize;
		const lh = n.lineHeight && 'object' === typeof n.lineHeight ? n.lineHeight : range( n, 'getRangeLineHeight' );
		// An automatic line-height has no value in the plugin API; REST still computes one.
		const lineHeight = lh ? ( { PIXELS: lh.value, PERCENT: lh.value / 100 * size }[ lh.unit ] ) : ( 'INTRINSIC_%' !== st.lineHeightUnit ? st.lineHeightPx : undefined );
		const fontName = n.fontName && 'string' === typeof n.fontName.family ? n.fontName : range( n, 'getRangeFontName' );
		const fill = solid( prop( n, 'fills' ) ) || solid( range( n, 'getRangeFills' ) );
		const align = prop( n, 'textAlignHorizontal' ) ?? st.textAlignHorizontal;
		return tokens( [
			[ 'font', fontName?.family ?? st.fontFamily ],
			[ 'size', size && Math.round( size * 10 ) / 10 ],
			[ 'lh', lineHeight && Math.round( lineHeight * 10 ) / 10 ],
			[ 'weight', num( n.fontWeight ) ?? num( range( n, 'getRangeFontWeight' ) ) ?? st.fontWeight ],
			[ 'color', fill && hex( fill ) ],
			[ 'align', { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[ align ] ],
		] );
	};
	const surfaceStyle = ( n ) => {
		const fill = solid( prop( n, 'fills' ) );
		const stroke = solid( prop( n, 'strokes' ) );
		// REST leaves out a zero radius.
		const radius = num( prop( n, 'cornerRadius' ) ) ?? num( prop( n, 'topLeftRadius' ) ) ?? prop( n, 'rectangleCornerRadii' )?.[ 0 ] ?? 0;
		return tokens( [
			[ 'fill', fill && hex( fill ) ],
			[ 'radius', radius ],
			[ 'stroke', stroke && num( prop( n, 'strokeWeight' ) ) && `${ hex( stroke ) }/${ n.strokeWeight }` ],
		] );
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

	const walk = ( n, s, isRoot, parent, clip ) => {
		if ( ! visible( n ) ) {
			return;
		}
		const b = n.absoluteBoundingBox;
		if ( 'TEXT' === n.type ) {
			if ( ( n.characters || '' ).trim() && b ) {
				// Ink width with line-box height: what the browser's text ranges measure.
				const ink = n.absoluteRenderBounds || b;
				add( s, 'text', ink.x, b.y, ink.width, b.height, clip, n.characters, margins( parent ), textStyle( n ), b );
			}
			return;
		}
		if ( hasImage( n ) && b ) {
			add( s, 'image', b.x, b.y, b.width, b.height, clip );
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
		for ( const c of prop( n, 'children' ) || [] ) {
			walk( c, s, false, n, inner );
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
		...sections.map( ( s, i ) => `S|${ i }|${ s.name.replace( /\|/g, '/' ) }|${ r( s.y ) }|${ r( s.h ) }` ),
		...boxes,
	].join( '\n' );
}

/**
 * The script for the Figma MCP's use_figma tool: extractBoxes() on one node, read-only.
 * Run it unchanged and save the returned string verbatim as figma-boxes.txt.
 *
 * @param {string}  nodeId  Node id, as in the URL (16233-18647) or Figma's form (16233:18647).
 * @param {Object}  options Extraction options, as for extractBoxes().
 * @return {string} JavaScript for use_figma.
 */
export function figmaScript( nodeId, { ignore, section } ) {
	return [
		`const TEXT_PREFIX = ${ TEXT_PREFIX };`,
		`const normText = ${ normText };`,
		`const hash = ${ hash };`,
		`const extractBoxes = ${ extractBoxes };`,
		`return extractBoxes( await figma.getNodeByIdAsync( ${ JSON.stringify( nodeId.replace( '-', ':' ) ) } ), ${ JSON.stringify( { ignore, section } ) } );`,
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
			sections[ Number( f[ 1 ] ) ] = { name: f[ 2 ], slug: figmaSlug( f[ 2 ], config ), y: Number( f[ 3 ] ), height: Number( f[ 4 ] ), boxes: [] };
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
