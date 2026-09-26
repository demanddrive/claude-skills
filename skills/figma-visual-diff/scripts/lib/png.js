/**
 * PNG helpers: cropping, drawing and colour sampling on pngjs images.
 */

import { loadDeps } from '../deps.js';

const { PNG } = await loadDeps();

/** Crop rows [y, y+h) and scale to `width` with nearest-neighbour sampling. */
export function crop( png, y, h, width, scale = 1 ) {
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

/** Most common colour (quantised) among unmasked pixels: the section background. */
export function backgroundColor( png, mask ) {
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

/**
 * Images side by side, 8px apart, on white.
 *
 * @param {PNG[]} images Images, left to right.
 * @return {PNG}
 */
export function sideBySide( images ) {
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

/**
 * Outline a box.
 *
 * @param {PNG}    png   Image drawn on.
 * @param {Object} b     Box: x, y, w, h.
 * @param {number[]} color RGB.
 * @param {number} thick Line width in px.
 */
export function drawBox( png, b, color, thick ) {
	const x1 = Math.max( 0, Math.round( b.x ) );
	const y1 = Math.max( 0, Math.round( b.y ) );
	const x2 = Math.min( png.width - 1, Math.round( b.x + b.w ) );
	const y2 = Math.min( png.height - 1, Math.round( b.y + b.h ) );
	const set = ( x, y ) => {
		const d = ( y * png.width + x ) * 4;
		png.data[ d ] = color[ 0 ];
		png.data[ d + 1 ] = color[ 1 ];
		png.data[ d + 2 ] = color[ 2 ];
		png.data[ d + 3 ] = 255;
	};
	for ( let k = 0; k < thick; k++ ) {
		for ( let x = x1; x <= x2; x++ ) {
			if ( y1 + k <= y2 ) {
				set( x, y1 + k );
				set( x, y2 - k );
			}
		}
		for ( let y = y1; y <= y2; y++ ) {
			if ( x1 + k <= x2 ) {
				set( x1 + k, y );
				set( x2 - k, y );
			}
		}
	}
}

/** Blend a translucent colour over a rectangle. */
export function tint( png, x, y, w, h, color, alpha ) {
	const x1 = Math.max( 0, Math.round( x ) );
	const y1 = Math.max( 0, Math.round( y ) );
	const x2 = Math.min( png.width, Math.round( x + w ) );
	const y2 = Math.min( png.height, Math.round( y + h ) );
	for ( let yy = y1; yy < y2; yy++ ) {
		for ( let xx = x1; xx < x2; xx++ ) {
			const d = ( yy * png.width + xx ) * 4;
			for ( let c = 0; c < 3; c++ ) {
				png.data[ d + c ] = Math.round( png.data[ d + c ] * ( 1 - alpha ) + color[ c ] * alpha );
			}
		}
	}
}
