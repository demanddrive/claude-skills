// Browser-side extraction on a synthetic page: no network, but needs Playwright's Chromium.
//   node --test tests/browser.test.js   (skipped when Chromium isn't installed)

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from '../scripts/config.js';
import { chromiumPath } from '../scripts/lib/browser.js';
import { paddingOf } from '../scripts/lib/boxes.js';
import { evaluateWithSections, extractPageBoxes, measureTwice } from '../scripts/lib/page.js';

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

test( 'a pseudo-element icon is measured where the layout puts it', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		// A flex-centred arrow, a checkmark after a list item's padding, one placed by a transform.
		await page.setContent( `<style>
			body { margin: 0 } ul { margin: 0; padding: 0; list-style: none }
			.arrow { display: flex; align-items: center; justify-content: center; width: 52px; height: 52px; border: 0; padding: 0; background: #eee }
			.arrow::after { content: ""; display: block; width: 20px; height: 20px; background: #000 }
			li { display: flex; gap: 12px; padding-left: 10px }
			li::before { content: ""; width: 24px; height: 24px; background: #000; flex: none }
			.moved { position: relative; width: 100px; height: 100px }
			.moved::before { content: ""; position: absolute; left: 50%; top: 50%; width: 20px; height: 20px; transform: translate(-50%, -50%); background: #000 }
		</style>
		<main><section class="block-parts"><button class="arrow" aria-label="Next"></button><ul><li>Checked item</li></ul><div class="moved"></div></section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		const icons = section.boxes.filter( ( b ) => 'icon' === b.type ).map( ( { x, y, w, h } ) => [ x, y, w, h ] );
		assert.deepEqual( icons, [ [ 16, 16, 20, 20 ], [ 10, 52, 24, 24 ], [ 40, 116, 20, 20 ] ] );
		assert.equal( await page.evaluate( () => document.querySelectorAll( '[data-fvd-pseudo], span' ).length ), 0, 'the page is left as it was' );
	} finally {
		await browser.close();
	}
} );

test( 'boxes measured at a second, taller viewport show what moves with the viewport\'s height', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		await page.setContent( `<style>
			body { margin: 0 } section { padding: 40px }
			.slide { min-height: 100vh; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box }
			p { margin: 0 0 20px }
		</style>
		<main><section class="block-fixed"><p>Fixed title</p><p>Fixed text</p></section>
		<section class="block-slide"><div class="slide"><p>Slide title</p><p>Slide text</p></div></section></main>` );
		const [ fixed, slide ] = await measureTwice( page, DEFAULT_CONFIG );
		const moved = ( b ) => b.alt.y - b.y;
		assert.deepEqual( fixed.boxes.map( moved ), [ 0, 0 ], 'nothing in a fixed section moves' );
		assert.equal( fixed.altHeight, fixed.height );
		assert.deepEqual( slide.boxes.map( moved ), [ 150, 150 ], 'a 100vh slide centres its content lower' );
		assert.equal( slide.altHeight - slide.height, 300 );
		assert.deepEqual( page.viewportSize(), { width: 800, height: 600 }, 'the viewport is put back' );
	} finally {
		await browser.close();
	}
} );

test( 'what a boxless or zero-size wrapper holds is still extracted', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		await page.setContent( `<style>
			body { margin: 0 } section { position: relative; height: 300px } p { margin: 0 }
			.contents { display: contents } .anchor { position: relative; width: 0; height: 0 }
			.pinned { position: absolute; top: 100px; left: 40px; width: 200px }
			.sr { position: absolute; width: 1px; height: 1px; overflow: hidden }
		</style>
		<main><section class="block-wrappers"><div class="contents"><p>Inside contents</p></div><div class="anchor"><p class="pinned">Pinned text</p></div><div class="sr"><p>Screen reader only</p></div></section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		assert.deepEqual( section.boxes.filter( ( b ) => 'text' === b.type ).map( ( b ) => b.text ), [ 'Inside contents', 'Pinned text' ] );
	} finally {
		await browser.close();
	}
} );

test( 'text records its CSS margins, so padding is measured the same whether or not the theme drops the last margin', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		// Two intro sections, 72px bottom padding each; the heading has a 20px bottom margin.
		// .cms drops the last child's margin (as the Impulse theme does); .plain keeps it.
		await page.setContent( `<style>
			body { margin: 0 } section { padding: 104px 68px 72px; display: flow-root }
			h2 { margin: 0 0 20px; font: 56px/1.2 sans-serif } p { margin: 0 0 12px; font: 17px/1.6 sans-serif }
			.cms > :last-child { margin-bottom: 0 }
		</style>
		<main>
			<section class="block-intro-a"><div class="cms"><p>Who we work with</p><h2>Built for every property type</h2></div></section>
			<section class="block-intro-b"><div class="plain"><p>Who we work with</p><h2>Built for every property type</h2></div></section>
		</main>` );
		const sections = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		const heading = ( s ) => s.boxes.find( ( b ) => 'text' === b.type && b.text.startsWith( 'Built' ) );
		assert.equal( heading( sections[ 0 ] ).mb, 0, 'the theme dropped the last margin' );
		assert.equal( heading( sections[ 1 ] ).mb, 20 );
		assert.equal( sections[ 0 ].boxes.find( ( b ) => b.text?.startsWith( 'Who' ) ).mb, 12 );
		// Text boxes are line boxes, as Figma's text layers are: the heading wraps to two 67.2px
		// lines (56px × 1.2), not two glyph boxes. So padding is exact.
		assert.equal( heading( sections[ 0 ] ).h, 134 );
		const [ dropped, kept ] = sections.map( ( s ) => paddingOf( s.boxes, 800, s.height ).bottom );
		assert.equal( dropped, kept, 'the same padding whether or not the last margin is dropped' );
		assert.ok( Math.abs( dropped - 72 ) <= 1, `${ dropped } is the CSS padding, 72` );
	} finally {
		await browser.close();
	}
} );

