// Offline regression tests for the comparison logic. No browser, no network.
//   node --test tests/*.test.js   (or ./tests/test.sh)

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import fs from 'node:fs';
import os from 'node:os';

import { DEFAULT_CONFIG, figmaSlug, loadConfig, projectRoot, runsDir } from '../scripts/config.js';
import { classify, DEFAULTS, parseArgs, pruneRuns } from '../scripts/triage.js';
import { execFileSync } from 'node:child_process';

import { boxesFromNode, fetchFigmaFrame } from '../scripts/figma-rest.js';
import { sharedMedia } from '../scripts/pixel-diff.js';
import { hash, matchBoxes, mergeTextRuns, normText, paddingOf, pairSections, parseFigma, sectionScore } from '../scripts/wireframe-diff.js';

const here = path.dirname( fileURLToPath( import.meta.url ) );
const textBox = ( x, y, w, h, text ) => ( { type: 'text', x, y, w, h, full: normText( text ), hash: hash( normText( text ) ), text: normText( text ).slice( 0, 28 ) } );

test( 'Figma layer names map to block slugs, and sectionMap overrides them', () => {
	assert.equal( figmaSlug( 'Content Cards (No Bg) / Desktop' ), 'content-cards' );
	assert.equal( figmaSlug( 'Interior Header / Mobile' ), 'interior-header' );
	assert.equal( figmaSlug( 'Hero Banner / Desktop', { ...DEFAULT_CONFIG, sectionMap: { 'hero banner': 'interior-header' } } ), 'interior-header' );
} );

test( 'parseFigma reads sections and boxes from extractor output', () => {
	const { frame, sections } = parseFigma( path.join( here, 'fixtures', 'figma-boxes.txt' ), DEFAULT_CONFIG );
	assert.deepEqual( frame, { width: 1440, height: 900 } );
	assert.deepEqual( sections.map( ( s ) => s.slug ), [ 'intro-copy', 'content-cards' ] );
	assert.equal( sections[ 1 ].boxes.length, 3 );
	assert.equal( sections[ 0 ].boxes[ 0 ].hash, '3e14376e' );
} );

test( 'figma-boxes.js and the page side hash text identically', () => {
	// The fixture's hash was produced by figma-boxes.js inside Figma.
	assert.equal( hash( normText( 'What Sets Us Apart' ) ), '3e14376e' );
	assert.equal( normText( 'We’re  ready — “now”' ), 'we\'re ready - "now"' );
} );

test( 'runsDir groups by project, page and width, and ignores an unsubstituted plugin-data root', () => {
	const dir = runsDir( 'https://site.test/about-us/', 375, { runsRoot: '${CLAUDE_PLUGIN_DATA}/runs', project: 'acme' } );
	assert.ok( ! dir.includes( '${' ), dir );
	assert.ok( dir.endsWith( path.join( 'acme', 'about-us', '375' ) ), dir );
	assert.equal( runsDir( 'https://site.test/', 1440, { runsRoot: '/data/runs', project: 'acme' } ), path.join( '/data/runs', 'acme', 'home', '1440' ) );
} );

test( 'sections pair by name, reporting what is missing', () => {
	const { pairs, byOrder } = pairSections( [ 'hero', 'cards', 'form' ], [ 'hero', 'form' ] );
	assert.equal( byOrder, false );
	assert.deepEqual( pairs, [ [ 0, 0 ], [ 2, 1 ] ] );
} );

test( 'sections pair by position when names do not match but counts do', () => {
	const { pairs, byOrder } = pairSections( [ 'hero', 'cards', 'form' ], [ 'block_a1', 'block_b2', 'block_c3' ] );
	assert.equal( byOrder, true );
	assert.deepEqual( pairs, [ [ 0, 0 ], [ 1, 1 ], [ 2, 2 ] ] );
} );

test( 'page paragraphs merge when one Figma text layer holds them all', () => {
	const figma = [ textBox( 744, 302, 620, 304, 'First paragraph.\nSecond paragraph.' ) ];
	const merged = mergeTextRuns( figma, [ textBox( 744, 296, 617, 102, 'First paragraph.' ), textBox( 744, 431, 622, 74, 'Second paragraph.' ) ] );
	assert.equal( merged.length, 1 );
	assert.equal( merged[ 0 ].hash, figma[ 0 ].hash );
	assert.deepEqual( [ merged[ 0 ].y, merged[ 0 ].h ], [ 296, 209 ] );
} );

