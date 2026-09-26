/**
 * The browser side of a capture: find Chromium, load the page with its caches skipped, and
 * bring it to the settled state a visitor sees before anything is measured.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDeps } from '../deps.js';

const { chromium } = await loadDeps();

/**
 * Playwright's bundled Chromium, else the newest build in its download cache.
 *
 * @return {string|undefined} Executable path; undefined when the bundled one exists.
 * @throws {Error} When no Chromium is installed.
 */
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
 * The page URL with a unique query parameter. Page caches (WP Rocket, most server caches)
 * skip URLs with query strings, so every capture sees the page as it is now rather than a
 * copy cached before the last style or content change.
 *
 * @param {string} url   Page URL.
 * @param {number} stamp Unique value (defaults to now).
 * @return {string} URL to load.
 */
export function cacheBusted( url, stamp = Date.now() ) {
	const u = new URL( url );
	u.searchParams.set( 'fvd', String( stamp ) );
	return u.href;
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
		await page.goto( cacheBusted( url ), { waitUntil: 'networkidle' } );
		await prepareForCapture( page );
		// A stylesheet link can load without applying (blocked, or swapped by an optimiser).
		const unloaded = await page.evaluate( () => [ ...document.querySelectorAll( 'link[rel="stylesheet"]' ) ]
			.filter( ( l ) => ! l.sheet && ! l.disabled && ( ! l.media || matchMedia( l.media ).matches ) )
			.map( ( l ) => `stylesheet ${ l.href } (not applied)` ) );
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
		// Scroll through the page so scroll-triggered content loads; capped so an infinite
		// scroll can't keep the capture going forever.
		for ( let y = 0, steps = 0; y < document.body.scrollHeight && steps < 500; y += 400, steps++ ) {
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
		const imageState = ( img ) => `${ img.currentSrc }:${ img.complete }:${ Math.round( img.getBoundingClientRect().height ) }`;
		const signature = () => [ document.body.scrollHeight, document.styleSheets.length, ...[ ...document.images ].map( imageState ) ].join( '|' );
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

/**
 * Open the page at a breakpoint, settled, and run `fn( page )` on it.
 *
 * @param {Object}   options                Capture settings.
 * @param {string}   options.url            Page URL.
 * @param {number}   options.width          Viewport width (the Figma frame's width).
 * @param {number}   options.viewportHeight Viewport height; vh-sized sections size from it.
 * @param {Function} fn                     Receives the Playwright page.
 * @return {Promise<*>} What `fn` returns.
 */
export async function withLoadedPage( { url, width, viewportHeight }, fn ) {
	const browser = await chromium.launch( { executablePath: chromiumPath() } );
	try {
		const page = await browser.newPage( {
			viewport: { width, height: viewportHeight },
			deviceScaleFactor: 1,
			reducedMotion: 'reduce',
			ignoreHTTPSErrors: true,
		} );
		await loadPage( page, url );
		return await fn( page );
	} finally {
		await browser.close();
	}
}
