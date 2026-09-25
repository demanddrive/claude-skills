/**
 * Wireframe diff: compare a built page against its Figma frame as boxes, not pixels.
 *
 * Both sides reduce to typed leaf boxes (text, image, icon, surface) per top-level section.
 * Boxes are paired by type, text and position, so the report names what is missing, extra,
 * moved or reworded instead of counting differing pixels.
 *
 * Usage:
 *   node wireframe-diff.js --url <page-url> --width <1440|375> --out <dir> --figma <figma-boxes.txt>
 *
 * figma-boxes.txt comes from running figma-boxes.js through the Figma MCP `use_figma` tool.
 * Writes <out>/report.json and <out>/<n>-<slug>.png (Figma red, page blue) per section;
 * exits 1 when structure fails or a compared section is below threshold.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDeps } from './deps.js';
import { evaluateWithSections, figmaSlug, loadConfig } from './config.js';

// Resolved from the plugin's own package.json, installed on first use if missing.
const { chromium, PNG } = await loadDeps();

const DEFAULTS = {
	threshold: 0.85,
	tolerance: 8,
	viewportHeight: 900,
};

function parseArgs( argv ) {
	const args = { ...DEFAULTS };
	for ( let i = 0; i < argv.length; i++ ) {
		const key = argv[ i ].replace( /^--/, '' ).replace( /-([a-z])/g, ( m, c ) => c.toUpperCase() );
		args[ key ] = argv[ ++i ];
	}
	for ( const n of [ 'width', 'threshold', 'tolerance', 'viewportHeight' ] ) {
		args[ n ] = Number( args[ n ] );
	}
	for ( const required of [ 'url', 'width', 'out', 'figma' ] ) {
		if ( ! args[ required ] ) {
			throw new Error( `Missing --${ required }` );
		}
	}
	// --mask/--live override the project config; sections whose copy comes from live posts
	// are compared on geometry only.
	args.config = loadConfig( args.config );
	args.mask = args.mask ?? args.config.mask.join( ',' );
	args.live = args.live ?? args.config.live.join( ',' );
	return args;
}

// Must match normText()/hash() in figma-boxes.js.
export const normText = ( s ) => s.normalize( 'NFKD' ).replace( /[‘’]/g, "'" ).replace( /[“”]/g, '"' ).replace( /[–—]/g, '-' ).replace( /\s+/g, ' ' ).trim().toLowerCase();
export const hash = ( s ) => {
	let h = 5381;
	for ( let i = 0; i < s.length; i++ ) {
		h = ( ( h * 33 ) ^ s.charCodeAt( i ) ) >>> 0;
	}
	return h.toString( 16 );
};

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
			sections[ Number( f[ 1 ] ) ].boxes.push( { type: f[ 2 ], x: Number( f[ 3 ] ), y: Number( f[ 4 ] ), w: Number( f[ 5 ] ), h: Number( f[ 6 ] ), hash: f[ 7 ] || null, text: f[ 8 ] || null } );
		}
	}
	if ( ! frame.width || ! sections.length ) {
		throw new Error( `${ file } holds no frame or sections; re-run figma-boxes.js.` );
	}
	return { frame, sections };
}

export function chromiumPath() {
	if ( fs.existsSync( chromium.executablePath() ) ) {
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

/**
 * Runs in the page: typed leaf boxes per top-level block, section-relative.
 * Mirrors figma-boxes.js so both sides describe the same primitives.
 */