test( 'boxes far from their Figma position still pair when their anchor text moved with them', () => {
	// A vh-sized panel pushed everything 400px down: the icon is out of plain reach.
	const figma = [ textBox( 800, 100, 200, 30, 'Built for scale' ), { type: 'icon', x: 788, y: 160, w: 24, h: 24 } ];
	const page = [ textBox( 800, 500, 200, 30, 'Built for scale' ), { type: 'icon', x: 788, y: 560, w: 24, h: 24 } ];
	const { pairs, missing, extra } = matchBoxes( figma, page, 8 );
	assert.equal( pairs.length, 2 );
	assert.deepEqual( [ missing.length, extra.length ], [ 0, 0 ] );
} );

const wireframeSection = ( overrides ) => ( {
	status: 'pass', live: false, score: 0.95, heightDelta: 0, missing: [], extra: [], copy: [], shifted: [], offsets: [], drift: { dx: 0, dy: 0, resized: 0 },
	...overrides,
} );

test( 'a sideways-shifted element is an alignment finding even when the section has other problems', () => {
	const findings = classify( wireframeSection( { status: 'fail', missing: [ 'image 160×107 at 540,71' ], shifted: [ { element: 'text 176×23 at 632,40 "who we work with"', dx: -564 } ] } ), null, DEFAULTS );
	assert.deepEqual( findings.map( ( f ) => f.kind ), [ 'content', 'alignment' ] );
} );

test( 'elements Figma lacks are a content finding', () => {
	const findings = classify( wireframeSection( { extra: [ 'surface 85×85 at 20,817', 'icon 50×50 at 37,835' ] } ), null, DEFAULTS );
	assert.equal( findings[ 0 ].kind, 'content' );
	assert.match( findings[ 0 ].why, /2 extra element/ );
} );

test( 'live sections do not fail on text they cannot be expected to match', () => {
	const findings = classify( wireframeSection( { live: true, missing: [ 'text 128×27 at 91,378 "2026 / city, state"' ], extra: [ 'text 123×20 at 91,942 "2026 | dallas, tx"' ] } ), null, DEFAULTS );
	assert.deepEqual( findings.map( ( f ) => f.kind ), [ 'ok' ] );
} );

test( 'pixels only report a visual finding once geometry agrees', () => {
	assert.deepEqual( classify( wireframeSection(), { score: 0.5 }, DEFAULTS ).map( ( f ) => f.kind ), [ 'visual' ] );
	assert.deepEqual( classify( wireframeSection(), { score: 0.8 }, DEFAULTS ).map( ( f ) => f.kind ), [ 'ok' ] );
} );

test( 'runs from a subfolder are filed under the repository, not the subfolder', () => {
	const repo = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-repo-' ) );
	fs.mkdirSync( path.join( repo, '.git' ) );
	fs.mkdirSync( path.join( repo, 'includes', 'deep' ), { recursive: true } );
	assert.equal( projectRoot( path.join( repo, 'includes', 'deep' ) ), repo );
	fs.rmSync( repo, { recursive: true } );
} );

