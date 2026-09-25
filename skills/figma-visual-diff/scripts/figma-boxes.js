// Figma Plugin API script, run through the Figma MCP `use_figma` tool. Don't paste it by hand:
// `node config.js figma-boxes <frame-id> [--section]` fills in FRAME_ID, SINGLE_SECTION and the
// project's FIGMA_IGNORE.
// Read-only. Returns one line per visible leaf element of the frame's top-level sections:
//   S|<index>|<name>|<y>|<height>             section, in visual order
//   B|<section>|<type>|x|y|w|h|<hash>|<text>  box, section-relative; hash/text only for text
// Types: text, image, icon, surface. Save the returned string verbatim as figma-boxes.txt.

const FRAME = await figma.getNodeByIdAsync( 'FRAME_ID' );
const IGNORE = new RegExp( 'FIGMA_IGNORE', 'i' );
const fb = FRAME.absoluteBoundingBox;
const r = Math.round;

// Must match normText()/hash() in wireframe-diff.js.
const normText = ( s ) => s.normalize( 'NFKD' ).replace( /[‘’]/g, "'" ).replace( /[“”]/g, '"' ).replace( /[–—]/g, '-' ).replace( /\s+/g, ' ' ).trim().toLowerCase();
const hash = ( s ) => {
	let h = 5381;
	for ( let i = 0; i < s.length; i++ ) {
		h = ( ( h * 33 ) ^ s.charCodeAt( i ) ) >>> 0;
	}
	return h.toString( 16 );
};

const hasImage = ( n ) => 'fills' in n && Array.isArray( n.fills ) && n.fills.some( ( p ) => 'IMAGE' === p.type && false !== p.visible );
const filled = ( n ) => 'fills' in n && Array.isArray( n.fills ) && n.fills.some( ( p ) => 'SOLID' === p.type && false !== p.visible && ( p.opacity ?? 1 ) > 0.01 );
const stroked = ( n ) => 'strokes' in n && Array.isArray( n.strokes ) && n.strokes.some( ( p ) => false !== p.visible ) && ( 'number' !== typeof n.strokeWeight || n.strokeWeight > 0 );
const VECTORS = [ 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'ELLIPSE' ];

const sections = [];
const boxes = [];

function add( s, t, x, y, w, h, text ) {
	x = r( x - fb.x );
	y = r( y - fb.y - sections[ s ].y );
	w = r( w );
	h = r( h );
	if ( w < 1 || h < 1 || x >= fb.width || x + w <= 0 ) {
		return;
	}
	const extra = undefined === text ? '||' : `|${ hash( normText( text ) ) }|${ normText( text ).slice( 0, 28 ).replace( /\|/g, '/' ) }`;
	boxes.push( `B|${ s }|${ t }|${ x }|${ y }|${ w }|${ h }${ extra }` );
}

function walk( n, s, isRoot ) {
	if ( false === n.visible || ( 'opacity' in n && n.opacity < 0.01 ) ) {
		return;
	}
	const b = n.absoluteBoundingBox;
	if ( 'TEXT' === n.type ) {
		if ( n.characters.trim() && b ) {
			// Ink width with line-box height: what the browser's text ranges measure.
			const ink = n.absoluteRenderBounds || b;
			add( s, 'text', ink.x, b.y, ink.width, b.height, n.characters );
		}
		return;
	}
	if ( hasImage( n ) && b ) {
		add( s, 'image', b.x, b.y, b.width, b.height );
		return;
	}
	const surface = filled( n ) || stroked( n );
	if ( b && ( VECTORS.includes( n.type ) || ( /icon/i.test( n.name ) && b.width <= 64 && b.height <= 64 && ! surface ) ) ) {
		add( s, 'icon', b.x, b.y, b.width, b.height );
		return;
	}
	if ( ! isRoot && surface && b && b.width < fb.width - 1 ) {
		add( s, 'surface', b.x, b.y, b.width, b.height );
	}
	if ( 'children' in n ) {
		for ( const c of n.children ) {
			walk( c, s, false );
		}
	}
}

// A page frame's children are its sections; a single block's node is its own only section.
const tops = SINGLE_SECTION ? [ FRAME ] : FRAME.children
	.filter( ( c ) => false !== c.visible && ! IGNORE.test( c.name ) && c.absoluteBoundingBox )
	.sort( ( a, b ) => a.absoluteBoundingBox.y - b.absoluteBoundingBox.y );
for ( const child of tops ) {
	const b = child.absoluteBoundingBox;
	sections.push( { name: child.name, y: b.y - fb.y, h: b.height } );
	walk( child, sections.length - 1, true );
}

return [
	`F|${ r( fb.width ) }|${ r( fb.height ) }`,
	...sections.map( ( s, i ) => `S|${ i }|${ s.name }|${ r( s.y ) }|${ r( s.h ) }` ),
	...boxes,
].join( '\n' );