test( 'text and surfaces record their design tokens from computed CSS', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		await page.setContent( `<style>
			body { margin: 0 } h3 { font: 700 28px/1.3 "Barlow", sans-serif; color: #3d3d3d; margin: 0 }
			.pill { width: 85px; height: 85px; background: #2c3f13; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px }
			.meta { font: 400 17px/1.6 "Barlow", sans-serif; color: #3d3d3d; } .meta b { font-weight: 700 }
			.centred { text-align: center; margin: 0 }
			.bulleted { list-style: none; padding: 0 0 0 42px; margin: 0 }
		</style>
		<main><section class="block-cards"><div class="pill"></div><h3>Quality</h3><p class="meta"><b>2026</b> | Dallas, TX</p><p class="centred">Centred</p><ul style="margin:0;padding:0"><li class="bulleted">Bulleted item</li></ul></section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		const text = section.boxes.find( ( b ) => 'text' === b.type );
		assert.deepEqual( text.style, { font: 'Barlow', size: '28', lh: '36.4', weight: '700', color: '#3d3d3d', align: 'left' } );
		assert.equal( section.boxes.find( ( b ) => 'Centred' === b.text ).style.align, 'center', 'text-align, as Figma names it' );
		const centred = section.boxes.find( ( b ) => 'Centred' === b.text );
		assert.deepEqual( [ centred.lx, centred.lw ], [ 0, 800 ], 'its layout box: the paragraph, not its ink' );
		assert.ok( centred.w < 200 );
		const bulleted = section.boxes.find( ( b ) => 'Bulleted item' === b.text );
		assert.deepEqual( [ bulleted.lx, bulleted.lw ], [ 42, 758 ], 'inside its padding, where the bullet sits' );
		// Mixed styles: the first character's, as Figma records a text layer's.
		const meta = section.boxes.find( ( b ) => 'text' === b.type && b.text.startsWith( '2026' ) );
		assert.equal( meta.style.weight, '700' );
		const pill = section.boxes.find( ( b ) => 'surface' === b.type );
		assert.deepEqual( pill.style, { fill: '#2c3f13', radius: '4', stroke: '#ffffff33/1' } );
	} finally {
		await browser.close();
	}
} );

test( 'what isn\'t on screen isn\'t extracted: clipped slides, screen-reader text; a background icon is an icon', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		await page.setContent( `<style>
			body { margin: 0 } p { margin: 0; font: 16px/1.5 sans-serif }
			.slider { width: 400px; margin-left: 400px; overflow: hidden } .track { display: flex; transform: translateX(-400px) } .slide { flex: 0 0 400px }
			.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%) }
			select { appearance: none; width: 300px; height: 48px; border: 1px solid #e0e0e0; background: #f4f4f4 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'/%3E") no-repeat calc(100% - 18px) 50% / 20px 20px }
		</style>
		<main><section class="block-demo">
			<div class="slider"><div class="track"><div class="slide"><p>Hidden slide</p></div><div class="slide"><p>Visible slide</p></div></div></div>
			<span class="sr">Contact Us</span>
			<select><option></option></select>
		</section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		const texts = section.boxes.filter( ( b ) => 'text' === b.type ).map( ( b ) => b.text );
		// The hidden slide sits at x 0–400, on screen, but outside the slider's box (400–800).
		assert.deepEqual( texts, [ 'Visible slide' ], 'the slide outside the slider and the screen-reader label are not on screen' );
		assert.equal( section.boxes.filter( ( b ) => 'image' === b.type ).length, 0, 'the select is not an image' );
		const select = await page.evaluate( () => {
			const r = document.querySelector( 'select' ).getBoundingClientRect();
			return { x: Math.round( r.left ), y: Math.round( r.top ), w: Math.round( r.width ), h: Math.round( r.height ) };
		} );
		assert.ok( section.boxes.some( ( b ) => 'surface' === b.type && b.w === select.w && b.h === select.h ), 'the select is a surface' );
		const visible = section.boxes.find( ( b ) => 'Visible slide' === b.text );
		assert.ok( ! visible.clipped, 'a slide fully inside the slider is not cut off' );
		const chevron = section.boxes.find( ( b ) => 'icon' === b.type );
		assert.deepEqual( [ chevron.x, chevron.w, chevron.h ], [ select.x + select.w - 20 - 18, 20, 20 ], 'the chevron is an icon 18px from the right' );
	} finally {
		await browser.close();
	}
} );