export function extractPageBoxes( detect, cfg ) {
	const iconClass = new RegExp( cfg.iconClassPattern );
	const vw = document.documentElement.clientWidth;
	const alpha = ( c ) => {
		const m = /rgba?\(([^)]+)\)/.exec( c || '' );
		if ( ! m ) {
			return 0;
		}
		const parts = m[ 1 ].split( /[,\s/]+/ ).filter( Boolean );
		return parts.length > 3 ? parseFloat( parts[ 3 ] ) : 1;
	};
	const inlineOnly = ( el ) => [ ...el.children ].every( ( c ) => 'BR' === c.tagName || getComputedStyle( c ).display.startsWith( 'inline' ) && ! /^(IMG|SVG|VIDEO|IFRAME)$/i.test( c.tagName ) );

	return detect( cfg ).map( ( { el: sec, slug } ) => {
		const sr = sec.getBoundingClientRect();
		const boxes = [];
		const push = ( type, r, text ) => {
			const x = r.left - sr.left;
			if ( r.width < 1 || r.height < 1 || x >= vw || x + r.width <= 0 ) {
				return;
			}
			const b = { type, x: Math.round( x ), y: Math.round( r.top - sr.top ), w: Math.round( r.width ), h: Math.round( r.height ) };
			if ( undefined !== text ) {
				b.text = text;
			}
			boxes.push( b );
		};
		// Icon-font glyphs and masked icons drawn by ::before/::after (e.g. list checkmarks).
		const pseudoIcon = ( el, r ) => {
			for ( const which of [ '::before', '::after' ] ) {
				const s = getComputedStyle( el, which );
				if ( 'none' === s.content || 'normal' === s.content ) {
					continue;
				}
				const w = parseFloat( s.width );
				const h = parseFloat( s.height );
				if ( ! ( w > 0 && h > 0 && w <= 64 && h <= 64 ) ) {
					// An icon-font glyph with no explicit size (e.g. an arrow button): the empty,
					// icon-sized element is the icon's box.
					if ( '""' !== s.content && ! el.textContent.trim() && ! el.children.length && r.width <= 64 && r.height <= 64 ) {
						push( 'icon', r );
						return;
					}
					continue;
				}
				const left = 'absolute' === s.position ? parseFloat( s.left ) || 0 : 0;
				const top = 'absolute' === s.position ? parseFloat( s.top ) || 0 : parseFloat( s.marginTop ) || 0;
				push( 'icon', { left: r.left + left, top: r.top + top, width: w, height: h } );
			}
		};
		// textDone: an ancestor already emitted this text; still collect icons and media inside it.
		const walk = ( el, isRoot, textDone = false ) => {
			if ( el.checkVisibility && ! el.checkVisibility( { opacityProperty: true, visibilityProperty: true } ) ) {
				return;
			}
			const cs = getComputedStyle( el );
			const r = el.getBoundingClientRect();
			const tag = el.tagName.toUpperCase();
			if ( /^(IMG|VIDEO|IFRAME|CANVAS)$/.test( tag ) ) {
				push( 'image', r );
				return;
			}
			if ( 'SVG' === tag ) {
				push( 'icon', r );
				return;
			}
			if ( iconClass.test( el.className ) && ! el.textContent.trim() ) {
				push( 'icon', r );
				return;
			}
			if ( /url\(/.test( cs.backgroundImage ) ) {
				push( 'image', r );
			}
			const border = [ 'Top', 'Right', 'Bottom', 'Left' ].some( ( s ) => parseFloat( cs[ `border${ s }Width` ] ) > 0 && alpha( cs[ `border${ s }Color` ] ) > 0.01 );
			if ( ! isRoot && r.width < vw - 1 && ( alpha( cs.backgroundColor ) > 0.01 || border || 'none' !== cs.boxShadow ) ) {
				push( 'surface', r );
			}
			pseudoIcon( el, r );
			if ( ! textDone && el.textContent.trim() && inlineOnly( el ) ) {
				const range = document.createRange();
				range.selectNodeContents( el );
				const rects = [ ...range.getClientRects() ].filter( ( q ) => q.width > 0 && q.height > 0 );
				if ( rects.length ) {
					const left = Math.min( ...rects.map( ( q ) => q.left ) );
					const top = Math.min( ...rects.map( ( q ) => q.top ) );
					push( 'text', { left, top, width: Math.max( ...rects.map( ( q ) => q.right ) ) - left, height: Math.max( ...rects.map( ( q ) => q.bottom ) ) - top }, el.innerText || el.textContent );
				}
				textDone = true;
			}
			for ( const child of el.children ) {
				walk( child, false, textDone );
			}
		};
		walk( sec, true );
		return { slug, y: sr.top + window.scrollY, height: sr.height, boxes };
	} );
}