test( 'a malformed project config names the file instead of throwing a bare parse error', () => {
	const file = path.join( fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-cfg-' ) ), '.figma-visual-diff.json' );
	fs.writeFileSync( file, '{ nope' );
	assert.throws( () => loadConfig( file ), ( error ) => error.message.includes( file ) && error.message.includes( 'not valid JSON' ) );
} );

test( 'a failing wireframe score is never reported ok, even with no dominant offset', () => {
	const findings = classify( wireframeSection( { status: 'fail', score: 0.7 } ), { score: 0.9 }, DEFAULTS );
	assert.deepEqual( findings.map( ( f ) => f.kind ), [ 'layout' ] );
} );

test( 'a partial report degrades to findings instead of crashing', () => {
	assert.deepEqual( classify( { status: 'pass', score: 0.95 }, null, DEFAULTS ).map( ( f ) => f.kind ), [ 'ok' ] );
} );

test( 'pixel masking covers only where page and Figma images overlap', () => {
	const page = [ { x: 0, y: 0, width: 100, height: 100 }, { x: 500, y: 0, width: 100, height: 100 } ];
	const figma = [ { x: 50, y: 50, width: 100, height: 100 } ];
	assert.deepEqual( sharedMedia( page, figma ), [ { x: 50, y: 50, width: 50, height: 50 } ] );
	assert.deepEqual( sharedMedia( page, null ), page, 'without Figma image boxes, fall back to page media' );
} );

test( 'a section Figma draws empty only scores 1 if the page adds nothing', () => {
	assert.equal( sectionScore( [], { pairs: [], extra: [] } ), 1 );
	assert.equal( sectionScore( [], { pairs: [], extra: [ { type: 'text', x: 0, y: 0, w: 10, h: 10 } ] } ), 0 );
} );

test( 'triage reports a missing --url before trying to use it', () => {
	let message = '';
	try {
		execFileSync( process.execPath, [ path.join( here, '..', 'scripts', 'triage.js' ), '--width', '375' ], { stdio: 'pipe' } );
	} catch ( error ) {
		message = String( error.stderr );
	}
	assert.match( message, /Missing --url/ );
} );

test( 'an element moved far across the section pairs as moved, not as missing plus extra', () => {
	// Slider arrows beside the slides in Figma, above them on the page; no text anchors nearby.
	const figma = [ { type: 'icon', x: 78, y: 114, w: 21, h: 21 }, { type: 'icon', x: 1342, y: 114, w: 21, h: 21 } ];
	const page = [ { type: 'icon', x: 664, y: 31, w: 24, h: 24 }, { type: 'icon', x: 740, y: 31, w: 24, h: 24 } ];
	const { pairs, missing, extra } = matchBoxes( figma, page, 8 );
	assert.equal( pairs.length, 2 );
	assert.deepEqual( [ missing.length, extra.length ], [ 0, 0 ] );
} );

test( 'a far element of a different size stays missing', () => {
	const { missing, extra } = matchBoxes( [ { type: 'image', x: 0, y: 0, w: 600, h: 400 } ], [ { type: 'image', x: 2400, y: 0, w: 100, h: 60 } ], 8 );
	assert.deepEqual( [ missing.length, extra.length ], [ 1, 1 ] );
} );

test( 'pruning keeps the newest runs and leaves Figma inputs alone', () => {
	const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-runs-' ) );
	for ( const d of [ '2026-09-25_010000', '2026-09-25_020000', '2026-09-25_030000' ] ) {
		fs.mkdirSync( path.join( dir, d ) );
	}
	fs.writeFileSync( path.join( dir, 'figma-boxes.txt' ), 'F|1|1' );
	assert.deepEqual( pruneRuns( dir, 2 ), [ '2026-09-25_010000' ] );
	assert.deepEqual( fs.readdirSync( dir ).sort(), [ '2026-09-25_020000', '2026-09-25_030000', 'figma-boxes.txt' ] );
	assert.deepEqual( pruneRuns( dir, undefined ), [], 'no --keep means keep everything' );
	fs.rmSync( dir, { recursive: true } );
} );

test( 'the REST extractor matches figma-boxes.js on the same Figma subtree', () => {
	// rest-section.json: a real section serialised in REST shape; rest-section.expected.txt:
	// figma-boxes.js run on that same node inside Figma.
	const node = JSON.parse( fs.readFileSync( path.join( here, 'fixtures', 'rest-section.json' ), 'utf8' ) );
	const expected = fs.readFileSync( path.join( here, 'fixtures', 'rest-section.expected.txt' ), 'utf8' ).trim();
	assert.equal( boxesFromNode( node ), expected );
} );

test( 'the REST extractor skips hidden layers, invisible paints and ignored sections', () => {
	const node = JSON.parse( fs.readFileSync( path.join( here, 'fixtures', 'rest-section.json' ), 'utf8' ) );
	const baseline = boxesFromNode( node );
	const grid = node.children[ 0 ];
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	// REST includes hidden nodes with visible:false; neither they nor their children count.
	grid.children.push( { type: 'FRAME', name: 'Row', visible: false, absoluteBoundingBox: abs( 21650, 1500, 100, 100 ), fills: [ { type: 'SOLID' } ],
		children: [ { type: 'TEXT', name: 'Hidden', characters: 'Hidden copy', absoluteBoundingBox: abs( 21650, 1500, 100, 20 ) } ] } );
	grid.children.push( { type: 'RECTANGLE', name: 'Invisible fill', absoluteBoundingBox: abs( 21650, 1500, 100, 100 ), fills: [ { type: 'SOLID', visible: false } ] } );
	grid.children.push( { type: 'RECTANGLE', name: 'Transparent', opacity: 0, absoluteBoundingBox: abs( 21650, 1500, 100, 100 ), fills: [ { type: 'SOLID' } ] } );
	node.children.push( { type: 'INSTANCE', name: 'Footer / Desktop', absoluteBoundingBox: abs( 21581, 1600, 1440, 400 ), children: [] } );
	assert.equal( boxesFromNode( node ), baseline );
} );

test( 'fetchFigmaFrame asks the API for the frame and its 1:1 render and writes both files', async () => {
	const node = JSON.parse( fs.readFileSync( path.join( here, 'fixtures', 'rest-section.json' ), 'utf8' ) );
	const png = Buffer.from( [ 0x89, 0x50, 0x4e, 0x47 ] );
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async ( url, options ) => {
		calls.push( { url: String( url ), token: options?.headers?.[ 'X-Figma-Token' ] } );
		const body = String( url ).includes( '/v1/files/' ) ? { nodes: { '1:2': { document: node } } }
			: String( url ).includes( '/v1/images/' ) ? { images: { '1:2': 'https://render.test/frame.png' } } : null;
		return body ? new Response( JSON.stringify( body ) ) : new Response( png );
	};
	const out = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-fetch-' ) );
	try {
		const { frame } = await fetchFigmaFrame( { fileKey: 'ABC123', nodeId: '1-2', out, token: 'secret', ignore: DEFAULT_CONFIG.figmaIgnore } );
		assert.deepEqual( frame, { width: 1440, height: 367 } );
		assert.equal( calls[ 0 ].url, 'https://api.figma.com/v1/files/ABC123/nodes?ids=1%3A2' );
		assert.equal( calls[ 1 ].url, 'https://api.figma.com/v1/images/ABC123?ids=1%3A2&format=png&scale=1' );
		assert.ok( calls.slice( 0, 2 ).every( ( c ) => 'secret' === c.token ), 'token sent to the API' );
		assert.equal( calls[ 2 ].token, undefined, 'token not sent to the render host' );
		assert.equal( fs.readFileSync( path.join( out, 'figma-boxes.txt' ), 'utf8' ), boxesFromNode( node ) );
		assert.deepEqual( fs.readFileSync( path.join( out, 'figma.png' ) ), png );
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync( out, { recursive: true } );
	}
} );

test( 'fetchFigmaFrame explains a missing token instead of calling the API', async () => {
	await assert.rejects( fetchFigmaFrame( { fileKey: 'ABC123', nodeId: '1:2', out: os.tmpdir(), token: '' } ), /FIGMA_TOKEN is not set/ );
} );

test( 'with a file key and node id, triage defaults the Figma files into the runs folder', () => {
	const args = parseArgs( [ '--url', 'https://site.test/about/', '--width', '375', '--file-key', 'ABC123', '--node-id', '1:2', '--runs-root', '/data/runs', '--project', 'acme', '--refresh-figma' ] );
	assert.equal( args.figma, path.join( '/data/runs', 'acme', 'about', '375', 'figma-boxes.txt' ) );
	assert.equal( args.figmaPng, path.join( '/data/runs', 'acme', 'about', '375', 'figma.png' ) );
	assert.equal( args.refreshFigma, true );
	assert.throws( () => parseArgs( [ '--url', 'https://site.test/', '--width', '375' ] ), /--file-key and --node-id/ );
} );

test( 'padding is the space from each section edge to its content, ignoring backgrounds', () => {
	const boxes = [
		{ type: 'image', x: 0, y: 0, w: 1440, h: 600 }, // full-section background
		{ type: 'text', x: 68, y: 104, w: 500, h: 60 },
		{ type: 'surface', x: 68, y: 400, w: 150, h: 60 },
	];
	assert.deepEqual( paddingOf( boxes, 1440, 600 ), { top: 104, right: 872, bottom: 140, left: 68 } );
	assert.equal( paddingOf( [ boxes[ 0 ] ], 1440, 600 ), null, 'a section with only a background has no content edges' );
} );

test( 'a padding difference is a layout finding naming the side', () => {
	const padding = { figma: { top: 104, right: 68, bottom: 72, left: 68 }, page: { top: 72, right: 68, bottom: 76, left: 68 }, delta: { top: -32, right: 0, bottom: 4, left: 0 } };
	const findings = classify( wireframeSection( { padding } ), null, DEFAULTS );
	assert.equal( findings[ 0 ].kind, 'layout' );
	assert.match( findings[ 0 ].why, /top 104 → 72 \(-32px\)/ );
	assert.doesNotMatch( findings[ 0 ].why, /bottom/, 'a 4px difference is within tolerance' );
} );

test( 'padding ignores off-screen slides and clips overflowing ones', () => {
	const boxes = [
		{ type: 'text', x: 191, y: 159, w: 1056, h: 108 }, // visible slide
		{ type: 'text', x: 1260, y: 177, w: 1080, h: 72 }, // next slide, mostly off-screen
		{ type: 'text', x: -1100, y: 177, w: 1080, h: 72 }, // previous slide, fully off-screen
	];
	assert.deepEqual( paddingOf( boxes, 1440, 474 ), { top: 159, right: 0, bottom: 207, left: 191 } );
} );
