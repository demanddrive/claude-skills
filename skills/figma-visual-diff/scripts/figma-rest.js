/**
 * Figma data without the MCP: fetch a frame through the Figma REST API and write the same
 * figma-boxes.txt and figma.png the MCP workflow produces. Needs a personal access token
 * in FIGMA_TOKEN (Figma → Settings → Security → Personal access tokens, read-only scope).
 *
 *   node figma-rest.js <file-key> <node-id> <out-dir> [--section]
 *
 * The boxes come from lib/figma.js extractBoxes(), the same function the Figma MCP runs
 * inside Figma, so both routes produce identical files.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { isMain } from './lib/cli.js';
import { extractBoxes } from './lib/figma.js';

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
 * @param {Object} options { fileKey, nodeId, out, token, ignore, section }.
 * @return {Promise<{frame: {width: number, height: number}}>} Frame size.
 */
export async function fetchFigmaFrame( { fileKey, nodeId, out, token = process.env.FIGMA_TOKEN, ignore, section = false } ) {
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
	fs.writeFileSync( path.join( out, 'figma-boxes.txt' ), extractBoxes( frame, { ignore: ignore ?? loadConfig().figmaIgnore, section } ) );

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

if ( isMain( import.meta.url ) ) {
	const section = process.argv.includes( '--section' );
	const [ fileKey, nodeId, out ] = process.argv.slice( 2 ).filter( ( a ) => '--section' !== a );
	if ( ! fileKey || ! nodeId || ! out ) {
		console.error( 'Usage: node figma-rest.js <file-key> <node-id> <out-dir> [--section]   (FIGMA_TOKEN must be set)' );
		process.exit( 2 );
	}
	fetchFigmaFrame( { fileKey, nodeId, out, section } )
		.then( ( { frame } ) => console.log( `wrote figma-boxes.txt and figma.png (${ frame.width }×${ frame.height }) to ${ out }` ) )
		.catch( ( error ) => {
			console.error( error.message );
			process.exitCode = 2;
		} );
}