/**
 * Load the page and bring it to its settled state, reloading when a stylesheet, script or
 * font failed: a half-styled page would produce confident but meaningless verdicts.
 *
 * @param {import('playwright').Page} page Fresh page.
 * @param {string}                    url  Page URL.
 */
export async function loadPage( page, url ) {
	let failures = [];
	const watched = new Set( [ 'stylesheet', 'script', 'font' ] );
	page.on( 'requestfailed', ( r ) => watched.has( r.resourceType() ) && failures.push( `${ r.resourceType() } ${ r.url() } (${ r.failure()?.errorText })` ) );
	page.on( 'response', ( r ) => watched.has( r.request().resourceType() ) && r.status() >= 400 && failures.push( `${ r.request().resourceType() } ${ r.url() } (${ r.status() })` ) );
	for ( let attempt = 1; attempt <= 3; attempt++ ) {
		failures = [];
		await page.goto( url, { waitUntil: 'networkidle' } );
		await prepareForCapture( page );
		const unloaded = await page.evaluate( () => [ ...document.querySelectorAll( 'link[rel="stylesheet"]' ) ].filter( ( l ) => ! l.sheet && ! l.disabled && ( ! l.media || matchMedia( l.media ).matches ) ).map( ( l ) => `stylesheet ${ l.href } (not applied)` ) );
		failures.push( ...unloaded );
		if ( ! failures.length ) {
			return;
		}
	}
	throw new Error( `Page resources kept failing, so the page can't be compared reliably:\n  ${ failures.slice( 0, 5 ).join( '\n  ' ) }` );
}

/**
 * Bring the page to the state a visitor sees: run scripts that wait for interaction
 * (e.g. WP Rocket's delayed JS), load lazy media, and park every slider on its first
 * slide so captures don't depend on timing.
 *
 * @param {import('playwright').Page} page Loaded page.
 */
