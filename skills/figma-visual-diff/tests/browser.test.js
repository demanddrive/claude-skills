// Browser-side extraction on a synthetic page: no network, but needs Playwright's Chromium.
//   node --test tests/browser.test.js   (skipped when Chromium isn't installed)

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, evaluateWithSections } from '../scripts/config.js';
import { chromiumPath, extractPageBoxes } from '../scripts/wireframe-diff.js';

let chromium;
let executablePath;
try {
	( { chromium } = await import( 'playwright' ) );
	executablePath = chromiumPath();
} catch {
	chromium = null;
}

test( 'an icon-font glyph on an empty button is extracted as an icon', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		await page.setContent( `<style>
			body { margin: 0 } .arrow { width: 40px; height: 40px; border: 0; background: none; padding: 0 }
			.arrow::after { content: "\\2192"; font-size: 24px }
		</style>
		<main><section class="block-slider"><p>Slides</p><button class="arrow" aria-label="Next"></button></section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		assert.equal( section.slug, 'slider' );
		const icons = section.boxes.filter( ( b ) => 'icon' === b.type );
		assert.equal( icons.length, 1, JSON.stringify( section.boxes ) );
		const button = await page.evaluate( () => {
			const r = document.querySelector( '.arrow' ).getBoundingClientRect();
			return [ Math.round( r.width ), Math.round( r.height ) ];
		} );
		assert.deepEqual( [ icons[ 0 ].w, icons[ 0 ].h ], button, 'the icon box is the button box' );
	} finally {
		await browser.close();
	}
} );
