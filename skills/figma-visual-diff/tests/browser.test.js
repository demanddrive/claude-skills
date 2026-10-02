// Browser-side extraction on a synthetic page: no network, but needs Playwright's Chromium.
//   node --test tests/browser.test.js   (skipped when Chromium isn't installed)

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from '../scripts/config.js';
import { chromiumPath } from '../scripts/lib/browser.js';
import { drawsEdge, paddingOf } from '../scripts/lib/boxes.js';
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
		assert.deepEqual( text.style, { font: 'Barlow', size: '28', lh: '36.4', weight: '700', color: '#3d3d3d', ls: '0', italic: 'normal', deco: 'none', align: 'left', case: 'title' } );
		assert.deepEqual( text.style0, { font: 'Barlow', size: '28', lh: '36.4', weight: '700', color: '#3d3d3d', align: 'left' }, 'the first character\'s, for older Figma files' );
		assert.equal( section.boxes.find( ( b ) => 'Centred' === b.text ).style.align, 'center', 'text-align, as Figma names it' );
		const centred = section.boxes.find( ( b ) => 'Centred' === b.text );
		assert.deepEqual( [ centred.lx, centred.lw ], [ 0, 800 ], 'its layout box: the paragraph, not its ink' );
		assert.ok( centred.w < 200 );
		const bulleted = section.boxes.find( ( b ) => 'Bulleted item' === b.text );
		assert.deepEqual( [ bulleted.lx, bulleted.lw ], [ 42, 758 ], 'inside its padding, where the bullet sits' );
		// Mixed styles: the one on most of the letters ("2026" is 4 of 13), the first character's kept.
		const meta = section.boxes.find( ( b ) => 'text' === b.type && b.text.startsWith( '2026' ) );
		assert.deepEqual( [ meta.style.weight, meta.style0.weight ], [ '400', '700' ] );
		const pill = section.boxes.find( ( b ) => 'surface' === b.type );
		assert.deepEqual( pill.style, { fill: '#2c3f13', radius: '4', stroke: '#ffffff33/1' } );
	} finally {
		await browser.close();
	}
} );

