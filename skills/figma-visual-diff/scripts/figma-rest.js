/**
 * Figma data without the MCP: fetch a frame through the Figma REST API and write the same
 * figma-boxes.txt and figma.png the MCP workflow produces. Needs a personal access token
 * in FIGMA_TOKEN (Figma → Settings → Security → Personal access tokens, read-only scope).
 *
 *   node figma-rest.js <file-key> <node-id> <out-dir>
 *
 * boxesFromNode() mirrors figma-boxes.js, which runs inside Figma; tests/unit.test.js holds
 * them to identical output on the same subtree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, loadConfig } from './config.js';
import { hash, normText } from './wireframe-diff.js';

const VECTORS = [ 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'ELLIPSE' ];

// REST omits defaults: visible and opacity only appear when they differ from true and 1.
const visible = ( n ) => false !== n.visible;
const hasImage = ( n ) => ( n.fills || [] ).some( ( p ) => 'IMAGE' === p.type && false !== p.visible );
const filled = ( n ) => ( n.fills || [] ).some( ( p ) => 'SOLID' === p.type && false !== p.visible && ( p.opacity ?? 1 ) > 0.01 );
const stroked = ( n ) => ( n.strokes || [] ).some( ( p ) => false !== p.visible ) && ( 'number' !== typeof n.strokeWeight || n.strokeWeight > 0 );

/**
 * The figma-boxes.txt lines for a frame node in REST shape.
 *
 * @param {Object} frame  Frame node from GET /v1/files/:key/nodes (document).
 * @param {string} ignore Pattern of top-level layers that aren't sections.
 * @return {string} figma-boxes.txt content.
 */
export function boxesFromNode( frame, ignore = DEFAULT_CONFIG.figmaIgnore ) {
	const IGNORE = new RegExp( ignore, 'i' );
	const fb = frame.absoluteBoundingBox;
	const r = Math.round;
	const sections = [];
	const boxes = [];

	const add = ( s, t, x, y, w, h, text ) => {
		x = r( x - fb.x );
		y = r( y - fb.y - sections[ s ].y );
		w = r( w );
		h = r( h );
		if ( w < 1 || h < 1 || x >= fb.width || x + w <= 0 ) {
			return;
		}
		const extra = undefined === text ? '||' : `|${ hash( normText( text ) ) }|${ normText( text ).slice( 0, 28 ).replace( /\|/g, '/' ) }`;
		boxes.push( `B|${ s }|${ t }|${ x }|${ y }|${ w }|${ h }${ extra }` );
	};

	const walk = ( n, s, isRoot ) => {
		if ( ! visible( n ) || ( n.opacity ?? 1 ) < 0.01 ) {
			return;
		}
		const b = n.absoluteBoundingBox;
		if ( 'TEXT' === n.type ) {
			if ( ( n.characters || '' ).trim() && b ) {
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
		for ( const c of n.children || [] ) {
			walk( c, s, false );
		}
	};

	const tops = ( frame.children || [] )
		.filter( ( c ) => visible( c ) && ! IGNORE.test( c.name ) && c.absoluteBoundingBox )
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
}

async function figmaGet( url, token ) {
	const response = await fetch( url, { headers: { 'X-Figma-Token': token } } );
	if ( ! response.ok ) {
		throw new Error( `Figma API ${ response.status } for ${ url.replace( /\?.*/, '' ) }: ${ ( await response.text() ).slice( 0, 200 ) }` );
	}
	return response;
}

/**
 * Fetch a frame and write figma-boxes.txt and figma.png into `out`.
 *
 * @param {Object} options { fileKey, nodeId, out, token, ignore }.
 * @return {Promise<{frame: {width: number, height: number}}>} Frame size.
 */
export async function fetchFigmaFrame( { fileKey, nodeId, out, token = process.env.FIGMA_TOKEN, ignore } ) {
	if ( ! token ) {
		throw new Error( 'FIGMA_TOKEN is not set. Create a read-only personal access token in Figma (Settings → Security) and export it.' );
	}
	const id = nodeId.replace( '-', ':' );
	const nodes = await ( await figmaGet( `https://api.figma.com/v1/files/${ fileKey }/nodes?ids=${ encodeURIComponent( id ) }`, token ) ).json();
	const frame = nodes.nodes?.[ id ]?.document;
	if ( ! frame ) {
		throw new Error( `Figma node ${ id } not found in file ${ fileKey }.` );
	}
	fs.mkdirSync( out, { recursive: true } );
	fs.writeFileSync( path.join( out, 'figma-boxes.txt' ), boxesFromNode( frame, ignore ?? loadConfig().figmaIgnore ) );

	// scale=1 renders at 1:1, matching get_screenshot with maxDimension = frame height.
	const images = await ( await figmaGet( `https://api.figma.com/v1/images/${ fileKey }?ids=${ encodeURIComponent( id ) }&format=png&scale=1`, token ) ).json();
	const url = images.images?.[ id ];
	if ( ! url ) {
		throw new Error( `Figma returned no render for ${ id }: ${ images.err || 'unknown error' }` );
	}
	fs.writeFileSync( path.join( out, 'figma.png' ), Buffer.from( await ( await fetch( url ) ).arrayBuffer() ) );
	const box = frame.absoluteBoundingBox;
	return { frame: { width: Math.round( box.width ), height: Math.round( box.height ) } };
}

if ( process.argv[ 1 ] === fileURLToPath( import.meta.url ) ) {
	const [ fileKey, nodeId, out ] = process.argv.slice( 2 );
	if ( ! fileKey || ! nodeId || ! out ) {
		console.error( 'Usage: node figma-rest.js <file-key> <node-id> <out-dir>   (FIGMA_TOKEN must be set)' );
		process.exit( 2 );
	}
	fetchFigmaFrame( { fileKey, nodeId, out } )
		.then( ( { frame } ) => console.log( `wrote figma-boxes.txt and figma.png (${ frame.width }×${ frame.height }) to ${ out }` ) )
		.catch( ( error ) => {
			console.error( error.message );
			process.exitCode = 2;
		} );
}