export async function prepareForCapture( page ) {
	await page.mouse.move( 5, 5 );
	await page.mouse.move( 50, 50 );
	await page.keyboard.press( 'Shift' );
	await page.waitForLoadState( 'networkidle' );
	await page.addStyleTag( { content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' } );
	await page.evaluate( async () => {
		const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );
		// Native lazy images skipped while scrolling never load, and sit stable at their
		// placeholder size; load them all eagerly.
		for ( const img of document.querySelectorAll( 'img[loading="lazy"]' ) ) {
			img.loading = 'eager';
		}
		for ( let y = 0; y < document.body.scrollHeight; y += 400 ) {
			window.scrollTo( 0, y );
			await sleep( 120 );
		}
		window.scrollTo( 0, 0 );
		await document.fonts.ready;
		await Promise.race( [
			Promise.all( [ ...document.images ].filter( ( img ) => ! img.complete ).map( ( img ) => new Promise( ( resolve ) => {
				img.addEventListener( 'load', resolve, { once: true } );
				img.addEventListener( 'error', resolve, { once: true } );
			} ) ) ),
			sleep( 15000 ),
		] );
		// Lazy loaders swap placeholder sources after scrolling, and placeholders already
		// count as complete, so wait until the page stops changing instead.
		// Stylesheets count too: CSS deferred until interaction can land late and resize media.
		const signature = () => [ document.body.scrollHeight, document.styleSheets.length, ...[ ...document.images ].map( ( img ) => `${ img.currentSrc }:${ img.complete }:${ Math.round( img.getBoundingClientRect().height ) }` ) ].join( '|' );
		let last = '';
		for ( let i = 0, stable = 0; i < 80 && stable < 8; i++ ) {
			await sleep( 250 );
			const now = signature();
			stable = now === last ? stable + 1 : 0;
			last = now;
		}
		for ( const el of document.querySelectorAll( '.swiper' ) ) {
			el.swiper?.autoplay?.stop();
			// Looping sliders clone slides, so index 0 is a clone; slideToLoop targets the real first slide.
			if ( el.swiper?.params?.loop ) {
				el.swiper.slideToLoop( 0, 0 );
			} else {
				el.swiper?.slideTo( 0, 0 );
			}
		}
	} );
	await page.waitForTimeout( 200 );
}

async function capturePage( args ) {
	const browser = await chromium.launch( { executablePath: chromiumPath() } );
	try {
		const page = await browser.newPage( { viewport: { width: args.width, height: args.viewportHeight }, deviceScaleFactor: 1, reducedMotion: 'reduce', ignoreHTTPSErrors: true } );
		await loadPage( page, args.url );
		const sections = await evaluateWithSections( page, extractPageBoxes, args.config );
		for ( const s of sections ) {
			for ( const b of s.boxes ) {
				if ( undefined !== b.text ) {
					b.full = normText( b.text );
					b.hash = hash( b.full );
					b.text = b.full.slice( 0, 28 );
				}
			}
		}
		return sections;
	} finally {
		await browser.close();
	}
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

/**
 * One Figma text layer can hold several paragraphs the page renders as separate
 * elements. Merge a run of consecutive page text boxes whose joined text hashes to
 * an unmatched Figma text box, so granularity differences don't read as copy changes.
 */
export function mergeTextRuns( fig, pg ) {
	const out = [ ...pg ];
	const pageHashes = new Set( pg.map( ( p ) => p.hash ).filter( Boolean ) );
	for ( const f of fig ) {
		if ( 'text' !== f.type || ! f.hash || pageHashes.has( f.hash ) ) {
			continue;
		}
		for ( let j = 0; j < out.length; j++ ) {
			// Figma keeps a 28-character prefix, which can run past a short first paragraph.
			const prefix = f.text.trim();
			const n = out[ j ].full ? Math.min( prefix.length, out[ j ].full.length ) : 0;
			if ( 'text' !== out[ j ].type || ! n || out[ j ].full.slice( 0, n ) !== prefix.slice( 0, n ) ) {
				continue;
			}
			let joined = '';
			for ( let k = j; k < out.length && k - j < 12 && 'text' === out[ k ].type; k++ ) {
				joined = joined ? `${ joined } ${ out[ k ].full }` : out[ k ].full;
				if ( k > j && hash( joined ) === f.hash ) {
					const run = out.slice( j, k + 1 );
					const x = Math.min( ...run.map( ( b ) => b.x ) );
					const y = Math.min( ...run.map( ( b ) => b.y ) );
					const merged = { type: 'text', x, y, w: Math.max( ...run.map( ( b ) => b.x + b.w ) ) - x, h: Math.max( ...run.map( ( b ) => b.y + b.h ) ) - y, full: joined, hash: f.hash, text: joined.slice( 0, 28 ) };
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
 * Pair Figma and page boxes of the same type. Identical text pairs first at any
 * distance; those pairs then anchor the rest, so every other box is looked for where
 * its nearest anchor moved it. Large drift inside a section (e.g. vh-sized panels)
 * then reads as drift, not as elements missing in one place and extra in another.
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
 * Matched area weighted by overlap, over Figma's area plus unmatched page area. A section
 * Figma draws empty scores 1 only if the page adds nothing either.
 *
 * @param {Array}  fig   Figma boxes.
 * @param {Object} match matchBoxes() result.
 * @return {number} Score in [0, 1].
 */
export function sectionScore( fig, match ) {
	const area = ( b ) => b.w * b.h;
	const figArea = fig.reduce( ( s, b ) => s + area( b ), 0 );
	const extraArea = match.extra.reduce( ( s, b ) => s + area( b ), 0 );
	if ( ! figArea ) {
		return match.extra.length ? 0 : 1;
	}
	return match.pairs.reduce( ( s, m ) => s + m.overlap * area( m.f ), 0 ) / ( figArea + extraArea );
}

const COLORS = { figma: [ 230, 40, 40 ], page: [ 30, 90, 230 ] };

function drawBox( png, b, color, thick ) {
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

/**
 * Space between a section's edges and its content, per side. Backgrounds (images or
 * surfaces covering most of the section) aren't content, so they don't count.
 *
 * @param {Array}  boxes  Section boxes.
 * @param {number} width  Section width.
 * @param {number} height Section height.
 * @return {{top: number, right: number, bottom: number, left: number}|null} Null when empty.
 */
export function paddingOf( boxes, width, height ) {
	// Clip to the section: off-screen slides and overflow aren't where content visibly sits.
	const content = boxes
		.filter( ( b ) => ! ( b.w >= 0.8 * width && b.h >= 0.8 * height ) )
		.map( ( b ) => {
			const x = Math.max( 0, b.x );
			return { ...b, x, w: Math.min( width, b.x + b.w ) - x };
		} )
		.filter( ( b ) => b.w > 0 );
	if ( ! content.length ) {
		return null;
	}
	const top = Math.min( ...content.map( ( b ) => b.y ) );
	const left = Math.min( ...content.map( ( b ) => b.x ) );
	const bottom = Math.max( ...content.map( ( b ) => b.y + b.h ) );
	const right = Math.max( ...content.map( ( b ) => b.x + b.w ) );
	return { top: Math.round( top ), right: Math.round( width - right ), bottom: Math.round( height - bottom ), left: Math.round( left ) };
}

/** Blend a translucent colour over a rectangle. */
function tint( png, x, y, w, h, color, alpha ) {
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

/** Shade a section's four padding bands; overlapping Figma and page bands read purple. */
function shadePadding( png, pad, width, height, color ) {
	if ( ! pad ) {
		return;
	}
	tint( png, 0, 0, width, pad.top, color, 0.18 );
	tint( png, 0, height - pad.bottom, width, pad.bottom, color, 0.18 );
	tint( png, 0, pad.top, pad.left, height - pad.top - pad.bottom, color, 0.18 );
	tint( png, width - pad.right, pad.top, pad.right, height - pad.top - pad.bottom, color, 0.18 );
}

function renderOverlay( width, height, match, figmaSection, pageSection ) {
	const png = new PNG( { width, height: Math.max( 1, Math.ceil( height ) ) } );
	png.data.fill( 255 );
	if ( figmaSection && pageSection ) {
		shadePadding( png, paddingOf( figmaSection.boxes, width, figmaSection.height ), width, figmaSection.height, COLORS.figma );
		shadePadding( png, paddingOf( pageSection.boxes, width, pageSection.height ), width, pageSection.height, COLORS.page );
		// Each side's section bottom, so a height difference is visible at a glance.
		drawBox( png, { x: 0, y: figmaSection.height - 1, w: width - 1, h: 0 }, COLORS.figma, 2 );
		drawBox( png, { x: 0, y: pageSection.height - 1, w: width - 1, h: 0 }, COLORS.page, 2 );
	}
	for ( const { f, p } of match.pairs ) {
		drawBox( png, f, COLORS.figma, 1 );
		drawBox( png, p, COLORS.page, 1 );
	}
	for ( const f of match.missing ) {
		drawBox( png, f, COLORS.figma, 4 );
	}
	for ( const p of match.extra ) {
		drawBox( png, p, COLORS.page, 4 );
	}
	return png;
}

async function main() {
	const args = parseArgs( process.argv.slice( 2 ) );
	fs.mkdirSync( args.out, { recursive: true } );
	const figma = parseFigma( args.figma, args.config );
	const list = ( v ) => new Set( String( v ).split( ',' ).map( ( s ) => s.trim() ).filter( ( s ) => s && 'none' !== s ) );
	const masked = list( args.mask );
	const live = list( args.live );
	const page = await capturePage( args );
	fs.writeFileSync( path.join( args.out, 'page-boxes.json' ), JSON.stringify( page.map( ( s ) => ( { slug: s.slug, y: Math.round( s.y ), height: Math.round( s.height ), boxes: s.boxes.map( ( { full, ...b } ) => b ) } ) ), null, '\t' ) );

	const { pairs: sectionPairs, byOrder } = pairSections( figma.sections.map( ( s ) => s.slug ), page.map( ( s ) => s.slug ) );
	const matchedF = new Set( sectionPairs.map( ( [ i ] ) => i ) );
	const matchedP = new Set( sectionPairs.map( ( [ , j ] ) => j ) );
	const missing = figma.sections.map( ( s, i ) => ( { index: i + 1, slug: s.slug, figma: s.name } ) ).filter( ( s, i ) => ! matchedF.has( i ) );
	const extra = page.map( ( s, j ) => ( { index: j + 1, slug: s.slug } ) ).filter( ( s, j ) => ! matchedP.has( j ) );
	const moved = missing.filter( ( m ) => extra.some( ( e ) => e.slug === m.slug ) ).map( ( m ) => m.slug );
	const warnings = byOrder ? [ 'Section names did not match Figma, so sections were paired by position. Set sectionMap or slugPatterns in .figma-visual-diff.json.' ] : [];

	const t = args.tolerance;
	const results = [];
	for ( const [ i, j ] of sectionPairs ) {
		const fs0 = figma.sections[ i ];
		const ps = page[ j ];
		const entry = { index: i + 1, slug: fs0.slug, figma: fs0.name, figmaHeight: fs0.height, pageHeight: Math.round( ps.height ), heightDelta: Math.round( ps.height - fs0.height ) };
		if ( masked.has( fs0.slug ) ) {
			results.push( { ...entry, status: 'masked', reason: 'dynamic content' } );
			continue;
		}
		const match = matchBoxes( fs0.boxes, mergeTextRuns( fs0.boxes, ps.boxes ), t );
		const area = ( b ) => b.w * b.h;
		const score = sectionScore( fs0.boxes, match );
		const describe = ( b ) => `${ b.type } ${ b.w }×${ b.h } at ${ b.x },${ b.y }${ b.text ? ` "${ b.text }"` : '' }`;
		const offsets = match.pairs
			.map( ( m ) => ( { ...m, dx: m.p.x - m.f.x, dy: m.p.y - m.f.y, dw: m.p.w - m.f.w, dh: m.p.h - m.f.h } ) )
			.filter( ( m ) => Math.max( Math.abs( m.dx ), Math.abs( m.dy ), Math.abs( m.dw ), Math.abs( m.dh ) ) > t )
			.sort( ( a, b ) => ( a.overlap - b.overlap ) )
			.slice( 0, 12 )
			.map( ( m ) => ( { element: describe( m.f ), dx: m.dx, dy: m.dy, dw: m.dw, dh: m.dh } ) );
		const copy = live.has( fs0.slug ) ? [] : match.pairs.filter( ( m ) => 'text' === m.f.type && m.f.hash !== m.p.hash ).map( ( m ) => ( { figma: m.f.text, page: m.p.text } ) );
		const median = ( values ) => {
			const v = [ ...values ].sort( ( a, b ) => a - b );
			return v.length ? v[ Math.floor( v.length / 2 ) ] : 0;
		};
		// Same size, moved sideways: an alignment difference on that element (e.g. centred vs left).
		const shifted = match.pairs
			.filter( ( m ) => ! ( live.has( fs0.slug ) && 'text' === m.f.type ) )
			.filter( ( m ) => Math.abs( m.p.x - m.f.x ) >= 40 && Math.abs( m.p.w - m.f.w ) <= 2 * t && Math.abs( ( m.p.x + m.p.w / 2 ) - ( m.f.x + m.f.w / 2 ) ) >= 40 )
			.map( ( m ) => ( { element: describe( m.f ), dx: m.p.x - m.f.x } ) );
		// Consistent drift across all matched boxes: sideways means alignment, vertical means spacing.
		const drift = {
			dx: median( match.pairs.map( ( m ) => m.p.x - m.f.x ) ),
			dy: median( match.pairs.map( ( m ) => m.p.y - m.f.y ) ),
			resized: match.pairs.filter( ( m ) => Math.abs( m.p.w - m.f.w ) > t || Math.abs( m.p.h - m.f.h ) > t ).length,
		};
		const file = `${ String( i + 1 ).padStart( 2, '0' ) }-${ fs0.slug }.png`;
		fs.writeFileSync( path.join( args.out, file ), PNG.sync.write( renderOverlay( args.width, Math.max( fs0.height, ps.height ), match, fs0, ps ) ) );
		const structural = live.has( fs0.slug ) ? match.missing.filter( ( b ) => 'text' !== b.type ) : match.missing;
		const pass = score >= args.threshold && ! structural.length && ! copy.length && ! shifted.length;
		results.push( {
			...entry,
			status: pass ? 'pass' : 'fail',
			live: live.has( fs0.slug ),
			score: Number( score.toFixed( 4 ) ),
			boxes: { figma: fs0.boxes.length, page: ps.boxes.length, matched: match.pairs.length },
			missing: match.missing.map( describe ),
			extra: match.extra.map( describe ),
			copy,
			shifted,
			drift,
			padding: ( () => {
				const figma = paddingOf( fs0.boxes, args.width, fs0.height );
				const pagePad = paddingOf( ps.boxes, args.width, ps.height );
				if ( ! figma || ! pagePad ) {
					return null;
				}
				const delta = Object.fromEntries( Object.keys( figma ).map( ( k ) => [ k, pagePad[ k ] - figma[ k ] ] ) );
				return { figma, page: pagePad, delta };
			} )(),
			offsets,
			image: file,
		} );
	}

	const compared = results.filter( ( r ) => undefined !== r.score );
	const report = {
		url: args.url,
		width: args.width,
		threshold: args.threshold,
		pass: ! missing.length && ! extra.length && compared.every( ( r ) => 'pass' === r.status ),
		pageScore: Number( ( compared.reduce( ( s, r ) => s + r.score, 0 ) / ( compared.length || 1 ) ).toFixed( 4 ) ),
		structure: { figmaSections: figma.sections.length, pageSections: page.length, missing, extra, moved, byOrder },
		warnings,
		sections: results,
	};
	fs.writeFileSync( path.join( args.out, 'report.json' ), JSON.stringify( report, null, '\t' ) );

	const pct = ( n ) => `${ ( n * 100 ).toFixed( 1 ) }%`;
	console.log( `${ report.pass ? 'PASS' : 'FAIL' } ${ args.width }px  mean section score ${ pct( report.pageScore ) }  (threshold ${ pct( args.threshold ) }, tolerance ${ t }px)` );
	for ( const w of warnings ) {
		console.log( `  warning: ${ w }` );
	}
	for ( const m of missing ) {
		console.log( `  missing section #${ m.index } ${ m.slug }${ moved.includes( m.slug ) ? ' (moved)' : '' }` );
	}
	for ( const e of extra ) {
		console.log( `  extra   page block #${ e.index } ${ e.slug }${ moved.includes( e.slug ) ? ' (moved)' : '' }` );
	}
	for ( const r of results ) {
		if ( 'masked' === r.status ) {
			console.log( `  masked #${ String( r.index ).padStart( 2 ) } ${ r.slug }` );
			continue;
		}
		console.log( `  ${ r.status.padEnd( 6 ) } #${ String( r.index ).padStart( 2 ) } ${ r.slug.padEnd( 28 ) } ${ pct( r.score ).padStart( 6 ) }  Δh ${ r.heightDelta > 0 ? '+' : '' }${ r.heightDelta }px  boxes ${ r.boxes.matched }/${ r.boxes.figma } (+${ r.extra.length } extra)${ r.copy.length ? `  copy×${ r.copy.length }` : '' }` );
	}
	console.log( `  report: ${ path.join( args.out, 'report.json' ) }` );
	process.exitCode = report.pass ? 0 : 1;
}

if ( import.meta.url === `file://${ process.argv[ 1 ] }` ) {
	main().catch( ( error ) => {
		console.error( error.stack || error.message );
		process.exitCode = 2;
	} );
}