test( 'a text\'s style is the one on most of its letters, with its spacing, slant, decoration and case as drawn', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		await page.setContent( `<style>
			body { margin: 0 } p { margin: 0; font: 400 16px/1.5 sans-serif } .eyebrow { text-transform: uppercase; letter-spacing: 0.1em }
			a { color: #1d5ae6 } em { font-style: italic } .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%) }
		</style>
		<main><section class="block-text">
			<p class="eyebrow">how we work</p>
			<p>Built for <b>every</b> property type</p>
			<p><b>Half bold</b> half not</p>
			<p><a href="#">A linked sentence here</a></p>
			<p><em>Emphasised all the way</em></p>
			<p>Visible words<b style="visibility: hidden"> and a long hidden bold note</b></p>
			<p><span><b style="display: contents">Mostly bold words here</b></span> ok</p>
			<p style="font-variant-caps: small-caps">Small caps text</p>
		</section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		const style = ( start ) => section.boxes.find( ( b ) => 'text' === b.type && b.text.toLowerCase().startsWith( start ) ).style;
		assert.deepEqual( [ style( 'how' ).case, style( 'how' ).ls ], [ 'upper', '1.6' ], 'text-transform and letter-spacing as drawn' );
		assert.deepEqual( [ style( 'built' ).weight, style( 'built' ).case ], [ '400', 'sentence' ], 'one bold word of five' );
		assert.equal( style( 'half' ).weight, undefined, 'no style on most of the letters: none' );
		assert.deepEqual( [ style( 'a linked' ).deco, style( 'a linked' ).color ], [ 'underline', '#1d5ae6' ], 'a link\'s underline and colour' );
		assert.equal( style( 'emphasised' ).italic, 'italic' );
		assert.equal( style( 'visible' ).weight, '400', 'hidden text doesn\'t count' );
		assert.equal( style( 'mostly bold' ).weight, '700', 'text in a display: contents element counts' );
		assert.equal( style( 'small caps' ).case, undefined, 'small caps render neither case' );
	} finally {
		await browser.close();
	}
} );

test( 'corners and borders are read per corner and side, and an image takes its clipping wrapper\'s corners', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		const pixel = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/%3E';
		await page.setContent( `<style>
			body { margin: 0 } img { display: block; width: 300px; height: 200px }
			.media { width: 300px; border-radius: 4px; overflow: hidden } .inner { overflow: hidden }
			.round { width: 300px; border-radius: 20px; overflow: hidden } .round img { border-radius: 4px }
			.corner { width: 100px; height: 100px; background: #fff; border-radius: 80px 0 0 0 }
			.outer { width: 300px; border-radius: 12px; overflow: hidden } .wide { width: 300px; padding-bottom: 10px; margin-bottom: -10px }
			.card { width: 300px; border-radius: 8px; overflow: hidden; background: #fff } .card img { height: 100px } .card p { margin: 0; height: 60px }
			.clipped { clip-path: inset(0 round 10px) } .avatar { width: 48px; height: 48px; border-radius: 50% }
			.oval { border-radius: 50% } .shape { clip-path: polygon(0 0, 100% 0, 50% 100%) }
			.tab { width: 200px; height: 40px; background: #fff; border-bottom: 1px solid #cccccc; border-radius: 8px 8px 0 0 }
			.dot { width: 40px; height: 40px; background: #fff; border-radius: 50% }
			.framed { border: 2px solid #3d3d3d; border-radius: 6px }
		</style>
		<main><section class="block-media"><div class="media"><div class="inner"><img src='${ pixel }'></div></div><div class="round"><img src='${ pixel }'></div><div class="outer"><div class="wide"><img src='${ pixel }'></div></div><div class="card"><img src='${ pixel }'><p></p></div><img class="clipped" src='${ pixel }'><img class="avatar" src='${ pixel }'><img class="oval" src='${ pixel }'><img class="shape" src='${ pixel }'><div class="tab"></div><div class="dot"></div><div class="corner"></div><img class="framed" src='${ pixel }'></section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		const [ wrapped, round, outer, top, clipped, avatar, oval, shape, framed ] = section.boxes.filter( ( b ) => 'image' === b.type );
		assert.deepEqual( [ oval.style, shape.style ], [ { stroke: 'none' }, { stroke: 'none' } ], 'an oval or another shape has no one radius' );
		assert.equal( top.style.radius, '8 8 0 0', 'a card rounds the corners it shares with the photo' );
		assert.equal( clipped.style.radius, '10', 'clip-path: inset( round )' );
		assert.equal( avatar.style.radius, '24', 'a 50% circle' );
		assert.equal( outer.style.radius, '12', 'a clipper further out, past a wrapper of another size' );
		assert.deepEqual( wrapped.style, { radius: '4', stroke: 'none' }, 'the rounded wrapper, through a square one' );
		assert.deepEqual( round.style, { radius: '20', stroke: 'none' }, 'the roundest clip shows' );
		assert.deepEqual( framed.style, { radius: '6', stroke: '#3d3d3d/2' }, 'its own corners and border' );
		const surface = ( w, h ) => section.boxes.find( ( b ) => 'surface' === b.type && w === b.w && h === b.h );
		const [ tab, dot, corner ] = [ surface( 200, 41 ), surface( 40, 40 ), surface( 100, 100 ) ];
		assert.equal( corner.style.radius, '80 0 0 0', 'one corner as large as it fits' );
		assert.deepEqual( [ tab.style.radius, tab.style.stroke ], [ '8 8 0 0', 'none none #cccccc/1 none' ] );
		assert.deepEqual( [ dot.style.radius, dot.style.stroke ], [ '20', 'none' ], 'a percentage of the box' );
	} finally {
		await browser.close();
	}
} );

test( 'every line a section draws is recorded, however it is drawn', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		await page.setContent( `<style>
			body { margin: 0 } div { width: 400px; height: 40px; margin: 0 0 20px }
			.border { border-bottom: 1px solid #ccc } .outline { outline: 1px solid #ccc }
			.ring { box-shadow: 0 0 0 1px #ccc } .soft { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2) }
			.after { position: relative } .after::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 1px; background: #ccc }
			.gradient { background: linear-gradient(#ccc, #ccc) no-repeat bottom / 100% 1px }
			.fill-gradient { background: linear-gradient(#fff, #eee) } .offset { box-shadow: 0 2px 0 #ccc }
			.far { box-shadow: 0 20px 0 #ccc }
			.shrunk { box-shadow: 0 2px 0 -20px #ccc } .away { outline: 1px solid #ccc; outline-offset: 20px }
			.round { border: 1px solid #ccc; border-radius: 20px }
.rule { height: 1px; background: #ccc }
			.hidden { position: relative } .hidden::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 1px; background: #ccc; opacity: 0 }
			.clip { overflow: hidden; position: relative } .clip::after { content: ''; position: absolute; left: 0; right: 0; top: 60px; height: 1px; background: #ccc }
		</style>
		<main><section class="block-lines"><div class="border"></div><div class="outline"></div><div class="ring"></div><div class="soft"></div><div class="after"></div><div class="gradient"></div><div class="rule"></div><div class="hidden"></div><div class="clip"></div><div class="fill-gradient"></div><div class="offset"></div><div class="far"></div><div class="shrunk"></div><div class="away"></div><div class="round"></div></section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		// Each div's bottom edge: 40px tall, 20px apart (the rule is 1px tall, at 360).
		const bottom = ( k ) => ( { x: 0, y: 60 * k, w: 400, h: 40 } );
		const draws = ( k ) => drawsEdge( section.lines, bottom( k ), 2 );
		assert.deepEqual( [ 0, 1, 2, 4, 5 ].map( draws ), [ true, true, true, true, true ], 'border, outline, ring, ::after rule, gradient' );
		assert.equal( draws( 3 ), false, 'a soft shadow draws no line' );
		assert.ok( drawsEdge( section.lines, { x: 0, y: 360, w: 400, h: 1 }, 0 ), 'a thin element is a rule' );
		// The border adds a pixel, and the rule is 1px + 20px margin: the next divs start at 382 and 442.
		assert.equal( drawsEdge( section.lines, { x: 0, y: 382, w: 400, h: 40 }, 2 ), false, 'an invisible ::after draws nothing' );
		assert.equal( drawsEdge( section.lines, { x: 0, y: 442, w: 400, h: 60 }, 2 ), false, 'nor one its own overflow hides' );
		// Then a 40px gradient fill (at 502) and a shadow offset 2px down (at 562).
		assert.deepEqual( [ 0, 2 ].map( ( side ) => drawsEdge( section.lines, { x: 0, y: 502, w: 400, h: 40 }, side ) ), [ false, false ], 'a gradient fill draws no rule' );
		assert.deepEqual( [ 0, 1, 2, 3 ].map( ( side ) => drawsEdge( section.lines, { x: 0, y: 562, w: 400, h: 40 }, side ) ), [ false, false, true, false ], 'an offset shadow draws its side only' );
		assert.deepEqual( [ 0, 1, 2, 3 ].map( ( side ) => drawsEdge( section.lines, { x: 0, y: 622, w: 400, h: 40 }, side ) ), [ false, false, false, false ], 'one 20px off draws away from the edge' );
		const any = ( y ) => [ 0, 1, 2, 3 ].some( ( s ) => drawsEdge( section.lines, { x: 0, y, w: 400, h: 40 }, s ) );
		assert.deepEqual( [ any( 682 ), any( 742 ) ], [ false, false ], 'a shadow spread in 20px, an outline 20px out' );
		// A pill: its straight runs are its top and bottom edges clear of the corners, 360 of 400px.
		const round = ( s ) => drawsEdge( section.lines, { x: 0, y: 802, w: 400, h: 40 }, s );
		assert.deepEqual( [ 0, 1, 2, 3 ].map( round ), [ true, false, true, false ], 'a pill has no straight sides' );
		// The bottom-positioned 1px gradient (at 300) draws its bottom edge only.
		assert.deepEqual( [ 0, 1, 2, 3 ].map( ( side ) => drawsEdge( section.lines, { x: 0, y: 300, w: 400, h: 40 }, side ) ), [ false, false, true, false ], 'a gradient rule where it sits' );
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

test( 'a select shows its chosen option, and a checkbox label\'s words are one text beside the box', { skip: ! chromium && 'Playwright Chromium not installed' }, async () => {
	const browser = await chromium.launch( { executablePath } );
	try {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		await page.setContent( `<style>
			body { margin: 0; font: 16px/24px sans-serif } select { width: 300px; height: 48px; padding: 0 12px }
			label { display: flex; gap: 8px }
		</style>
		<main><section class="block-form-cta">
			<select><option value="">Select one</option><option>Landscape Maintenance</option></select>
			<label><input type="checkbox"> I have read the <a href="#">Terms</a> <a href="#">Privacy Policy</a>.<span hidden>Hidden help</span></label>
			<select multiple size="2"><option>North</option><option>South</option></select>
		</section></main>` );
		const [ section ] = await evaluateWithSections( page, extractPageBoxes, DEFAULT_CONFIG );
		const texts = section.boxes.filter( ( b ) => 'text' === b.type ).map( ( b ) => b.text );
		assert.deepEqual( texts.slice( 0, 2 ), [ 'Select one', 'I have read the Terms Privacy Policy.' ], JSON.stringify( texts ) );
		const label = section.boxes.find( ( b ) => b.text?.startsWith( 'I have read' ) );
		assert.equal( label.h, 24, 'measured by its line box, as other text' );
		const select = section.boxes.find( ( b ) => 'Select one' === b.text );
		assert.ok( select.x >= 12 && select.w < 150, `the shown option's words, inside the padding: ${ JSON.stringify( select ) }` );
		assert.equal( select.style.case, 'sentence', 'its case is the shown option\'s' );
	} finally {
		await browser.close();
	}
} );
