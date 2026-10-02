// Offline regression tests for the comparison logic. No browser, no network.
//   node --test tests/*.test.js   (or ./tests/test.sh)

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import fs from 'node:fs';
import os from 'node:os';

import { execFileSync } from 'node:child_process';

import { DEFAULT_CONFIG, keepRunsLocal, loadConfig, localRunsRoot, projectRoot, runsDir, userConfigFile } from '../scripts/config.js';
import { loadDeps, packageRoot } from '../scripts/deps.js';
import { fetchFigmaFrame } from '../scripts/figma-rest.js';
import { DEFAULTS, importFigma, parseArgs, pruneRuns, sameSection, triageSection, validateReport } from '../scripts/triage.js';
import { appendHistory, buildMetrics, metricsDelta } from '../scripts/lib/metrics.js';
import { colourDistance, defectFacts, diagnose, jevEndpoint, moduleQuestions, moduleState } from '../scripts/lib/jev.js';
import { disagreements, inPixelImage, renderReport } from '../scripts/lib/report-html.js';
import { analyseSection, drawsEdge, MAX_OFFSETS, matchBoxes, mergeFigmaRuns, mergeTextRuns, missingTextStyles, paddingOf, pairSections, pairStructure, sameToken, sectionScore, spacingTolerance, styleDiffs, uniqueBoxes } from '../scripts/lib/boxes.js';
import { cacheBusted } from '../scripts/lib/browser.js';
import { tokenValue } from '../scripts/lib/defects.js';
import { parseFlags, sectionImage } from '../scripts/lib/cli.js';
import { extractBoxes, figmaScript, figmaSlug, hash, normText, parseFigma, TEXT_PREFIX, tileSections } from '../scripts/lib/figma.js';
import { blankMedia, compareSection, mediaMask, readAnchors, REFINE, renderScale } from '../scripts/lib/pixels.js';
import { alignedBox, alignedHeight, alignedRow, alignRows, anchorPoints, BAND_TOLERANCE, rowSources } from '../scripts/lib/align.js';

/** The Figma extractor with the default ignore pattern, as figma-rest.js runs it. */
const extract = ( node, section = false ) => extractBoxes( node, { ignore: DEFAULT_CONFIG.figmaIgnore, section } );

const here = path.dirname( fileURLToPath( import.meta.url ) );
const textBox = ( x, y, w, h, text ) => ( { type: 'text', x, y, w, h, full: normText( text ), hash: hash( normText( text ) ), text: normText( text ).slice( 0, TEXT_PREFIX ) } );

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

test( 'the Figma extractor and the page side hash text identically', () => {
	// The fixture's hash was produced by the extractor running inside Figma.
	assert.equal( hash( normText( 'What Sets Us Apart' ) ), '3e14376e' );
	assert.equal( normText( 'We’re  ready — “now”' ), 'we\'re ready - "now"' );
} );

test( 'runsDir groups by project, page and width, and ignores an unsubstituted plugin-data root', () => {
	const dir = runsDir( 'https://site.test/about-us/', 375, { runsRoot: '${CLAUDE_PLUGIN_DATA}/runs', project: 'acme' } );
	assert.ok( ! dir.includes( '${' ), dir );
	assert.ok( dir.endsWith( path.join( 'acme', 'about-us', '375' ) ), dir );
	assert.equal( runsDir( 'https://site.test/', 1440, { runsRoot: '/data/runs', project: 'acme' } ), path.join( '/data/runs', 'acme', 'home', '1440' ) );
} );

test( 'runs live in the project\'s .claude folder, which keeps itself out of git', () => {
	const repo = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-repo-' ) );
	fs.mkdirSync( path.join( repo, '.git' ) );
	fs.mkdirSync( path.join( repo, 'theme', 'src' ), { recursive: true } );
	const root = localRunsRoot( path.join( repo, 'theme', 'src' ) );
	assert.equal( root, path.join( repo, '.claude', 'figma-visual-diff', 'runs' ), 'from anywhere in the repo' );
	const dir = path.join( root, 'acme', 'about', '1440' );
	keepRunsLocal( dir );
	const ignore = path.join( repo, '.claude', 'figma-visual-diff', '.gitignore' );
	assert.equal( fs.readFileSync( ignore, 'utf8' ), '*\n' );
	fs.writeFileSync( ignore, 'runs/\n' );
	keepRunsLocal( dir );
	assert.equal( fs.readFileSync( ignore, 'utf8' ), 'runs/\n', 'an existing .gitignore is left as it is' );
	const elsewhere = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-runs-' ) );
	keepRunsLocal( path.join( elsewhere, 'acme', 'about', '1440' ) );
	assert.deepEqual( fs.readdirSync( elsewhere ), [], 'a --runs-root folder is the user\'s: nothing is written there' );
	keepRunsLocal( path.join( elsewhere, 'other.claude', 'figma-visual-diff', 'runs', 'a' ) );
	assert.deepEqual( fs.readdirSync( elsewhere ), [], 'only a folder named .claude counts' );
	fs.rmSync( repo, { recursive: true, force: true } );
	fs.rmSync( elsewhere, { recursive: true, force: true } );
} );

test( 'sections pair by name, reporting what is missing', () => {
	const { pairs, byOrder } = pairSections( [ 'hero', 'cards', 'form' ], [ 'hero', 'form' ] );
	assert.equal( byOrder, false );
	assert.deepEqual( pairs, [ [ 0, 0 ], [ 2, 1 ] ] );
} );

test( 'unpaired sections are missing or extra, and moved when they are both', () => {
	const figma = [ { slug: 'hero', name: 'Hero' }, { slug: 'cards', name: 'Cards' }, { slug: 'form', name: 'Form' } ];
	const page = [ { slug: 'hero' }, { slug: 'form' }, { slug: 'cards' } ];
	const { pairs, missing, extra, moved } = pairStructure( figma, page );
	assert.deepEqual( pairs, [ [ 0, 0 ], [ 2, 1 ] ] );
	assert.deepEqual( missing, [ { index: 2, slug: 'cards', figma: 'Cards' } ] );
	assert.deepEqual( extra, [ { index: 3, slug: 'cards' } ] );
	assert.deepEqual( moved, [ 'cards' ] );
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
	index: 3, slug: 'content-cards', figma: 'Content Cards / Desktop', figmaY: 900, figmaHeight: 600, pageHeight: 600,
	status: 'pass', live: false, score: 0.95, heightDelta: 0, missing: [], extra: [], copy: [], shifted: [], offsets: [], drift: { dx: 0, dy: 0, resized: 0 },
	...overrides,
} );
const box = ( type, x, y, w, h, text ) => ( text ? { type, x, y, w, h, text } : { type, x, y, w, h } );
/** A section-edge space as analyseSection() reports it. */
const edgeSpace = ( side, from, figma, page, margins = { figma: { from: 0 }, page: { from: 0 } } ) => ( {
	where: 'edge', side, from, figma, page, margins, area: { figma: { x: from.x, y: 0, w: from.w, h: figma }, page: { x: from.x, y: 0, w: from.w, h: page } },
} );
/** A section's defect kinds, or its verdict when it has none. */
const kinds = ( w, p = null ) => {
	const s = triageSection( w, p, DEFAULTS );
	return s.defects.length ? s.defects.map( ( d ) => d.kind ) : [ s.verdict ];
};

test( 'a sideways-shifted element is an alignment defect even when the section has other problems', () => {
	const heading = box( 'text', 632, 40, 176, 23, 'who we work with' );
	assert.deepEqual( kinds( wireframeSection( { status: 'fail', missing: [ box( 'image', 540, 71, 160, 107 ) ], shifted: [ { figma: heading, page: { ...heading, x: 68 }, dx: -564 } ] } ) ), [ 'content', 'alignment' ] );
} );

test( 'every missing or extra element is its own defect, numbered within its section', () => {
	const s = triageSection( wireframeSection( { missing: [ box( 'image', 540, 71, 160, 107 ), box( 'icon', 20, 20, 24, 24 ) ], extra: [ box( 'surface', 20, 817, 85, 85 ) ] } ), null, DEFAULTS );
	assert.equal( s.verdict, 'content' );
	assert.deepEqual( s.defects.map( ( d ) => [ d.id, d.issue, d.owner ] ), [ [ '3.1', 'missing', 'page' ], [ '3.2', 'missing', 'page' ], [ '3.3', 'extra', 'page' ] ] );
	assert.deepEqual( s.defects[ 0 ].figma, box( 'image', 540, 71, 160, 107 ) );
	assert.deepEqual( s.defects[ 2 ].page, box( 'surface', 20, 817, 85, 85 ) );
} );

test( 'layout defects name the values on both sides and belong to the developer', () => {
	const title = box( 'text', 71, 415, 298, 36, 'public education' );
	const s = triageSection( wireframeSection( {
		status: 'fail', score: 0.7, pageHeight: 518, heightDelta: -82, drift: { dx: 0, dy: -20, resized: 1 },
		offsets: [
			{ figma: title, page: { ...title, y: 391, h: 20 }, dx: 0, dy: -24, dw: 0, dh: -16 },
			// Moved only: not a defect, the overlays show it.
			{ figma: box( 'icon', 87, 328, 50, 50 ), page: box( 'icon', 85, 302, 50, 50 ), dx: -2, dy: -26, dw: 0, dh: 0 },
		],
		spacing: [ edgeSpace( 'bottom', title, 130, 77 ) ],
	} ), null, DEFAULTS );
	const byIssue = Object.fromEntries( s.defects.map( ( d ) => [ d.issue, d ] ) );
	assert.deepEqual( Object.keys( byIssue ), [ 'height', 'resized', 'spacing' ] );
	assert.ok( s.defects.every( ( d ) => 'developer' === d.owner ) );
	assert.deepEqual( [ byIssue.height.figma, byIssue.height.page, byIssue.height.delta ], [ 600, 518, -82 ] );
	assert.deepEqual( byIssue.resized.delta, { w: 0, h: -16 } );
	assert.equal( byIssue.resized.summary, 'text 298×36 at 71,415 "public education" is 298×20 on the page (0px wide, -16px tall)' );
	assert.equal( s.defects.length, 3, 'the icon that only moved is not a defect' );
	assert.deepEqual( [ byIssue.spacing.side, byIssue.spacing.figma, byIssue.spacing.page, byIssue.spacing.delta ], [ 'bottom', 130, 77, -53 ] );
} );

test( 'copy defects carry both texts', () => {
	const s = triageSection( wireframeSection( { copy: [ { figma: box( 'text', 0, 0, 80, 20, 'company' ), page: box( 'text', 0, 0, 90, 20, 'subject *' ) } ] } ), null, DEFAULTS );
	assert.equal( s.defects[ 0 ].summary, 'copy "company" → "subject *"' );
} );

test( 'a live section compares its template, not what the posts put in it', () => {
	// A post card as in the Post Slider: image, card, title, meta and two tag pills. The real
	// post has a longer title (a taller card), a longer term (a wider pill) and one tag.
	const card = ( h, pillW, pills ) => [
		box( 'surface', 68, 0, 408, h ), box( 'image', 68, 0, 408, 272 ),
		box( 'text', 91, 294, 343, 72, 'viverra mauris' ), box( 'text', 91, 378, 128, 27, '2026 / city, state' ),
		...[ 0, 1 ].slice( 0, pills ).flatMap( ( i ) => [ box( 'surface', 90 + i * 120, h - 51, pillW, 29 ), box( 'text', 103 + i * 120, h - 47, pillW - 26, 21, 'property type' ) ] ),
	];
	const analyse = ( page, live ) => analyseSection( { height: 572, boxes: card( 468, 112, 2 ) }, { height: page.height, boxes: page.boxes }, { tolerance: 8, live, width: 1440 } );
	const post = { height: 625, boxes: card( 553, 164, 1 ).map( ( b ) => ( 'text' === b.type && b.y === 294 ? { ...b, h: 108, text: 'a much longer real title' } : b ) ) };
	const live = analyse( post, true );
	assert.deepEqual( [ live.missing, live.extra, live.shifted, live.offsets ], [ [], [], [], [] ], 'nothing sized by the posts is compared' );
	assert.deepEqual( live.spacing.map( ( d ) => [ d.where, d.side, d.figma, d.page ] ), [ [ 'edge', 'bottom', 104, 72 ] ], 'the space to the section\'s bottom is still compared' );
	const w = { index: 9, slug: 'post-slider', figma: 'Post Slider', figmaY: 0, figmaHeight: 572, pageHeight: 625, heightDelta: 53, status: 'fail', score: live.score, live: true, ...live };
	assert.deepEqual( triageSection( w, null, DEFAULTS ).defects.map( ( d ) => d.issue ), [ 'spacing' ], 'only the bottom padding, a CSS value, differs; not the 53px of extra height the posts add' );

	// Same posts with the designed 104px padding: nothing to fix, whatever the low score says.
	const matching = analyse( { ...post, height: 553 + 104 }, true );
	const ok = triageSection( { ...w, pageHeight: 657, heightDelta: 85, score: matching.score, ...matching }, null, DEFAULTS );
	assert.deepEqual( [ ok.verdict, ok.defects ], [ 'ok', [] ] );

	const notLive = analyse( post, false );
	assert.ok( notLive.missing.length && notLive.offsets.length, 'the same page outside a live section differs' );
	// A template element still counts: the image missing from a live card is a defect.
	const noImage = analyse( { ...post, boxes: post.boxes.filter( ( b ) => 'image' !== b.type ) }, true );
	assert.deepEqual( noImage.missing, [ box( 'image', 68, 0, 408, 272 ) ] );
} );

test( 'pixels only report a visual defect once geometry agrees', () => {
	assert.deepEqual( kinds( wireframeSection(), { score: 0.5 } ), [ 'visual' ] );
	assert.deepEqual( kinds( wireframeSection(), { score: 0.8 } ), [ 'ok' ] );
} );

test( 'a masked section is dynamic, with no defects', () => {
	const s = triageSection( { index: 9, slug: 'post-slider', figma: 'Post Slider', figmaY: 0, figmaHeight: 500, pageHeight: 560, heightDelta: 60, status: 'masked' }, null, DEFAULTS );
	assert.deepEqual( [ s.verdict, s.defects ], [ 'dynamic', [] ] );
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
	assert.deepEqual( kinds( wireframeSection( { status: 'fail', score: 0.7 } ), { score: 0.9 } ), [ 'layout' ] );
} );

test( 'a partial report degrades to a verdict instead of crashing', () => {
	assert.deepEqual( kinds( { index: 1, slug: 'hero', status: 'pass', score: 0.95 } ), [ 'ok' ] );
} );

/** A triage report holding one section of each outcome, as triage.js assembles it. */
function sampleReport() {
	const heading = box( 'text', 632, 40, 176, 23, 'who <we> work with' );
	const sections = [
		triageSection( wireframeSection( { index: 1, slug: 'hero', image: '01-hero.png' } ), { score: 0.9, image: '01-hero.png' }, DEFAULTS ),
		triageSection( wireframeSection( {
			index: 2, status: 'fail', score: 0.6, pageHeight: 700, heightDelta: 100, drift: { dx: 0, dy: 40, resized: 1 },
			missing: [ box( 'image', 540, 71, 160, 107 ) ],
			copy: [ { figma: heading, page: { ...heading, text: 'who we serve' } } ],
			shifted: [ { figma: heading, page: { ...heading, x: 68 }, dx: -564 } ],
			offsets: [
				{ figma: box( 'surface', 0, 200, 300, 200 ), page: box( 'surface', 0, 240, 300, 260 ), dx: 0, dy: 40, dw: 0, dh: 60 },
				{ figma: box( 'image', 400, 200, 300, 200 ), page: box( 'image', 400, 240, 300, 250 ), dx: 0, dy: 40, dw: 0, dh: 50 },
				{ figma: box( 'text', 0, 420, 421, 44, 'caption' ), page: box( 'text', 0, 460, 625, 45, 'caption' ), dx: 0, dy: 40, dw: 207, dh: 1, textBox: { figma: 421, page: 628 } },
			],
			spacing: [
				edgeSpace( 'bottom', box( 'surface', 0, 200, 300, 200 ), 80, 120 ),
				{ where: 'between', axis: 'vertical', from: heading, to: box( 'surface', 0, 200, 300, 200 ), figma: 32, page: 58, margins: { figma: { from: 0, to: 0 }, page: { from: 26, to: 0 } }, area: { figma: { x: 632, y: 63, w: 1, h: 32 }, page: { x: 632, y: 63, w: 1, h: 58 } } },
				{ where: 'inside', side: 'top', container: box( 'surface', 0, 200, 300, 200 ), from: box( 'image', 20, 240, 260, 100 ), figma: 40, page: 24, margins: { figma: { from: 0 }, page: { from: 0 } }, area: { figma: { x: 20, y: 200, w: 260, h: 40 }, page: { x: 20, y: 200, w: 260, h: 24 } } },
			],
			styles: [ { property: 'size', figma: '28', page: '24', element: heading } ],
		} ), null, DEFAULTS ),
		triageSection( wireframeSection( { index: 3 } ), { score: 0.5 }, DEFAULTS ),
		triageSection( { index: 4, slug: 'post-slider', figma: 'Post Slider', figmaY: 0, figmaHeight: 500, pageHeight: 500, heightDelta: 0, status: 'masked' }, null, DEFAULTS ),
	];
	const report = {
		warnings: [],
		unstable: false,
		url: 'https://site.test/about/',
		width: 1440,
		pass: false,
		structure: [ { id: 'S.1', kind: 'structure', issue: 'missing', owner: 'page', summary: 'section #5 form-cta missing', index: 5, slug: 'form-cta', figma: 'Form CTA', moved: false } ],
		sections,
	};
	const wireframe = { pageScore: 0.8, structure: { figmaSections: 5, pageSections: 4, missing: [ { index: 5, slug: 'form-cta' } ], extra: [] } };
	report.metrics = buildMetrics( report, wireframe, { pageScore: 0.7 } );
	return report;
}

test( 'a triage report with every kind of defect matches triage.schema.json', async () => {
	const report = sampleReport();
	assert.deepEqual( report.sections.map( ( s ) => s.verdict ), [ 'ok', 'content', 'visual', 'dynamic' ] );
	assert.deepEqual( [ ...new Set( report.sections[ 1 ].defects.map( ( d ) => d.issue ) ) ], [ 'missing', 'copy', 'shifted', 'height', 'resized', 'aspect', 'spacing', 'style' ] );
	report.previous = '2026-09-25_120000';
	report.metricsDelta = metricsDelta( report.metrics, report.metrics );
	await validateReport( report );
	await validateReport( JSON.parse( JSON.stringify( report ) ) );
} );

test( 'the schema rejects a defect without the values its issue needs', async () => {
	const report = sampleReport();
	delete report.sections[ 1 ].defects[ 0 ].figma;
	await assert.rejects( validateReport( report ), /doesn't match triage\.schema\.json/ );
	const extra = sampleReport();
	extra.sections[ 1 ].defects[ 0 ].page = box( 'image', 0, 0, 1, 1 );
	await assert.rejects( validateReport( extra ), /doesn't match/, 'a missing element has no page side' );
	const noMetrics = sampleReport();
	delete noMetrics.metrics;
	await assert.rejects( validateReport( noMetrics ), /metrics/ );
} );

test( 'metrics count what is correct and who owns what is left', () => {
	const { metrics, sections } = sampleReport();
	const defects = sections.flatMap( ( sec ) => sec.defects );
	// 5 Figma sections, one masked: hero is the only correct one of the 4 expected.
	assert.equal( metrics.correctness, 0.25 );
	assert.deepEqual( metrics.sections, { figma: 5, page: 4, paired: 4, ok: 1, dynamic: 1, withDefects: 2, missing: 1, extra: 0 } );
	assert.equal( metrics.defects.total, defects.length + 1 );
	assert.equal( metrics.defects.byKind.structure, 1 );
	assert.equal( metrics.defects.byOwner.developer, defects.filter( ( d ) => 'developer' === d.owner ).length );
	assert.equal( Object.values( metrics.defects.byKind ).reduce( ( a, n ) => a + n, 0 ), metrics.defects.total );
	assert.deepEqual( metrics.scores, { wireframe: 0.8, pixel: 0.7 } );
} );

test( 'metrics compare with the previous run and accumulate in metrics.jsonl', () => {
	const now = sampleReport();
	const before = structuredClone( now.metrics );
	before.correctness = 0;
	before.defects.total += 3;
	before.defects.byOwner.page += 3;
	before.scores.pixel = 0.65;
	assert.deepEqual( metricsDelta( now.metrics, before ), { correctness: 0.25, defects: -3, pageDefects: -3, developerDefects: 0, wireframe: 0, pixel: 0.05 } );

	const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-metrics-' ) );
	appendHistory( dir, '2026-09-25_120000', now );
	appendHistory( dir, '2026-09-25_130000', now );
	const lines = fs.readFileSync( path.join( dir, 'metrics.jsonl' ), 'utf8' ).trim().split( '\n' ).map( ( l ) => JSON.parse( l ) );
	assert.deepEqual( lines.map( ( l ) => l.run ), [ '2026-09-25_120000', '2026-09-25_130000' ] );
	assert.equal( lines[ 0 ].correctness, 0.25 );
	fs.rmSync( dir, { recursive: true } );
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

test( 'the extractor reproduces, from REST data, what it produced inside Figma for the same subtree', () => {
	// rest-section.json: a real section serialised in REST shape; rest-section.expected.txt:
	// the extractor run on that same node inside Figma.
	const node = JSON.parse( fs.readFileSync( path.join( here, 'fixtures', 'rest-section.json' ), 'utf8' ) );
	const expected = fs.readFileSync( path.join( here, 'fixtures', 'rest-section.expected.txt' ), 'utf8' ).trim();
	assert.equal( extract( node ), expected );
} );

test( 'section mode treats the node as one section, via REST and in Figma', async () => {
	// rest-section.single.expected.txt: the extractor with --section on the same node inside Figma.
	const node = JSON.parse( fs.readFileSync( path.join( here, 'fixtures', 'rest-section.json' ), 'utf8' ) );
	const expected = fs.readFileSync( path.join( here, 'fixtures', 'rest-section.single.expected.txt' ), 'utf8' ).trim();
	assert.equal( extract( node, true ), expected );
	assert.deepEqual( expected.split( '\n' ).filter( ( l ) => l.startsWith( 'S|' ) ), [ `S|0|${ node.name }|0|${ Math.round( node.absoluteBoundingBox.height ) }|1` ] );

	// The script printed for use_figma, run against the same node, gives the same output.
	const code = ( ...flags ) => execFileSync( process.execPath, [ path.join( here, '..', 'scripts', 'config.js' ), 'figma-boxes', '1:2', ...flags ], { encoding: 'utf8' } );
	const AsyncFunction = Object.getPrototypeOf( async () => {} ).constructor;
	const inFigma = ( script ) => new AsyncFunction( 'figma', script )( { getNodeByIdAsync: async () => node } );
	assert.equal( await inFigma( code( '--section' ) ), expected );
	assert.equal( await inFigma( code() ), fs.readFileSync( path.join( here, 'fixtures', 'rest-section.expected.txt' ), 'utf8' ).trim() );
} );

test( 'the REST extractor skips hidden layers, invisible paints and ignored sections', () => {
	const node = JSON.parse( fs.readFileSync( path.join( here, 'fixtures', 'rest-section.json' ), 'utf8' ) );
	const baseline = extract( node );
	const grid = node.children[ 0 ];
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	// REST includes hidden nodes with visible:false; neither they nor their children count.
	grid.children.push( { type: 'FRAME', name: 'Row', visible: false, absoluteBoundingBox: abs( 21650, 1500, 100, 100 ), fills: [ { type: 'SOLID' } ],
		children: [ { type: 'TEXT', name: 'Hidden', characters: 'Hidden copy', absoluteBoundingBox: abs( 21650, 1500, 100, 20 ) } ] } );
	grid.children.push( { type: 'RECTANGLE', name: 'Invisible fill', absoluteBoundingBox: abs( 21650, 1500, 100, 100 ), fills: [ { type: 'SOLID', visible: false } ] } );
	grid.children.push( { type: 'RECTANGLE', name: 'Transparent', opacity: 0, absoluteBoundingBox: abs( 21650, 1500, 100, 100 ), fills: [ { type: 'SOLID' } ] } );
	node.children.push( { type: 'INSTANCE', name: 'Footer / Desktop', absoluteBoundingBox: abs( 21581, 1600, 1440, 400 ), children: [] } );
	assert.equal( extract( node ), baseline );
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
		assert.equal( fs.readFileSync( path.join( out, 'figma-boxes.txt' ), 'utf8' ), extract( node ) );
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
	assert.throws( () => parseArgs( [ '--url', 'https://site.test/', '--width', '375', '--runs-root', '/data/runs' ] ), /--file-key and --node-id/ );
} );

test( 'triage stores Figma inputs from anywhere in the runs folder, and later runs reuse them', async () => {
	const root = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-import-' ) );
	const boxes = path.join( root, 'elsewhere-boxes.txt' );
	fs.writeFileSync( boxes, 'F|1440|100' );
	const png = Buffer.from( [ 0x89, 0x50, 0x4e, 0x47 ] );
	const urls = [];
	const download = async ( url ) => ( urls.push( url ), { ok: true, arrayBuffer: async () => png } );
	const base = [ '--url', 'https://site.test/careers/', '--width', '1440', '--runs-root', root, '--project', 'acme' ];

	const first = parseArgs( [ ...base, '--figma', boxes, '--figma-png-url', 'https://figma.test/render.png' ] );
	await importFigma( first, download );
	const stored = path.join( root, 'acme', 'careers', '1440' );
	assert.equal( first.figma, path.join( stored, 'figma-boxes.txt' ) );
	assert.equal( fs.readFileSync( first.figma, 'utf8' ), 'F|1440|100' );
	assert.deepEqual( fs.readFileSync( first.figmaPng ), png );
	assert.deepEqual( urls, [ 'https://figma.test/render.png' ] );

	const again = parseArgs( base ); // nothing passed: the stored files are enough
	await importFigma( again, download );
	assert.equal( again.figma, first.figma );
	assert.equal( urls.length, 1, 'no second download' );

	await assert.rejects( importFigma( parseArgs( [ ...base, '--figma-png-url', 'https://figma.test/gone.png' ] ), async () => ( { ok: false, status: 403 } ) ), /short-lived/ );
	fs.rmSync( root, { recursive: true } );
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

test( 'a spacing difference is one layout defect per difference, with how each side builds the space', () => {
	const heading = box( 'text', 68, 139, 600, 67, 'built for every property type' );
	const card = ( x ) => box( 'surface', x, 300, 400, 300 );
	const inset = ( x ) => ( { where: 'inside', side: 'top', container: card( x ), from: box( 'image', x, 340, 400, 200 ), figma: 40, page: 24, margins: { figma: { from: 0 }, page: { from: 0 } }, area: { figma: {}, page: {} } } );
	const { defects } = triageSection( wireframeSection( {
		spacing: [ edgeSpace( 'bottom', heading, 92, 73, { figma: { from: 20 }, page: { from: 0 } } ), inset( 68 ), inset( 516 ), inset( 964 ) ],
	} ), null, DEFAULTS );
	assert.deepEqual( defects.map( ( d ) => [ d.kind, d.issue, d.count, d.delta ] ), [ [ 'layout', 'spacing', 1, -19 ], [ 'layout', 'spacing', 3, -16 ] ], 'three cards with the same difference are one defect' );
	assert.equal( defects[ 0 ].summary, 'space from text "built for every property type" to the section\'s bottom edge: 92px in Figma (72 padding + 20 margin), 73px on the page (73 padding + 0 margin) (-19px)' );
	assert.equal( defects[ 1 ].summary, 'space inside surface 400×300 at 68,300 from its top edge to image 400×200 at 68,340 (and 2 more like it): 40px in Figma, 24px on the page (-16px)' );
	const between = triageSection( wireframeSection( { spacing: [ {
		where: 'between', axis: 'vertical', from: box( 'text', 180, 160, 1080, 72, 'quote' ), to: box( 'text', 180, 264, 200, 27, 'jane smith' ),
		figma: 32, page: 58, margins: { figma: { from: 0, to: 0 }, page: { from: 26, to: 0 } }, area: { figma: {}, page: {} },
	} ] } ), null, DEFAULTS ).defects[ 0 ];
	assert.equal( between.summary, 'space between text "quote" and text "jane smith": 32px in Figma (32 gap + 0 margin-bottom on the upper), 58px on the page (32 gap + 26 margin-bottom on the upper) (+26px)', 'names the margin to remove' );
} );

test( 'padding ignores off-screen slides and clips overflowing ones', () => {
	const boxes = [
		{ type: 'text', x: 191, y: 159, w: 1056, h: 108 }, // visible slide
		{ type: 'text', x: 1260, y: 177, w: 1080, h: 72 }, // next slide, mostly off-screen
		{ type: 'text', x: -1100, y: 177, w: 1080, h: 72 }, // previous slide, fully off-screen
	];
	assert.deepEqual( paddingOf( boxes, 1440, 474 ), { top: 159, right: 0, bottom: 207, left: 191 } );
} );

test( 'pages load with a unique query parameter so page caches are skipped', () => {
	assert.equal( cacheBusted( 'https://site.test/careers/', 42 ), 'https://site.test/careers/?fvd=42' );
	assert.equal( cacheBusted( 'https://site.test/?p=7&fvd=1', 43 ), 'https://site.test/?p=7&fvd=43' );
	assert.notEqual( cacheBusted( 'https://site.test/' ), 'https://site.test/' );
} );

/**
 * A test image: rows painted by band, each band { from, to, rgb }.
 *
 * @param {number} width  Image width.
 * @param {number} height Image height.
 * @param {Array}  bands  Row bands; unpainted rows are white.
 * @return {Promise<Object>} PNG.
 */
test( 'sync points keep the longest chain running in the same order on both sides', () => {
	const box = ( y, h ) => ( { x: 0, y, w: 100, h } );
	const pairs = [
		{ f: box( 10, 20 ), p: box( 10, 20 ) },
		{ f: box( 50, 20 ), p: box( 60, 20 ) },
		{ f: box( 90, 20 ), p: box( 100, 20 ) },
		// Matched far away (arrows moved below the slides): it can't tie the rows in a knot.
		{ f: box( 20, 10 ), p: box( 150, 10 ) },
	];
	assert.deepEqual( anchorPoints( pairs, 200, 220 ), [ [ 10, 10 ], [ 30, 30 ], [ 50, 60 ], [ 70, 80 ], [ 90, 100 ], [ 110, 120 ] ] );
	assert.deepEqual( anchorPoints( [ { f: box( 0, 200 ), p: box( 0, 220 ) } ], 200, 220 ), [], 'a section\'s own edges are not sync points' );
} );

test( 'elements occurring once anchor first, so a repeated one matched into the wrong card can\'t misalign', () => {
	const box = ( y, h = 5 ) => ( { x: 0, y, w: 100, h } );
	// Two cards, each a unique heading over the same three bullets. The page's first card is
	// 200px taller, and the matcher crossed the bullets: Figma card A's to page card B's.
	const bullets = ( fy, py ) => [ 0, 10, 20 ].map( ( d ) => ( { f: box( fy + d ), p: box( py + d ) } ) );
	const pairs = [
		{ f: box( 10 ), p: box( 10 ), unique: true },
		{ f: box( 100 ), p: box( 300 ), unique: true },
		...bullets( 40, 330 ),
		...bullets( 130, 40 ),
		// A bullet matched right, between the two headings on both sides, still fills in.
		{ f: box( 70 ), p: box( 80 ) },
	];
	assert.deepEqual( anchorPoints( pairs, 400, 600 ), [ [ 10, 10 ], [ 15, 15 ], [ 70, 80 ], [ 75, 85 ], [ 100, 300 ], [ 105, 305 ] ] );
} );

test( 'rows pair between sync points, and the longer side\'s extra rows become a gap', () => {
	const rows = alignRows( [ [ 10, 10 ], [ 30, 30 ], [ 50, 60 ], [ 70, 80 ], [ 90, 100 ], [ 110, 120 ] ], 200, 220 );
	assert.deepEqual( rows, [
		{ at: 0, figma: 0, page: 0, length: 50 },
		{ at: 50, figma: null, page: 50, length: 10 },
		{ at: 60, figma: 50, page: 60, length: 150 },
		{ at: 210, figma: null, page: 210, length: 10 },
	] );
	assert.equal( alignedHeight( rows ), 220 );
	// Every row of both sections appears once, in order.
	const [ f, p ] = rowSources( rows );
	assert.deepEqual( [ ...f ].filter( ( r ) => r >= 0 ), [ ...Array( 200 ).keys() ] );
	assert.deepEqual( [ ...p ].filter( ( r ) => r >= 0 ), [ ...Array( 220 ).keys() ] );
} );

test( 'without sync points the tops line up, and the taller section\'s extra rows show at the bottom', () => {
	assert.deepEqual( alignRows( [], 100, 130 ), [ { at: 0, figma: 0, page: 0, length: 100 }, { at: 100, figma: null, page: 100, length: 30 } ] );
	assert.deepEqual( alignRows( [], 130, 100 ), [ { at: 0, figma: 0, page: 0, length: 100 }, { at: 100, figma: 100, page: null, length: 30 } ] );
	assert.deepEqual( alignRows( [], 100, 100 ), [ { at: 0, figma: 0, page: 0, length: 100 } ] );
} );

test( 'shifts within the band tolerance open no gap, but drift adding up past it does', () => {
	assert.deepEqual( alignRows( [ [ 20, 22 ], [ 40, 41 ], [ 60, 63 ] ], 100, 103 ).filter( ( s ) => null === s.figma || null === s.page ), [ { at: 100, figma: null, page: 100, length: 3 } ] );
	const drifting = alignRows( [ [ 20, 22 ], [ 40, 44 ], [ 60, 66 ] ], 100, 106 );
	// The gap opens where the shift passes the tolerance (40); the section bottom closes the rest.
	assert.deepEqual( drifting.filter( ( s ) => null === s.figma ).map( ( s ) => [ s.page, s.length ] ), [ [ 40, 4 ], [ 104, 2 ] ] );
	assert.ok( BAND_TOLERANCE >= 1 );
} );

test( 'a row or box on either side is placed through its own side\'s rows', () => {
	const rows = alignRows( [ [ 50, 60 ] ], 200, 220 );
	assert.equal( alignedRow( rows, 'page', 55 ), 55, 'a page row in the gap' );
	assert.equal( alignedRow( rows, 'figma', 60 ), 70, 'Figma rows after the gap move down by it' );
	assert.equal( alignedRow( rows, 'figma', 500 ), 210, 'past the end: after that side\'s last row' );
	assert.deepEqual( alignedBox( rows, 'figma', { x: 5, y: 40, w: 10, h: 20 } ), { x: 5, y: 40, w: 10, h: 30 }, 'a gap opening inside a box stretches it' );
	// The report places a ghost through the rows of the side it was measured on.
	const where = inPixelImage( { figma: { x: 0, y: 60, w: 10, h: 10, ghost: false }, page: { x: 0, y: 60, w: 10, h: 10, ghost: true, from: 'figma' } }, { pixelRows: rows } );
	assert.deepEqual( [ where.figma.y, where.page.y ], [ 70, 70 ] );
	assert.equal( inPixelImage( { figma: { x: 0, y: 60, w: 10, h: 10 } }, {} ), null, 'no alignment, no placement' );
} );

test( 'matched elements give the wireframe report its sync points', () => {
	const figma = { height: 400, boxes: [ textBox( 20, 50, 200, 20, 'Contact us' ), textBox( 20, 300, 200, 20, 'Submit your request' ) ] };
	const page = { height: 520, boxes: [ textBox( 20, 50, 200, 20, 'Contact us' ), textBox( 20, 420, 200, 20, 'Submit your request' ) ] };
	const a = analyseSection( figma, page, { tolerance: 8, live: false, width: 375 } );
	assert.deepEqual( a.anchors, [ [ 50, 50 ], [ 70, 70 ], [ 300, 420 ], [ 320, 440 ] ] );
} );

test( 'texts with different copy pair only where one element was plausibly reworded', () => {
	const analyse = ( fig, pg, height = [ 600, 600 ], width = 375 ) => analyseSection( { height: height[ 0 ], boxes: fig }, { height: height[ 1 ], boxes: pg }, { tolerance: 8, live: false, width } );
	const copyOf = ( a ) => a.copy.map( ( c ) => `${ c.figma.text } -> ${ c.page.text }` );
	// A form whose page has an extra field: "Company" pairs with the "File upload" label below it,
	// 40px from where the fields around it put it. That's a missing field and an extra one.
	const form = analyse(
		[ textBox( 20, 250, 60, 20, 'Email' ), textBox( 20, 300, 80, 20, 'Company' ), textBox( 20, 400, 80, 20, 'Message' ) ],
		[ textBox( 20, 250, 60, 20, 'Email' ), textBox( 20, 340, 90, 20, 'File upload' ), textBox( 20, 460, 80, 20, 'Message' ) ],
	);
	assert.deepEqual( copyOf( form ), [] );
	assert.deepEqual( [ form.missing.map( ( b ) => b.text ), form.extra.map( ( b ) => b.text ) ], [ [ 'company' ], [ 'file upload' ] ] );

	// Reworded in place: a copy change.
	const button = analyse( [ textBox( 20, 250, 60, 20, 'Email' ), textBox( 20, 300, 90, 20, 'Work with us' ) ], [ textBox( 20, 250, 60, 20, 'Email' ), textBox( 20, 302, 80, 20, 'Contact us' ) ] );
	assert.deepEqual( copyOf( button ), [ 'work with us -> contact us' ] );

	// All copy different (a design still in lorem ipsum): nothing says where a text should be, so
	// the matcher's pairing by position stands.
	const lorem = analyse( [ textBox( 20, 100, 200, 20, 'Lorem ipsum dolor' ) ], [ textBox( 20, 140, 200, 20, 'Contact us today' ) ] );
	assert.deepEqual( copyOf( lorem ), [ 'lorem ipsum dolor -> contact us today' ] );

	// Two columns: the left one drifts 100px down, which the row alignment follows. A text reworded
	// in place in the right column is still a copy change, by the text beside it.
	const columns = analyse(
		[ textBox( 20, 100, 200, 20, 'Left one' ), textBox( 20, 200, 200, 20, 'Left two' ), textBox( 20, 300, 200, 20, 'Left three' ), textBox( 600, 240, 200, 20, 'Right title' ), textBox( 600, 280, 200, 20, 'Old right copy' ) ],
		[ textBox( 20, 100, 200, 20, 'Left one' ), textBox( 20, 300, 200, 20, 'Left two' ), textBox( 20, 400, 200, 20, 'Left three' ), textBox( 600, 242, 200, 20, 'Right title' ), textBox( 600, 282, 200, 20, 'New right copy' ) ],
		[ 600, 700 ], 1000,
	);
	assert.deepEqual( copyOf( columns ), [ 'old right copy -> new right copy' ] );
} );

test( 'pixel masking covers where both sides have an image, and the rest of one taller on its side', () => {
	const identity = alignRows( [], 200, 200 );
	const mask = mediaMask( identity, 200, [ { x: 50, y: 50, width: 100, height: 100 } ], [ { x: 0, y: 0, width: 100, height: 100 }, { x: 150, y: 150, width: 40, height: 40 } ], 200, 200 );
	const at = ( m, w, x, y ) => m[ y * w + x ];
	assert.equal( mask.reduce( ( n, v ) => n + v, 0 ), 50 * 50, 'only the overlap' );
	assert.equal( at( mask, 200, 60, 60 ), 1 );
	assert.equal( at( mask, 200, 160, 160 ), 0, 'an image with no counterpart stays compared' );
	assert.equal( mediaMask( identity, 200, [ { x: 0, y: 0, width: 200, height: 120 } ], [ { x: 0, y: 0, width: 200, height: 120 } ], 200, 200 ).reduce( ( n, v ) => n + v, 0 ), 0, 'a background image stays compared' );
	// The page image is 20px taller: its extra rows fall in a gap and stay masked there.
	const taller = mediaMask( alignRows( [ [ 40, 60 ] ], 100, 120 ), 100, [ { x: 0, y: 0, width: 40, height: 40 } ], [ { x: 0, y: 0, width: 40, height: 60 } ], 100, 120 );
	assert.equal( at( taller, 100, 10, 50 ), 1 );
	assert.equal( at( taller, 100, 60, 50 ), 0 );
} );

async function banded( width, height, bands ) {
	const { PNG } = await loadDeps();
	const png = new PNG( { width, height } );
	for ( let y = 0; y < height; y++ ) {
		const band = bands.find( ( b ) => y >= b.from && y < b.to );
		const [ r, g, b ] = band ? band.rgb : [ 255, 255, 255 ];
		for ( let x = 0; x < width; x++ ) {
			const d = ( y * width + x ) * 4;
			png.data[ d ] = r;
			png.data[ d + 1 ] = g;
			png.data[ d + 2 ] = b;
			png.data[ d + 3 ] = 255;
		}
	}
	return png;
}

const RED = [ 220, 30, 30 ];
const GREEN = [ 30, 160, 60 ];
const BLACK = [ 0, 0, 0 ];

/** Rows of a PNG containing a colour, as a Set of row indexes. */
function rowsWith( png, [ r, g, b ] ) {
	const rows = new Set();
	for ( let y = 0; y < png.height; y++ ) {
		const d = y * png.width * 4;
		if ( png.data[ d ] === r && png.data[ d + 1 ] === g && png.data[ d + 2 ] === b ) {
			rows.add( y );
		}
	}
	return rows;
}

test( 'a section drifting further down is compared whole: top and bottom both line up', async () => {
	// Figma: a heading at 10–19 and a button at 60–69. The page keeps the heading, but an extra
	// field (80–89) pushes the button 50px down (110–119). Red above, green below the section.
	const figma = await banded( 40, 100, [ { from: 10, to: 20, rgb: BLACK }, { from: 60, to: 70, rgb: BLACK } ] );
	const page = await banded( 40, 350, [ { from: 0, to: 100, rgb: RED }, { from: 110, to: 120, rgb: BLACK }, { from: 180, to: 190, rgb: BLACK }, { from: 210, to: 220, rgb: BLACK }, { from: 250, to: 350, rgb: GREEN } ] );
	const section = { y: 100, height: 150 };
	const rows = alignRows( [ [ 10, 10 ], [ 20, 20 ], [ 60, 110 ], [ 70, 120 ] ], 100, 150 );
	const best = compareSection( figma, page, section, rows, 40, null, 0 );
	assert.deepEqual( [ best.a.height, best.b.height ], [ 150, 150 ], 'both sections whole' );
	assert.ok( rowsWith( best.b, BLACK ).has( 10 ), 'the page heading is shown, not cut off' );
	assert.deepEqual( [ ...rowsWith( best.a, BLACK ) ].filter( ( y ) => y >= 100 ), [ ...rowsWith( best.b, BLACK ) ].filter( ( y ) => y >= 100 ), 'the buttons line up' );
	assert.equal( rowsWith( best.b, RED ).size + rowsWith( best.b, GREEN ).size, 0, 'nothing from the sections around it' );
	assert.ok( rowsWith( best.b, BLACK ).has( 80 ), 'the extra field is shown' );
	assert.ok( [ 0xe6e6e6, 0xcccccc ].includes( best.a.data.readUInt32BE( 85 * 40 * 4 ) >>> 8 ), 'opposite a gap on the Figma side' );
	assert.ok( Math.abs( best.score - 2 / 3 ) < 0.01, `the extra field is content Figma doesn't match (score ${ best.score })` );

	// Only extra space, no extra content: spacing is the wireframe diff's to report.
	const spaced = await banded( 40, 350, [ { from: 0, to: 100, rgb: RED }, { from: 110, to: 120, rgb: BLACK }, { from: 210, to: 220, rgb: BLACK }, { from: 250, to: 350, rgb: GREEN } ] );
	assert.equal( compareSection( figma, spaced, section, rows, 40, null, 0 ).score, 1 );
} );

test( 'the page section is shown whole even without an alignment, and its extra rows count', async () => {
	const figma = await banded( 40, 100, [ { from: 10, to: 20, rgb: BLACK } ] );
	const page = await banded( 40, 300, [ { from: 110, to: 120, rgb: BLACK }, { from: 230, to: 240, rgb: BLACK } ] );
	const best = compareSection( figma, page, { y: 100, height: 150 }, alignRows( [], 100, 150 ), 40, null, 0 );
	assert.equal( best.b.height, 150 );
	assert.ok( rowsWith( best.b, BLACK ).has( 130 ), 'rows past Figma\'s height appear' );
	assert.ok( best.score < 1, 'content only the page has counts against it' );
	// A page section shorter than Figma's: Figma's rest is shown against a gap.
	const short = compareSection( figma, page, { y: 100, height: 60 }, alignRows( [], 100, 60 ), 40, null, 0 );
	assert.equal( short.a.height, 100 );
	assert.ok( [ 0xe6e6e6, 0xcccccc ].includes( short.b.data.readUInt32BE( 80 * 40 * 4 ) >>> 8 ), 'grey stripes' );
} );

test( 'pixels only refine the alignment by a few px', async () => {
	// Figma draws the bar at 25–34; the page renders it 2px lower.
	const figma = await banded( 40, 100, [ { from: 25, to: 35, rgb: BLACK } ] );
	const page = await banded( 40, 100, [ { from: 27, to: 37, rgb: BLACK } ] );
	const section = { y: 0, height: 100 };
	const rows = alignRows( [], 100, 100 );
	const nudged = compareSection( figma, page, section, rows, 40, null );
	assert.deepEqual( [ nudged.score, nudged.refine ], [ 1, 2 ] );
	assert.equal( nudged.rows[ 0 ].page, 2, 'the shift used is in the rows, for placing page boxes' );
	// Beyond the window, no search rescues it.
	const far = await banded( 40, 100, [ { from: 25 + REFINE + 2, to: 35 + REFINE + 2, rgb: BLACK } ] );
	assert.ok( compareSection( figma, far, section, rows, 40, null ).score < 1 );
} );

test( 'the image mask moves with the page when pixels refine the alignment', async () => {
	// The page renders everything 2px lower: a bar, and an image with a different photo.
	const figma = await banded( 40, 100, [ { from: 20, to: 40, rgb: GREEN }, { from: 60, to: 65, rgb: BLACK } ] );
	const page = await banded( 40, 100, [ { from: 22, to: 42, rgb: RED }, { from: 62, to: 67, rgb: BLACK } ] );
	const media = { figma: [ { x: 0, y: 20, width: 40, height: 20 } ], page: [ { x: 0, y: 22, width: 40, height: 20 } ] };
	const best = compareSection( figma, page, { y: 0, height: 100 }, alignRows( [], 100, 100 ), 40, media );
	assert.deepEqual( [ best.score, best.refine ], [ 1, 2 ], 'no edge of the photo is compared' );
	assert.equal( rowsWith( best.b, RED ).size, 20, 'the page panel keeps its photo' );
	assert.deepEqual( [ ...rowsWith( best.diff, [ 255, 0, 255 ] ) ], [ ...rowsWith( best.b, RED ) ], 'the diff panel shows the whole photo masked' );
} );

test( 'a repeating grid missing a row still loses score, however it was matched', async () => {
	// Rows of cards every 20px. The page's grid starts 3px lower, and its first row is missing.
	const grid = ( start, count ) => Array.from( { length: count }, ( v, k ) => ( { from: start + 20 * k, to: start + 20 * k + 8, rgb: BLACK } ) );
	const figma = await banded( 40, 100, grid( 10, 4 ) );
	const page = await banded( 40, 100, grid( 33, 3 ) );
	const section = { y: 0, height: 100 };
	// Matched right (Figma's rows 2–4 to the page's three), or shifted a row (1–3).
	for ( const anchors of [ [ [ 30, 33 ], [ 50, 53 ], [ 70, 73 ] ], [ [ 10, 33 ], [ 30, 53 ], [ 50, 73 ] ] ] ) {
		assert.ok( compareSection( figma, page, section, alignRows( anchors, 100, 100 ), 40, null ).score < 0.9, `the missing row must count (anchors ${ JSON.stringify( anchors ) })` );
	}
} );

test( 'sync points and results are matched by the Figma section, not by position', () => {
	// The pixel diff drops an overlay (Figma y 900) that the wireframe diff numbers, so from
	// there on the two reports' section numbers disagree.
	const file = path.join( fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-align-' ) ), 'report.json' );
	const wireframe = [
		{ index: 1, figmaY: 0, anchors: [ [ 10, 3 ] ] },
		{ index: 2, figmaY: 900, anchors: [ [ 20, 60 ] ] },
		{ index: 3, figmaY: 1500, anchors: [ [ 40, 45 ] ] },
		{ index: 4, figmaY: 2000, status: 'masked' },
	];
	fs.writeFileSync( file, JSON.stringify( { sections: wireframe } ) );

	const anchors = readAnchors( file );
	assert.deepEqual( anchors.get( 1500 ), [ [ 40, 45 ] ], 'pixel section #2 is Figma y 1500, not the overlay' );
	assert.deepEqual( anchors.get( 0 ), [ [ 10, 3 ] ] );
	assert.equal( anchors.has( 2000 ), false, 'a masked section has none' );
	assert.equal( readAnchors( undefined ).size, 0, 'no report means no alignment' );

	const pixelOf = sameSection( [ { index: 1, figmaY: 0, score: 0.9 }, { index: 2, figmaY: 1500, score: 0.8 } ] );
	assert.deepEqual( wireframe.slice( 0, 3 ).map( ( w ) => pixelOf( w )?.score ), [ 0.9, undefined, 0.8 ] );
} );

test( 'a Figma section ends where the next one starts', () => {
	// Rounded separately, 5669.6+233.6 becomes 5670+234, one row past the next section's top.
	const sections = [ { name: 'Intro Copy', y: 5670, height: 234 }, { name: 'Post Slider', y: 5903, height: 656 }, { name: 'Last', y: 6559, height: 100 } ];
	assert.deepEqual( tileSections( sections ).map( ( s ) => s.height ), [ 233, 656, 100 ] );
	assert.deepEqual( tileSections( [ { y: 0, height: 90 }, { y: 100, height: 50 } ] ).map( ( s ) => s.height ), [ 90, 50 ], 'a gap is left alone' );
} );

test( 'dependencies resolve from the package that holds the skill, wherever it is installed', async () => {
	// The plugin can be installed anywhere; deps.js walks up from the scripts to the
	// package.json that declares playwright and loads the modules from there.
	const root = packageRoot();
	assert.ok( JSON.parse( fs.readFileSync( path.join( root, 'package.json' ), 'utf8' ) ).dependencies.playwright );
	assert.ok( path.join( here, '..' ).startsWith( root ), 'the package root sits above the skill' );
	const { PNG, pixelmatch, chromium, Ajv } = await loadDeps();
	assert.equal( typeof PNG, 'function' );
	assert.equal( typeof Ajv, 'function' );
	assert.equal( typeof pixelmatch, 'function' );
	assert.equal( typeof chromium.launch, 'function' );
} );

test( 'config.js prints the runs folder for a page and breakpoint, and creates it', () => {
	const root = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-runsdir-' ) );
	const out = execFileSync( process.execPath, [ path.join( here, '..', 'scripts', 'config.js' ), 'runs-dir', 'https://site.test/about-us/', '375', root ], { encoding: 'utf8', cwd: root } ).trim();
	assert.equal( out, path.join( root, path.basename( root ), 'about-us', '375' ) );
	assert.ok( fs.statSync( out ).isDirectory() );
	fs.rmSync( root, { recursive: true } );
} );

test( 'config.js prints the Figma extractor ready to run unchanged, with the project\'s ignore pattern', async () => {
	const root = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-extractor-' ) );
	fs.writeFileSync( path.join( root, '.figma-visual-diff.json' ), JSON.stringify( { figmaIgnore: "^(Nav|Joe's Footer)\\b" } ) );
	const code = execFileSync( process.execPath, [ path.join( here, '..', 'scripts', 'config.js' ), 'figma-boxes', '16233-18647' ], { encoding: 'utf8', cwd: root } );
	fs.rmSync( root, { recursive: true } );

	// Run it the way use_figma does: an async body with the plugin API as `figma`.
	const section = ( name, y ) => ( { name, type: 'FRAME', absoluteBoundingBox: { x: 0, y, width: 1440, height: 100 }, children: [] } );
	const frame = { name: 'Page', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 300 }, children: [ section( 'Nav', 0 ), section( 'Hero / Desktop', 100 ), section( "Joe's Footer / Desktop", 200 ) ] };
	const requested = [];
	const AsyncFunction = Object.getPrototypeOf( async () => {} ).constructor;
	const out = await new AsyncFunction( 'figma', code )( { getNodeByIdAsync: async ( id ) => ( requested.push( id ), frame ) } );

	assert.deepEqual( requested, [ '16233:18647' ], 'the node id uses Figma\'s colon form' );
	assert.deepEqual( out.split( '\n' ).filter( ( l ) => l.startsWith( 'S|' ) ), [ 'S|0|Hero / Desktop|100|100|1' ], 'ignored layers are not sections' );
} );

test( 'triage accepts --section for a single block', () => {
	const args = parseArgs( [ '--url', 'https://site.test/demo/', '--width', '1440', '--file-key', 'ABC', '--node-id', '1:2', '--section', '--runs-root', '/data/runs', '--project', 'acme' ] );
	assert.equal( args.section, true );
	assert.equal( args.fileKey, 'ABC', '--section takes no value, so the next flag still parses' );
} );

test( 'arguments: a flag without its value, or a bad number, is an error rather than a silent default', () => {
	const rules = { defaults: { viewportHeight: 900 }, flags: [ 'section' ], numbers: [ 'width', 'viewportHeight' ], required: [ 'url', 'width' ] };
	assert.deepEqual( parseFlags( [ '--url', 'https://site.test/', '--width', '375', '--section' ], rules ), { url: 'https://site.test/', width: 375, viewportHeight: 900, section: true } );
	assert.throws( () => parseFlags( [ '--url', '--width', '375' ], rules ), /Missing value for --url/ );
	assert.throws( () => parseFlags( [ '--url', 'https://site.test/', '--width' ], rules ), /Missing value for --width/ );
	assert.throws( () => parseFlags( [ '--url', 'https://site.test/', '--width', '375', '--viewport-height', 'tall' ], rules ), /--viewport-height must be a number/ );
	assert.throws( () => parseFlags( [ '--url', 'https://site.test/' ], rules ), /Missing --width/ );
} );

test( 'a Figma layer name containing "|" still reads back as one section', () => {
	const frame = { absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 200 }, children: [ { name: 'Hero | Desktop', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 200 }, children: [] } ] };
	const file = path.join( fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-pipe-' ) ), 'figma-boxes.txt' );
	fs.writeFileSync( file, extractBoxes( frame, { ignore: DEFAULT_CONFIG.figmaIgnore, section: false } ) );
	const { sections } = parseFigma( file, DEFAULT_CONFIG );
	assert.deepEqual( sections.map( ( s ) => [ s.slug, s.y, s.height ] ), [ [ 'hero', 0, 200 ] ] );
} );

test( 'the extractor explains a node that is not a frame', () => {
	assert.throws( () => extract( { id: '1:2', type: 'PAGE' } ), /1:2 is not a frame/ );
	assert.throws( () => extract( null ), /not found/ );
} );

/** A Jev stand-in: records requests and answers from `answer( state )`, as the API documents. */
function fakeJev( answer ) {
	const requests = [];
	const request = async ( url, init ) => {
		requests.push( { url, init, body: JSON.parse( init.body ) } );
		const reply = answer( JSON.parse( init.body ), requests.length );
		if ( reply.status ) {
			return { ok: false, status: reply.status, headers: { get: () => '0' }, text: async () => reply.text ?? '' };
		}
		return { ok: true, status: 200, json: async () => reply };
	};
	return { request, requests };
}

/** Jev's answer to moduleQuestions(): `correct` for the module, `matters(id)` per defect. */
const jevAnswer = ( correct, matters = () => 0.5 ) => ( body ) => ( {
	model: 'jev-1.13.0',
	answers: Object.fromEntries( Object.keys( body.questions ).map( ( k ) => [ k, { type: 'noul', noul: 'correct' === k ? correct : matters( k ) } ] ) ),
	usage: { input_tokens: 400, output_tokens: 60 },
} );

test( 'Jev defaults to OpenCode Zen, and a custom provider comes from the config with its key from the environment', () => {
	const zen = { url: 'https://opencode.ai/zen/v1/systemone', keyEnv: 'OPENCODE_API_KEY', model: 'jev-1.13-free' };
	assert.deepEqual( jevEndpoint( null, {} ), { ...zen, key: undefined }, 'no key: triage skips the diagnosis and names the variable' );
	assert.deepEqual( jevEndpoint( null, { OPENCODE_API_KEY: 'k' }, 'jev-1.13' ), { ...zen, model: 'jev-1.13', key: 'k' } );
	const router = { url: 'https://9router.dev.test/v1/systemone', model: 'oc/jev-1.13-free', keyEnv: 'NINEROUTER_API_KEY' };
	assert.deepEqual( jevEndpoint( router, { NINEROUTER_API_KEY: 'r', OPENCODE_API_KEY: 'k' } ), { ...router, key: 'r' } );
	assert.equal( jevEndpoint( { url: router.url, keyEnv: 'X' }, {} ).model, 'jev-1.13-free' );
	assert.throws( () => jevEndpoint( { url: router.url }, {} ), /keyEnv/ );
} );

test( 'the user config sits under the project config', () => {
	const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-usercfg-' ) );
	const user = path.join( dir, 'user.json' );
	const project = path.join( dir, '.figma-visual-diff.json' );
	fs.writeFileSync( user, JSON.stringify( { jev: { url: 'https://router.test/v1/systemone', keyEnv: 'R' }, mask: [ 'from-user' ] } ) );
	fs.writeFileSync( project, JSON.stringify( { mask: [ 'from-project' ] } ) );
	const config = loadConfig( project, user );
	assert.deepEqual( config.jev, { url: 'https://router.test/v1/systemone', keyEnv: 'R' } );
	assert.deepEqual( config.mask, [ 'from-project' ] );
	assert.equal( loadConfig( project, path.join( dir, 'absent.json' ) ).jev, null, 'no user config: Zen' );
	assert.equal( userConfigFile( { XDG_CONFIG_HOME: '/x' } ), path.join( '/x', 'figma-visual-diff', 'config.json' ) );
	fs.rmSync( dir, { recursive: true } );
} );

test( 'each module goes to Jev as structured facts, with one question per defect and one for the module', async () => {
	const report = sampleReport();
	const jev = fakeJev( jevAnswer( 0.9 ) );
	await diagnose( report, jevEndpoint( null, { OPENCODE_API_KEY: 'k' } ), jev.request );
	assert.equal( jev.requests.length, 3, 'one request per compared module; the dynamic one is skipped' );
	const { init, body } = jev.requests[ 1 ];
	assert.equal( init.headers.Authorization, 'Bearer k' );
	assert.equal( body.model, 'jev-1.13-free' );
	const section = report.sections[ 1 ];
	assert.deepEqual( Object.keys( body.questions ), [ 'correct', ...section.defects.map( ( d ) => `d${ d.id.replace( '.', '_' ) }` ) ] );
	assert.ok( Object.values( body.questions ).every( ( q ) => 'noul' === q.type ) );
	assert.match( body.questions.d2_1.instructions, /`defects\.d2_1`/, 'each question points at its defect' );
	assert.deepEqual( Object.keys( body.state.defects ), Object.keys( body.questions ).slice( 1 ) );
	assert.deepEqual( body.state.module, { block: 'content-cards', figmaLayer: 'Content Cards / Desktop', breakpoint: '1440px wide' } );
	const live = moduleState( { ...section, live: true }, 1440 );
	assert.ok( live.module.content.includes( 'live posts' ) && ! live.overall.height, 'a live section is not judged by its height' );
} );

test( 'defect facts carry the arithmetic Jev would otherwise have to do', () => {
	const section = { figmaHeight: 600 };
	const facts = ( d ) => defectFacts( d, section, 1440 );
	const edge = facts( { issue: 'spacing', where: 'edge', side: 'bottom', from: { type: 'text', x: 68, y: 139, w: 600, h: 67, text: 'built for' }, figma: 92, page: 73, delta: -19, count: 1, margins: { figma: { from: 20 }, page: { from: 0 } } } );
	assert.equal( edge.change, '92px in Figma, 73px on the page: -19px (21% less)' );
	assert.equal( edge.marginsInTheSpace, 'in Figma 20px; on the page none' );
	assert.equal( facts( { issue: 'missing', figma: { type: 'image', x: 0, y: 0, w: 720, h: 300 } } ).size, 'covers 25% of the section' );
	assert.equal( facts( { issue: 'resized', figma: { type: 'image', x: 68, y: 0, w: 408, h: 272 }, page: { w: 422, h: 281 }, delta: { w: 14, h: 9 } } ).width, '408px in Figma, 422px on the page: +14px (3% more)' );
	assert.equal( facts( { issue: 'style', property: 'weight', figma: '700', page: '400', count: 1, element: { type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'meta' } } ).change, 'bold (700) in Figma, regular (400) on the page' );
	const pill = facts( { issue: 'style', property: 'stroke', figma: '#e0e0e0/1', page: '#3d3d3d/1', count: 5, element: { type: 'surface', x: 0, y: 0, w: 112, h: 29 } } );
	assert.match( pill.change, /^1px wide on both; colour #e0e0e0 in Figma, #3d3d3d on the page: ΔE 6\d\.\d/ );
	assert.equal( pill.elements, 5 );
	const style = facts( { issue: 'style', property: 'text-style', figma: 'Barlow/17/27.2/700/#f4f4f4', page: 'Barlow/17/27.2/400/#3d3d3d', element: { type: 'text', x: 0, y: 0, w: 10, h: 10, text: '2026 / city' } } );
	assert.deepEqual( Object.keys( style.closestPageStyle ), [ 'font weight', 'text colour' ], 'only the tokens that differ' );
} );

test( 'colour distance is perceptual: identical is 0, near-greys small, white against dark large', () => {
	assert.match( colourDistance( '#3d3d3d', '#3d3d3d' ), /ΔE 0\.0/ );
	const near = Number( /ΔE ([\d.]+)/.exec( colourDistance( '#f4f4f4', '#f2f2f2' ) )[ 1 ] );
	const far = Number( /ΔE ([\d.]+)/.exec( colourDistance( '#ffffff', '#3d3d3d' ) )[ 1 ] );
	assert.ok( near < 2.3 && far > 50, `${ near } / ${ far }` );
	assert.match( colourDistance( '#ffffff33', '#ffffff' ), /opacity 20% in Figma, 100% on the page/ );
} );

test( 'diagnoses mark each defect with how likely a fix is asked for, validate, and feed the metrics', async () => {
	const report = sampleReport();
	const jev = fakeJev( ( body ) => jevAnswer( 'hero' === body.state.module.block ? 0.95 : 0.1, ( k ) => ( 'd2_1' === k ? 0.9 : 0.1 ) )( body ) );
	await diagnose( report, jevEndpoint( null, { OPENCODE_API_KEY: 'k' } ), jev.request );
	assert.deepEqual( report.sections[ 0 ].diagnosis, { model: 'jev-1.13.0', correct: 0.95 } );
	const [ first, ...rest ] = report.sections[ 1 ].defects;
	assert.equal( first.matters, 0.9 );
	assert.ok( rest.every( ( d ) => 0.1 === d.matters ) );
	assert.equal( report.sections[ 3 ].diagnosis, undefined, 'dynamic sections are not diagnosed' );
	const wireframe = { pageScore: 0.8, structure: { figmaSections: 5, pageSections: 4, missing: [ { index: 5, slug: 'form-cta' } ], extra: [] } };
	report.metrics = buildMetrics( report, wireframe, { pageScore: 0.7 } );
	const defects = report.sections.filter( ( sec ) => sec.diagnosis ).flatMap( ( sec ) => sec.defects );
	assert.deepEqual( report.metrics.diagnosis, {
		model: 'jev-1.13.0', diagnosed: 3, expectedCorrectness: 0.2875, signedOff: 1, needsReview: 0, rejected: 2,
		expectedFixes: Math.round( ( 0.9 + 0.1 * ( defects.length - 1 ) ) * 10 ) / 10, negligible: defects.length - 1,
	} );
	await validateReport( report );
} );

test( 'a module Jev answers only in part is not diagnosed at all', async () => {
	const report = sampleReport();
	// No answer for the second defect of section 2.
	const jev = fakeJev( ( body ) => {
		const reply = jevAnswer( 0.8 )( body );
		delete reply.answers.d2_2;
		return reply;
	} );
	const warnings = await diagnose( report, jevEndpoint( null, { OPENCODE_API_KEY: 'k' } ), jev.request );
	assert.equal( report.sections[ 1 ].diagnosis, undefined );
	assert.ok( report.sections[ 1 ].defects.every( ( d ) => undefined === d.matters ), 'no defect keeps an answer' );
	assert.deepEqual( warnings, [ "Jev couldn't diagnose #2 content-cards: Jev left questions unanswered" ] );
	assert.deepEqual( report.sections[ 0 ].diagnosis, { model: 'jev-1.13.0', correct: 0.8 }, 'the other modules still are' );
} );

test( 'section images are named by position and slug, in safe characters', () => {
	assert.equal( sectionImage( 2, 'content-cards' ), '03-content-cards.png' );
	assert.equal( sectionImage( 0, "hero's / banner" ), '01-hero-s-banner.png', 'a sectionMap slug can name it anything' );
} );

test( 'a Jev failure becomes a warning, and a rate limit is retried until it clears', async () => {
	const report = sampleReport();
	const jev = fakeJev( ( state, n ) => ( 1 === n ? { status: 429 } : { status: 422, text: 'bad field' } ) );
	const warnings = await diagnose( report, jevEndpoint( null, { OPENCODE_API_KEY: 'k' } ), jev.request );
	assert.equal( warnings.length, 3 );
	assert.ok( warnings.every( ( w ) => w.includes( '422' ) ) );
	assert.equal( jev.requests.length, 4, 'the 429 was retried' );
	assert.ok( report.sections.every( ( sec ) => ! sec.diagnosis ) );

	// A burst: the first three answers are rate limits, then Jev answers; every module is diagnosed.
	const burst = sampleReport();
	const busy = fakeJev( ( body, n ) => ( n <= 3 ? { status: 429 } : jevAnswer( 0.9 )( body ) ) );
	assert.deepEqual( await diagnose( burst, jevEndpoint( null, { OPENCODE_API_KEY: 'k' } ), busy.request ), [] );
	assert.ok( burst.sections.filter( ( sec ) => 'dynamic' !== sec.verdict ).every( ( sec ) => sec.diagnosis ) );

	// Always rate-limited: it gives up after JEV_ATTEMPTS tries and says why.
	const one = { ...sampleReport(), sections: [ sampleReport().sections[ 0 ] ] };
	const never = fakeJev( () => ( { status: 429, text: 'Rate limit exceeded' } ) );
	const [ warning ] = await diagnose( one, jevEndpoint( null, { OPENCODE_API_KEY: 'k' } ), never.request );
	assert.equal( never.requests.length, 5 );
	assert.match( warning, /429/ );
} );

test( 'the review page flags where Jev and the measurements disagree', () => {
	const section = ( verdict, defects, correct ) => ( { verdict, defects, diagnosis: { model: 'jev', correct } } );
	const defect = ( id, matters ) => ( { id, kind: 'layout', issue: 'padding', owner: 'developer', matters } );
	assert.deepEqual( disagreements( section( 'ok', [], 0.9 ) ), [] );
	assert.match( disagreements( section( 'ok', [], 0.5 ) )[ 0 ], /rules pass it/ );
	assert.match( disagreements( section( 'layout', [ defect( '4.1', 0.7 ) ], 0.9 ) )[ 0 ], /Jev would sign it off/ );
	assert.deepEqual( disagreements( section( 'layout', [ defect( '4.1', 0.9 ), defect( '4.2', 0.1 ) ], 0.3 ) ), [ '1 defect(s) Jev thinks a reviewer wouldn\'t ask to fix: 4.2' ] );
} );

test( 'the review page shows each diagnosis with its evidence, escaped', async () => {
	const report = sampleReport();
	const jev = fakeJev( jevAnswer( 0.3, ( k ) => ( 'd2_7' === k ? 0.95 : 0.2 ) ) );
	await diagnose( report, jevEndpoint( null, { OPENCODE_API_KEY: 'k' } ), jev.request );
	const html = renderReport( report, '2026-09-25_120000' );
	assert.ok( html.includes( 'What Jev was shown and asked' ) );
	const card = html.slice( html.indexOf( 'id="s2"' ), html.indexOf( 'id="s3"' ) );
	const ids = [ ...card.matchAll( /data-defect="([\d.]+)"/g ) ].map( ( m ) => m[ 1 ] );
	assert.equal( ids[ 0 ], '2.7', 'the defect most worth fixing comes first' );
	assert.ok( html.includes( '&lt;we&gt;' ) && ! html.includes( '<we>' ), 'copy is escaped, also inside the state' );
	for ( const d of report.sections.flatMap( ( sec ) => sec.defects ) ) {
		assert.ok( html.includes( `>${ d.id }<` ), `defect ${ d.id } is listed` );
		if ( d.figma?.w || d.element ) {
			assert.ok( html.includes( `id="d-${ d.id }"` ), `defect ${ d.id } can be linked to` );
		}
	}
	assert.ok( html.includes( 'data-filter="disagree"' ) );
	assert.ok( html.includes( 'font size<div class="muted">text “who &lt;we&gt; work with”</div>' ), 'a style defect names its token and element' );
	assert.ok( html.includes( '28px' ) && html.includes( '24px' ), 'with units' );
	assert.ok( html.includes( 'src="wireframe/01-hero.png"' ), 'overlays link relative to the run folder' );
} );

test( 'a text layer alone in a vertically padded auto-layout frame takes its padding as margins; other text has none', () => {
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	const text = ( name, y, h ) => ( { type: 'TEXT', name, characters: name, absoluteBoundingBox: abs( 68, y, 400, h ) } );
	const frame = {
		type: 'FRAME', name: 'Page', absoluteBoundingBox: abs( 0, 0, 1440, 298 ),
		children: [ {
			type: 'INSTANCE', name: 'Intro Copy / Desktop', layoutMode: 'HORIZONTAL', paddingTop: 104, paddingBottom: 72, absoluteBoundingBox: abs( 0, 0, 1440, 298 ),
			children: [ { type: 'SLOT', name: 'Inner Blocks', layoutMode: 'VERTICAL', absoluteBoundingBox: abs( 68, 104, 1304, 122 ), children: [
				{ type: 'INSTANCE', name: 'Text Block', layoutMode: 'VERTICAL', paddingBottom: 12, absoluteBoundingBox: abs( 68, 104, 1304, 35 ), children: [ text( 'Who we work with', 104, 23 ) ] },
				{ type: 'INSTANCE', name: 'Text Block', layoutMode: 'VERTICAL', paddingBottom: 20, absoluteBoundingBox: abs( 68, 139, 1304, 87 ), children: [ text( 'Built for Every Property Type', 139, 67 ) ] },
				// Not a Text Block: two texts share the frame, and a plain frame has no auto-layout.
				{ type: 'FRAME', name: 'Pair', layoutMode: 'VERTICAL', paddingBottom: 30, absoluteBoundingBox: abs( 68, 226, 1304, 40 ), children: [ text( 'One', 226, 20 ), text( 'Two', 246, 20 ) ] },
				{ type: 'FRAME', name: 'Loose', paddingBottom: 30, absoluteBoundingBox: abs( 68, 266, 1304, 20 ), children: [ text( 'Three', 266, 20 ) ] },
				// A button: padded on every side, so its padding is the box's, not the label's margin.
				{ type: 'INSTANCE', name: 'Button', layoutMode: 'HORIZONTAL', paddingTop: 18, paddingBottom: 18, paddingLeft: 36, paddingRight: 36, absoluteBoundingBox: abs( 68, 286, 150, 60 ), children: [ text( 'Four', 304, 24 ) ] },
			] } ],
		} ],
	};
	const margins = extract( frame ).split( '\n' ).filter( ( l ) => l.includes( '|text|' ) ).map( ( l ) => l.split( '|' ).slice( 9, 11 ).map( Number ) );
	assert.deepEqual( margins, [ [ 0, 12 ], [ 0, 20 ], [ 0, 0 ], [ 0, 0 ], [ 0, 0 ], [ 0, 0 ] ] );
} );

test( 'figma-boxes.txt margins are read, and files without them read as none', () => {
	const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-margins-' ) );
	const file = path.join( dir, 'figma-boxes.txt' );
	fs.writeFileSync( file, 'F|1440|298\nS|0|Intro Copy / Desktop|0|298\nB|0|text|71|139|706|67|7a9f3bfa|built for every property typ|0|20\nB|0|text|68|104|176|23|fa71b1c4|who we work with\nB|0|icon|1|1|20|20||' );
	const [ intro ] = parseFigma( file, DEFAULT_CONFIG ).sections;
	assert.deepEqual( intro.boxes.map( ( b ) => [ b.mt, b.mb ] ), [ [ 0, 20 ], [ 0, 0 ], [ undefined, undefined ] ] );
	fs.rmSync( dir, { recursive: true } );
} );

test( 'padding is measured to the text margin, so a Figma Text Block matches a page that dropped the margin', () => {
	// The Intro Copy that reported bottom 92 → 73: Figma's heading ends at 206 with a 20px
	// Text Block padding, in a 298px section with 72px padding; the page dropped the margin.
	const figma = [ { type: 'text', x: 68, y: 104, w: 176, h: 23, mt: 0, mb: 12 }, { type: 'text', x: 71, y: 139, w: 706, h: 67, mt: 0, mb: 20 } ];
	const page = [ { type: 'text', x: 68, y: 104, w: 176, h: 23, mt: 0, mb: 12 }, { type: 'text', x: 70, y: 144, w: 700, h: 67, mt: 0, mb: 0 } ];
	assert.equal( paddingOf( figma, 1440, 298 ).bottom, 72 );
	assert.equal( paddingOf( page, 1440, 284 ).bottom, 73 );
	assert.equal( paddingOf( figma.map( ( { mt, mb, ...b } ) => b ), 1440, 298 ).bottom, 92, 'without margins: the old measurement' );
	assert.equal( paddingOf( [ { type: 'text', x: 0, y: 30, w: 10, h: 10, mt: 20, mb: 0 } ], 100, 100 ).top, 10, 'top margins count too' );
} );

test( 'stacked boxes of the same type, position and size count as one element', () => {
	// A CTA card in Figma: its fill and an overlay, both 702×500, then the image.
	const card = { type: 'surface', x: 12, y: 0, w: 702, h: 500 };
	const figma = [ card, { ...card }, { type: 'image', x: 12, y: 0, w: 702, h: 500 }, { ...card, x: 726 }, { ...card, x: 726 } ];
	assert.deepEqual( uniqueBoxes( figma ), [ card, figma[ 2 ], figma[ 3 ] ] );
	// Different text at the same spot, or a box 1px off, is still its own element.
	const a = { type: 'text', x: 0, y: 0, w: 10, h: 10, hash: 'a' };
	assert.equal( uniqueBoxes( [ a, { ...a, hash: 'b' }, { ...card }, { ...card, w: 703 } ] ).length, 4 );
	const page = [ card, { type: 'image', x: 12, y: 0, w: 702, h: 500 }, { ...card, x: 726 } ];
	const match = matchBoxes( uniqueBoxes( figma ), page, 8 );
	assert.deepEqual( [ match.missing.length, match.extra.length ], [ 0, 0 ] );
} );

test( 'inside Figma, nodes without a property (groups, rectangles, text) are read without it', () => {
	// The plugin API throws on reading a property a node type doesn't have; these stand-ins do too.
	const strict = ( node ) => new Proxy( node, { get: ( target, key ) => {
		if ( 'string' === typeof key && ! ( key in target ) ) {
			throw new TypeError( `node.${ key }: no such property '${ key }' on ${ target.type } node` );
		}
		return target[ key ];
	} } );
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	const scene = ( type, box, extra ) => strict( { type, name: type, visible: true, opacity: 1, absoluteBoundingBox: box, absoluteRenderBounds: box, ...extra } );
	const text = scene( 'TEXT', abs( 68, 104, 300, 36 ), {
		characters: 'Quality', fills: [ { type: 'SOLID', visible: true, opacity: 1, color: { r: 0, g: 0, b: 0 } } ], strokes: [], strokeWeight: 0,
		fontSize: 28, lineHeight: { unit: 'PERCENT', value: 130 }, fontName: { family: 'Barlow', style: 'Bold' }, fontWeight: 700,
	} );
	const card = scene( 'RECTANGLE', abs( 68, 160, 200, 100 ), { fills: [ { type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1 } } ], strokes: [], strokeWeight: 0, cornerRadius: 8 } );
	const group = scene( 'GROUP', abs( 68, 104, 300, 156 ), { children: [ text, card ] } );
	const frame = scene( 'FRAME', abs( 0, 0, 1440, 400 ), { fills: [], strokes: [], strokeWeight: 0, layoutMode: 'NONE', clipsContent: false, children: [
		scene( 'FRAME', abs( 0, 0, 1440, 400 ), { fills: [], strokes: [], strokeWeight: 0, layoutMode: 'VERTICAL', paddingTop: 104, paddingBottom: 104, paddingLeft: 68, paddingRight: 68, cornerRadius: 0, clipsContent: true, children: [ group ] } ),
	] } );
	const lines = extract( frame ).split( '\n' );
	assert.ok( lines.includes( 'B|0|text|68|104|300|36|ac7bfc28|quality|0|0|font=Barlow;size=28;lh=36.4;weight=700;color=#000000;italic=normal;deco=none;case=title;runs=1||68/300' ), lines.join( '\n' ) );
	assert.ok( lines.includes( 'B|0|surface|68|160|200|100|||||fill=#ffffff;radius=8;stroke=none' ), lines.join( '\n' ) );
} );

test( 'design tokens compare as the two sides spell them, and differences group by value', () => {
	assert.ok( sameToken( 'font', 'Barlow', 'barlow' ) );
	assert.ok( sameToken( 'color', '#3d3d3d', '#3e3d3c' ), 'within 2 per channel' );
	assert.ok( ! sameToken( 'color', '#3d3d3d', '#000000' ) );
	assert.ok( sameToken( 'fill', '#ffffff33', '#ffffff34' ) && ! sameToken( 'fill', '#ffffff33', '#ffffff' ), 'alpha counts; none is opaque' );
	assert.ok( sameToken( 'lh', '27.2', '27' ) && ! sameToken( 'lh', '27.2', '30' ) );
	assert.ok( sameToken( 'stroke', '#ffffff33/1', '#ffffff33/1' ) && ! sameToken( 'stroke', '#ffffff33/1', '#ffffff33/2' ) );
	// Per side and per corner: one value stands for all four.
	assert.ok( sameToken( 'stroke', '#cccccc/1', '#cccccc/1 #cccccc/1 #cccccc/1 #cccccc/1' ) );
	assert.ok( ! sameToken( 'stroke', '#cccccc/1', 'none none #cccccc/1 none' ), 'a bottom-only divider is not a full border' );
	assert.ok( sameToken( 'stroke', 'none none #cccccc/1 none', 'none none #cdcdcd/1 none' ) && ! sameToken( 'stroke', 'none', '#cccccc/1' ) );
	assert.ok( sameToken( 'stroke', '#ffffff00/1', 'none' ), 'a fully transparent border is none (files extracted before transparent strokes were dropped)' );
	assert.ok( sameToken( 'radius', '8', '8 8 8 8' ) && sameToken( 'radius', '8 8 0 0', '8 7 0 0' ) && ! sameToken( 'radius', '8', '8 8 0 0' ) );
	const title = ( x ) => ( { type: 'text', x, y: 0, w: 100, h: 36, text: 'quality', hash: 'ac7bfc28', style: { font: 'Barlow', size: '28', lh: '36.4', weight: '700', color: '#000000' } } );
	const pageTitle = ( x ) => ( { ...title( x ), style: { font: 'Barlow', size: '24', lh: '36.4', weight: '700', color: '#000000' } } );
	const diffs = styleDiffs( [ 0, 300, 600 ].map( ( x ) => ( { f: title( x ), p: pageTitle( x ) } ) ) );
	assert.deepEqual( diffs.map( ( d ) => [ d.property, d.figma, d.page ] ), [ [ 'size', '28', '24' ], [ 'size', '28', '24' ], [ 'size', '28', '24' ] ] );
	assert.deepEqual( styleDiffs( [ { f: title( 0 ), p: { ...title( 0 ), style: { size: '28' } } } ] ), [], 'a token the page does not report is not compared' );
	const s = triageSection( wireframeSection( { styles: diffs } ), null, DEFAULTS );
	assert.deepEqual( s.defects.map( ( d ) => [ d.kind, d.issue, d.property, d.count, d.owner ] ), [ [ 'visual', 'style', 'size', 3, 'page-or-developer' ] ] );
	assert.equal( s.defects[ 0 ].summary, 'text "quality" and 2 more like it: font size 28px in Figma, 24px on the page' );
} );

test( 'tokens are only compared between the same element: same copy, and colours both or neither translucent', () => {
	const label = { type: 'text', x: 0, y: 0, w: 80, h: 27, hash: 'a1', text: 'first name', style: { size: '17', weight: '600' } };
	const heading = { type: 'text', x: 0, y: 0, w: 120, h: 36, hash: 'b2', text: 'contact us', style: { size: '24', weight: '700' } };
	assert.deepEqual( styleDiffs( [ { f: label, p: heading } ] ), [], 'a label paired with a heading says nothing about either' );
	assert.equal( styleDiffs( [ { f: label, p: { ...label, style: { size: '14', weight: '600' } } } ] ).length, 1, 'the same label at another size does' );
	const column = ( fill ) => ( { type: 'surface', x: 0, y: 0, w: 720, h: 2100, style: { fill } } );
	assert.deepEqual( styleDiffs( [ { f: column( '#0000000d' ), p: column( '#f4f4f4' ) } ] ), [], '5% black over an unknown backdrop can\'t be judged against a grey' );
	assert.equal( styleDiffs( [ { f: column( '#0000000d' ), p: column( '#00000033' ) } ] ).length, 1 );
} );

test( 'a live section checks that every text style of the design is used, whatever the words', () => {
	const text = ( t, style ) => ( { type: 'text', x: 0, y: 0, w: 100, h: 30, text: t, style } );
	const title = { font: 'Barlow', size: '28', lh: '36.4', weight: '700', color: '#ffffff' };
	const meta = { font: 'Barlow', size: '17', lh: '27.2', weight: '700', color: '#f4f4f4' };
	const figma = [ text( 'viverra mauris', title ), text( 'viverra mauris', title ), text( '2026 / city, state', meta ) ];
	// The real posts: other titles, same title style; the meta line is regular and grey.
	const page = [ text( 'a real post title', title ), text( 'march 2026 / dallas, tx', { ...meta, weight: '400', color: '#3d3d3d' } ) ];
	assert.deepEqual( missingTextStyles( figma, page ), [ {
		property: 'text-style', figma: 'Barlow/17/27.2/700/#f4f4f4', page: 'Barlow/17/27.2/400/#3d3d3d',
		element: { type: 'text', x: 0, y: 0, w: 100, h: 30, text: '2026 / city, state' },
	} ] );
	const s = triageSection( wireframeSection( { live: true, styles: missingTextStyles( figma, page ) } ), null, DEFAULTS );
	assert.equal( s.defects[ 0 ].summary, 'text style Barlow/17/27.2/700/#f4f4f4 (e.g. "2026 / city, state") isn\'t used on the page; closest: Barlow/17/27.2/400/#3d3d3d' );
	assert.deepEqual( missingTextStyles( figma, [ ...page, text( 'x', meta ) ] ), [], 'once the page uses the style, it is there' );
} );

test( 'live sections check text styles as a set; other sections pair by element', () => {
	const A = { font: 'Barlow', size: '28', weight: '700' };
	const B = { font: 'Barlow', size: '17', weight: '400' };
	const t = ( x, text, style ) => ( { type: 'text', x, y: 0, w: 200, h: 36, text, hash: text, style } );
	const figma = { height: 100, boxes: [ t( 0, 'title', A ) ] };
	// The same element in another style, while style A is used elsewhere on the page.
	const page = { height: 100, boxes: [ t( 0, 'title', B ), t( 600, 'other', A ) ] };
	const opts = ( live ) => ( { tolerance: 8, live, width: 1440 } );
	assert.deepEqual( analyseSection( figma, page, opts( true ) ).styles, [], 'live: the style is used on the page' );
	assert.deepEqual( analyseSection( figma, page, opts( false ) ).styles.map( ( d ) => d.property ), [ 'size', 'weight' ], 'otherwise: this element differs' );
} );

test( 'a box a few px off is resized, text only past the font tolerance, in a section that passes too', () => {
	const offset = ( f, p ) => ( { figma: f, page: p, dx: p.x - f.x, dy: 0, dw: p.w - f.w, dh: p.h - f.h } );
	const input = { type: 'surface', x: 0, y: 0, w: 303, h: 48 };
	const label = { type: 'text', x: 0, y: 60, w: 47, h: 27, text: 'email *' };
	const issues = ( offsets, over = {} ) => triageSection( wireframeSection( { status: 'pass', offsets, ...over } ), null, DEFAULTS ).defects.map( ( d ) => d.issue );
	assert.deepEqual( issues( [ offset( input, { ...input, h: 52 } ) ] ), [ 'resized' ], 'an input 4px taller, though the section passes' );
	assert.deepEqual( issues( [ offset( input, { ...input, h: 51 } ) ] ), [], '3px is within sizeTolerance' );
	assert.deepEqual( issues( [ offset( label, { ...label, w: 52 } ) ] ), [], 'a label 5px wider is the font drawing it' );
	assert.deepEqual( issues( [], { figmaHeight: 250, pageHeight: 226, heightDelta: -24 } ), [ 'height' ], 'a section 24px short' );
	assert.deepEqual( issues( [], { figmaHeight: 250, pageHeight: 234, heightDelta: -16 } ), [], '16px is within heightTolerance' );
	// End to end: an input 4px taller where it stands survives analyseSection's offsets too.
	const w = analyseSection( { height: 200, boxes: [ input ] }, { height: 200, boxes: [ { ...input, h: 52 } ] }, { tolerance: 8, sizeTolerance: 3, live: false, width: 1440 } );
	assert.deepEqual( issues( w.offsets ), [ 'resized' ], 'resized in place, not moved' );
	// Images scaled to the same shape aren't defects, so they can't crowd out that input.
	const logos = Array.from( { length: MAX_OFFSETS }, ( _, i ) => ( { type: 'image', x: i * 100, y: 100, w: 80, h: 40 } ) );
	const g = analyseSection( { height: 200, boxes: [ input, ...logos ] }, { height: 200, boxes: [ { ...input, h: 52 }, ...logos.map( ( l ) => ( { ...l, w: 96, h: 48 } ) ) ] }, { tolerance: 8, sizeTolerance: 3, live: false, width: 1440 } );
	assert.ok( g.offsets.some( ( o ) => 'surface' === o.figma.type ), 'the input keeps its place among the offsets' );
} );

test( 'an image may be any size; only a different aspect ratio is a defect', () => {
	const image = ( w, h ) => ( { type: 'image', x: 68, y: 0, w, h } );
	const offset = ( f, p ) => ( { figma: f, page: p, dx: p.x - f.x, dy: 0, dw: p.w - f.w, dh: p.h - f.h } );
	const defects = ( p ) => triageSection( wireframeSection( { status: 'fail', score: 0.7, drift: { dx: 0, dy: 0, resized: 1 }, offsets: [ offset( image( 408, 272 ), p ) ] } ), null, DEFAULTS ).defects;
	assert.deepEqual( defects( image( 422, 281 ) ), [], 'scaled 3.4%, same 3:2 shape (1.50 vs 1.50)' );
	assert.deepEqual( defects( image( 612, 408 ) ), [], 'half as big again, same shape' );
	const [ taller ] = defects( image( 422, 300 ) );
	assert.deepEqual( [ taller.issue, taller.owner, taller.ratio ], [ 'aspect', 'developer', { figma: 1.5, page: 1.41 } ] );
	assert.equal( taller.summary, 'image 408×272 at 68,0 is 422×300 on the page: aspect ratio 1.5 in Figma, 1.41 on the page (6% taller)' );
	const text = { type: 'text', x: 0, y: 0, w: 300, h: 36, text: 'title' };
	const sized = triageSection( wireframeSection( { status: 'fail', score: 0.7, drift: { dx: 0, dy: 0, resized: 1 }, offsets: [ offset( text, { ...text, w: 340 } ) ] } ), null, DEFAULTS ).defects;
	assert.deepEqual( sized.map( ( d ) => d.issue ), [ 'resized' ], 'other elements still count their size' );
	// A full list of offsets (the report keeps the largest dozen) may leave out what fails the score.
	const many = Array.from( { length: MAX_OFFSETS }, () => offset( image( 408, 272 ), image( 422, 281 ) ) );
	const full = triageSection( wireframeSection( { status: 'fail', score: 0.7, drift: { dx: 0, dy: 0, resized: 1 }, offsets: many } ), null, DEFAULTS ).defects;
	assert.deepEqual( full.map( ( d ) => d.issue ), [ 'overlap' ], 'the failing score is still reported' );
} );

/** A text box as both extractors produce it: normalised prefix, hash of the whole text. */
const words = ( x, y, w, h, t, extra = {} ) => ( { type: 'text', x, y, w, h, text: normText( t ).slice( 0, TEXT_PREFIX ), hash: hash( normText( t ) ), full: normText( t ), ...extra } );
const analyse = ( fig, pg, opts = {} ) => analyseSection( { height: opts.fh ?? 400, boxes: fig }, { height: opts.ph ?? 400, boxes: pg }, { tolerance: 8, live: false, width: opts.width ?? 1440 } );

test( 'an image grid in another shape is reported even when what it pushed up fills the offsets', () => {
	// About's team grid: 1:1 photos in Figma, 3:2 on the page, so each card's name and role sit
	// 97px higher and the second row's cards 194px. The moved text overlaps Figma's least, so
	// it outranked the photos for the offsets the report keeps.
	const card = ( x, row, imageH ) => {
		const top = row * ( imageH + 159 );
		return [
			{ type: 'image', x, y: top, w: 289, h: imageH },
			words( x, top + imageH + 26, 199, 36, `name ${ x } ${ row }` ),
			words( x, top + imageH + 76, 141, 36, `role ${ x } ${ row }` ),
		];
	};
	const grid = ( imageH ) => [ 69, 407, 744, 1082 ].flatMap( ( x ) => [ ...card( x, 0, imageH ), ...card( x, 1, imageH ) ] );
	const w = analyseSection( { height: 953, boxes: grid( 290 ) }, { height: 762, boxes: grid( 193 ) }, { tolerance: 8, live: false, width: 1440 } );
	const section = wireframeSection( { status: 'fail', score: w.score, drift: w.drift, offsets: w.offsets, spacing: w.spacing, figmaHeight: 953, pageHeight: 762, heightDelta: -191 } );
	const defects = triageSection( section, null, DEFAULTS ).defects;
	const aspect = defects.filter( ( d ) => 'aspect' === d.issue );
	assert.ok( aspect.length, `an aspect defect names the cause, not just the height: ${ defects.map( ( d ) => d.issue ) }` );
	assert.deepEqual( aspect[ 0 ].ratio, { figma: 1, page: 1.5 } );
} );

test( 'a label and its asterisk, two Figma layers, pair with the page\'s one "Email *"', () => {
	const figma = [ words( 745, 352, 39, 27, 'Email' ), words( 786, 352, 6, 27, '*' ) ];
	const merged = mergeFigmaRuns( figma, [ words( 745, 352, 50, 27, 'Email *' ) ] );
	assert.deepEqual( merged.map( ( b ) => [ b.text, b.x, b.w ] ), [ [ 'email *', 745, 47 ] ] );
	assert.equal( mergeFigmaRuns( figma, [ words( 745, 352, 50, 27, 'Email' ) ] ).length, 2, 'nothing merges when the page has the parts' );
	assert.equal( mergeFigmaRuns( [ figma[ 0 ], { ...figma[ 1 ], x: 900 } ], [ words( 745, 352, 50, 27, 'Email *' ) ] ).length, 2, 'or when they are not side by side' );
	const a = analyse( figma, [ words( 745, 352, 50, 27, 'Email *' ) ] );
	assert.deepEqual( [ a.missing, a.extra, a.copy ], [ [], [], [] ] );
} );

test( 'text size is compared only between the same words', () => {
	const star = words( 810, 100, 6, 27, '*' );
	const label = words( 810, 100, 91, 27, 'Message *' );
	assert.deepEqual( analyse( [ star ], [ label ] ).offsets, [], 'a copy change, not a resize' );
	assert.equal( analyse( [ star ], [ { ...star, w: 30 } ] ).offsets.length, 1, 'the same text at another size is a resize' );
} );

test( 'a Figma frame behind an image is that image\'s border, not a missing element; hidden fills are not compared', () => {
	const img = { type: 'image', x: 68, y: 104, w: 628, h: 419 };
	const frame = { type: 'surface', x: 68, y: 104, w: 628, h: 419, style: { radius: '6', stroke: '#cccccc/1' } };
	// The page's corners come from a wrapper clipping the img (see extractPageBoxes): 4px, no border.
	const a = analyse( [ frame, { ...img, style: { radius: '6', stroke: 'none' } } ], [ { ...img, style: { radius: '4', stroke: 'none' } } ] );
	assert.deepEqual( a.missing, [], 'not a missing surface' );
	assert.deepEqual( a.styles.map( ( d ) => [ d.property, d.figma, d.page ] ), [ [ 'radius', '6', '4' ], [ 'stroke', '#cccccc/1', 'none' ] ], 'the frame\'s corners and border are the image\'s' );
	assert.deepEqual( analyse( [ frame, { ...img, style: { radius: '6', stroke: 'none' } } ], [ { ...img, style: { radius: '6', stroke: '#cccccc/1' } } ] ).styles, [], 'a page image with the same corners and border matches' );
	// A square frame around a rounded image: the image's own corners stand.
	const square = { ...frame, style: { radius: '0', stroke: '#cccccc/1' } };
	assert.deepEqual( analyse( [ square, { ...img, style: { radius: '8', stroke: 'none' } } ], [ { ...img, style: { radius: '8', stroke: '#cccccc/1' } } ] ).styles, [] );
	// A frame rounded 8px around a photo rounded 16px: the rounder corners show.
	assert.deepEqual( analyse( [ { ...frame, style: { radius: '8', stroke: 'none' } }, { ...img, style: { radius: '16', stroke: 'none' } } ], [ { ...img, style: { radius: '16', stroke: 'none' } } ] ).styles, [] );
	// A fill behind a bordered photo: the photo's own border stands.
	const backing = { ...frame, style: { fill: '#ffffff', radius: '0', stroke: 'none' } };
	const bordered = { ...img, style: { radius: '0', stroke: '#3d3d3d/2' } };
	assert.deepEqual( analyse( [ backing, bordered ], [ { ...bordered } ] ).styles, [] );
	assert.deepEqual( analyse( [ backing, bordered ], [ { ...img, style: { radius: '0', stroke: 'none' } } ] ).styles.map( ( d ) => d.property ), [ 'stroke' ] );
	const card = ( fill ) => ( { type: 'surface', x: 12, y: 0, w: 702, h: 500, style: { fill, radius: '6' } } );
	const photo = { type: 'image', x: 12, y: 0, w: 702, h: 500 };
	assert.deepEqual( analyse( [ card( '#000000' ), photo ], [ card( '#2c3f13' ), { ...photo } ] ).styles, [], 'a fill under a full-cover image on both sides can\'t be seen' );
	const pill = { type: 'surface', x: 600, y: 400, w: 52, h: 52, style: { fill: '#b0c890' } };
	assert.equal( analyse( [ pill ], [ { ...pill, style: { fill: '#c6e3a1' } } ] ).styles.length, 1, 'an uncovered fill still is' );
} );

test( 'no false border or corner defects: stored files, borders drawn another way, frames that may not clip', () => {
	const analyse = ( fig, pg ) => analyseSection( { height: 600, boxes: fig }, { height: 600, boxes: pg }, { tolerance: 8, live: false, width: 1440 } );
	const props = ( fig, pg ) => analyse( fig, pg ).styles.map( ( d ) => [ d.property, d.figma, d.page ] );
	const pill = { type: 'surface', x: 68, y: 100, w: 120, h: 40 };
	// A Figma file extracted before radii were fitted to the box records a pill as 999.
	assert.deepEqual( props( [ { ...pill, style: { radius: '999' } } ], [ { ...pill, style: { radius: '20', stroke: 'none' } } ] ), [], 'a pill is a pill' );
	assert.deepEqual( props( [ { ...pill, style: { radius: '999' } } ], [ { ...pill, style: { radius: '6', stroke: 'none' } } ] ), [ [ 'radius', '20', '6' ] ], 'reported as drawn' );
	// A border on one side only: the other may draw the same line another way (a divider element,
	// a ::after rule, a box-shadow ring), so that is not compared.
	const row = { type: 'surface', x: 68, y: 200, w: 600, h: 60 };
	assert.deepEqual( props( [ { ...row, style: { stroke: 'none' } } ], [ { ...row, style: { stroke: 'none none #cccccc/1 none' } } ] ), [] );
	assert.deepEqual( props( [ { ...row, style: { stroke: '#cccccc/1' } } ], [ { ...row, style: { stroke: 'none' } } ] ), [] );
	// A stored Figma file records a border's sides as one: which sides it has isn't known.
	assert.deepEqual( props( [ { ...row, style: { stroke: '#cccccc/1' } } ], [ { ...row, style: { stroke: 'none none #cccccc/1 none' } } ] ), [] );
	// Both sides bordered alike, or differently where both have one: compared side by side.
	assert.deepEqual( props( [ { ...row, style: { stroke: 'none none #cccccc/1 none' } } ], [ { ...row, style: { stroke: 'none none #3d3d3d/1 none' } } ] ).map( ( d ) => d[ 0 ] ), [ 'stroke' ] );
	// An image in a stored file carries no corners: a frame behind it may or may not clip it, so its
	// radius isn't guessed; its border, drawn over the photo either way, still is.
	const img = { type: 'image', x: 68, y: 104, w: 628, h: 419 };
	const frame = { type: 'surface', x: 68, y: 104, w: 628, h: 419, style: { radius: '6', stroke: '#cccccc/1' } };
	assert.deepEqual( props( [ frame, img ], [ { ...img, style: { radius: '4', stroke: 'none' } } ] ), [ [ 'stroke', '#cccccc/1', 'none' ] ] );
	assert.deepEqual( props( [ frame, img ], [ { ...img } ] ), [ [ 'stroke', '#cccccc/1', 'none' ] ], 'a page image without tokens has no border' );
	// A carousel's cut-off photo shows only part of its frame: not compared.
	const slide = { type: 'image', x: 1200, y: 104, w: 240, h: 419, clipped: true, style: { radius: '6', stroke: 'none' } };
	assert.deepEqual( props( [ { ...frame, x: 1200, w: 240, clipped: true }, slide ], [ { ...slide, style: { radius: '4', stroke: 'none' } } ] ), [] );
} );

test( 'Figma records every line a section draws; files from before record none', () => {
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	const grey = [ { type: 'SOLID', visible: true, color: { r: 0.8, g: 0.8, b: 0.8, a: 1 } } ];
	const shadow = ( radius ) => [ { type: 'DROP_SHADOW', visible: true, radius, spread: 1, offset: { x: 0, y: 0 }, color: { r: 0, g: 0, b: 0, a: 0.2 } } ];
	const frame = { type: 'FRAME', name: 'Page', absoluteBoundingBox: abs( 0, 0, 1440, 400 ), children: [ {
		type: 'FRAME', name: 'Rows / Desktop', absoluteBoundingBox: abs( 0, 0, 1440, 400 ), children: [
			{ type: 'LINE', name: 'Divider', absoluteBoundingBox: abs( 68, 59, 600, 0 ), strokes: grey, strokeWeight: 1 },
			{ type: 'RECTANGLE', name: 'Rule', absoluteBoundingBox: abs( 68, 119, 600, 1 ), fills: grey, strokes: [] },
			{ type: 'FRAME', name: 'Ringed', absoluteBoundingBox: abs( 68, 140, 600, 40 ), fills: [], strokes: [], effects: shadow( 0 ) },
			{ type: 'FRAME', name: 'Soft', absoluteBoundingBox: abs( 68, 200, 600, 40 ), fills: [], strokes: [], effects: shadow( 24 ) },
			{ type: 'FRAME', name: 'Underlined', absoluteBoundingBox: abs( 700, 140, 600, 40 ), fills: [], strokes: [], effects: [ { type: 'DROP_SHADOW', visible: true, radius: 0, spread: 0, offset: { x: 0, y: 2 }, color: { r: 0, g: 0, b: 0, a: 1 } } ] },
			{ type: 'FRAME', name: 'Far shadow', absoluteBoundingBox: abs( 700, 200, 600, 40 ), fills: [], strokes: [], effects: [ { type: 'DROP_SHADOW', visible: true, radius: 0, spread: 0, offset: { x: 0, y: 20 }, color: { r: 0, g: 0, b: 0, a: 1 } } ] },
			{ type: 'ELLIPSE', name: 'Ring', absoluteBoundingBox: abs( 700, 260, 40, 40 ), fills: [], strokes: grey, strokeWeight: 1 },
			{ type: 'VECTOR', name: 'Straight', absoluteBoundingBox: abs( 700, 380, 600, 0 ), fills: [], strokes: grey, strokeWeight: 1 },
			// A rule outside the mask above it is hidden: no line.
			{ type: 'GROUP', name: 'Masked rule', absoluteBoundingBox: abs( 700, 400, 600, 60 ), children: [
				{ type: 'RECTANGLE', name: 'Mask', isMask: true, absoluteBoundingBox: abs( 700, 400, 600, 20 ), fills: grey, strokes: [] },
				{ type: 'RECTANGLE', name: 'Hidden rule', absoluteBoundingBox: abs( 700, 459, 600, 1 ), fills: grey, strokes: [] },
			] },
			{ type: 'FRAME', name: 'Shrunk', absoluteBoundingBox: abs( 700, 480, 600, 40 ), fills: [], strokes: [], effects: [ { type: 'DROP_SHADOW', visible: true, radius: 0, spread: -20, offset: { x: 0, y: 2 }, color: { r: 0, g: 0, b: 0, a: 1 } } ] },
			{ type: 'GROUP', name: 'Masked', absoluteBoundingBox: abs( 700, 320, 600, 40 ), children: [
				{ type: 'RECTANGLE', name: 'Mask', isMask: true, absoluteBoundingBox: abs( 700, 320, 600, 40 ), fills: grey, strokes: grey, strokeWeight: 1 },
			] },
			// A fully transparent stroke draws nothing, nor does a divider its clipping frame hides.
			{ type: 'RECTANGLE', name: 'Clear', absoluteBoundingBox: abs( 68, 260, 600, 40 ), fills: [], strokes: [ { type: 'SOLID', visible: true, opacity: 0, color: { r: 0, g: 0, b: 0, a: 1 } } ], strokeWeight: 1 },
			{ type: 'FRAME', name: 'Clipper', clipsContent: true, absoluteBoundingBox: abs( 68, 320, 600, 40 ), fills: [], strokes: [], children: [
				{ type: 'RECTANGLE', name: 'Hidden rule', absoluteBoundingBox: abs( 68, 380, 600, 1 ), fills: grey, strokes: [] },
			] },
		],
	} ] };
	const figmaFile = path.join( fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-lines-' ) ), 'figma-boxes.txt' );
	fs.writeFileSync( figmaFile, extract( frame ) );
	const [ section ] = parseFigma( figmaFile, DEFAULT_CONFIG ).sections;
	const edge = ( y, h, side ) => drawsEdge( section.lines, { x: 68, y, w: 600, h }, side );
	assert.deepEqual( [ edge( 20, 40, 2 ), edge( 80, 40, 2 ), edge( 140, 40, 0 ) ], [ true, true, true ], 'a LINE, a thin rectangle, a tight shadow' );
	assert.equal( edge( 200, 40, 0 ), false, 'a soft shadow draws no line' );
	const at700 = ( side ) => drawsEdge( section.lines, { x: 700, y: 140, w: 600, h: 40 }, side );
	assert.deepEqual( [ 0, 1, 2, 3 ].map( at700 ), [ false, false, true, false ], 'a shadow offset down draws the bottom only' );
	const box = ( y, w = 600, h = 40 ) => [ 0, 1, 2, 3 ].some( ( side ) => drawsEdge( section.lines, { x: 700, y, w, h }, side ) );
	assert.deepEqual( [ box( 200 ), box( 260, 40, 40 ), box( 320 ) ], [ false, false, false ], 'a shadow 20px off, a circle\'s outline and a mask draw no box edge' );
	assert.ok( drawsEdge( section.lines, { x: 700, y: 340, w: 600, h: 40 }, 2 ), 'a straight vector line does' );
	assert.deepEqual( [ drawsEdge( section.lines, { x: 700, y: 420, w: 600, h: 40 }, 2 ), box( 480 ) ], [ false, false ], 'a rule a mask hides, and a shadow spread in 20px, draw nothing' );
	assert.equal( edge( 260, 40, 0 ), false, 'nor a transparent stroke' );
	assert.equal( edge( 340, 40, 2 ), false, 'nor a rule its clipping frame hides' );
	// A file from before lines were recorded: what it draws is unknown, not nothing.
	fs.writeFileSync( figmaFile, 'F|1440|400\nS|0|Rows / Desktop|0|400\n' );
	assert.equal( parseFigma( figmaFile, DEFAULT_CONFIG ).sections[ 0 ].lines, undefined );
} );

test( 'a Figma text\'s style is the one on most of its letters, from styled segments or REST overrides', () => {
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	const black = [ { type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } } ];
	const seg = ( characters, extra = {} ) => ( {
		characters, fontName: { family: 'Barlow', style: 'Regular' }, fontSize: 20, fontWeight: 400, fills: black,
		lineHeight: { unit: 'PIXELS', value: 30 }, letterSpacing: { unit: 'PIXELS', value: 0 }, textDecoration: 'NONE', textCase: 'ORIGINAL', ...extra,
	} );
	// The plugin API: styled segments.
	const plugin = ( name, y, segments ) => ( { type: 'TEXT', name, characters: segments.map( ( g ) => g.characters ).join( '' ), absoluteBoundingBox: abs( 68, y, 400, 30 ), getStyledTextSegments: () => segments } );
	// REST: a base style and per-character overrides.
	const rest = ( name, y, characters, overrides, table ) => ( { type: 'TEXT', name, characters, absoluteBoundingBox: abs( 68, y, 400, 30 ), fills: black,
		style: { fontFamily: 'Barlow', italic: false, fontWeight: 400, fontSize: 20, lineHeightPx: 30, letterSpacing: 0 }, characterStyleOverrides: overrides, styleOverrideTable: table } );
	const frame = { type: 'FRAME', name: 'Page', absoluteBoundingBox: abs( 0, 0, 1440, 400 ), children: [ { type: 'FRAME', name: 'Text / Desktop', absoluteBoundingBox: abs( 0, 0, 1440, 400 ), children: [
		plugin( 'Mostly', 0, [ seg( 'Built for ' ), seg( 'every', { fontWeight: 700, fontName: { family: 'Barlow', style: 'Bold' } } ), seg( ' property type' ) ] ),
		plugin( 'Halves', 40, [ seg( 'Half bold', { fontWeight: 700 } ), seg( ' half not' ) ] ),
		plugin( 'Eyebrow', 80, [ seg( 'how we work', { textCase: 'UPPER', letterSpacing: { unit: 'PERCENT', value: 10 } } ) ] ),
		plugin( 'Fancy', 120, [ seg( 'Emphasised link', { fontName: { family: 'Barlow', style: 'Bold Italic' }, textDecoration: 'UNDERLINE' } ) ] ),
		rest( 'Rest', 160, 'Plain words then two bold', [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1 ], { 1: { fontWeight: 700 } } ),
		plugin( 'Small caps', 200, [ seg( 'small caps', { textCase: 'SMALL_CAPS' } ) ] ),
		plugin( 'Split title', 240, [ seg( 'hel', { textCase: 'TITLE' } ), seg( 'lo world', { textCase: 'TITLE', fontWeight: 700 } ) ] ),
	] } ] };
	const styles = extract( frame ).split( '\n' ).filter( ( l ) => l.includes( '|text|' ) ).map( ( l ) => Object.fromEntries( l.split( '|' )[ 11 ].split( ';' ).map( ( kv ) => kv.split( '=' ) ) ) );
	const [ mostly, halves, eyebrow, fancy, restText, smallCaps, splitTitle ] = styles;
	assert.equal( splitTitle.case, 'title', 'title case across a run boundary inside a word' );
	assert.deepEqual( [ mostly.weight, mostly.case, mostly.runs ], [ '400', 'sentence', '1' ], 'one bold word of five' );
	assert.equal( halves.weight, undefined, 'no weight on most of the letters: none' );
	assert.deepEqual( [ eyebrow.case, eyebrow.ls ], [ 'upper', '2' ], 'textCase applied; 10% of 20px' );
	assert.deepEqual( [ fancy.italic, fancy.deco ], [ 'italic', 'underline' ] );
	assert.equal( restText.weight, '400', 'REST overrides, weighed by letters' );
	assert.equal( smallCaps.case, undefined, 'small caps render neither case' );
} );

test( 'page paragraphs merged into one Figma text weigh their letters together', () => {
	const para = ( y, words, weight, letters, textCase, rendered = words ) => ( { type: 'text', x: 68, y, w: 400, h: 24, text: words, full: words, hash: hash( words ),
		style: { weight, case: textCase }, style0: { weight }, tally: { weight: [ [ weight, letters ] ], letters, text: rendered } } );
	const joined = 'short bold lead a much longer paragraph in regular type';
	const fig = [ { type: 'text', x: 68, y: 0, w: 400, h: 60, hash: hash( joined ), text: joined.slice( 0, TEXT_PREFIX ), style: { weight: '400', case: 'mixed', runs: '1' } } ];
	const [ merged ] = mergeTextRuns( fig, [ para( 0, 'short bold lead', '700', 13, 'sentence', 'Short bold lead' ), para( 30, 'a much longer paragraph in regular type', '400', 33, 'sentence', 'A much longer paragraph in regular type' ) ] );
	assert.deepEqual( [ merged.style.weight, merged.style.case ], [ '400', 'mixed' ], '33 of 46 letters are regular; two sentences read as mixed' );
	// "Hello" (title) then "world here" (lower) read together as one sentence.
	const two = 'hello world here';
	const [ sentence ] = mergeTextRuns( [ { ...fig[ 0 ], hash: hash( two ), text: two } ], [ para( 0, 'hello', '400', 5, 'title', 'Hello' ), para( 30, 'world here', '400', 9, 'lower', 'world here' ) ] );
	assert.equal( sentence.style.case, 'sentence' );
} );

test( 'text tokens compare as drawn: spacing within 0.3px, fonts by name, and older Figma files by their first character', () => {
	assert.ok( sameToken( 'ls', '1.6', '1.8' ) && ! sameToken( 'ls', '1.6', '2' ) );
	assert.ok( sameToken( 'font', 'Inter Variable', 'Inter' ) && sameToken( 'font', 'Barlow Condensed', 'barlow condensed' ) && ! sameToken( 'font', 'Barlow', 'Barlow Condensed' ) );
	assert.ok( sameToken( 'case', 'upper', 'upper' ) && ! sameToken( 'case', 'upper', 'sentence' ) );
	const text = ( style ) => ( { type: 'text', x: 68, y: 0, w: 300, h: 30, hash: 'h', text: 'built for every', style } );
	const page = { ...text( { weight: '400', case: 'upper', ls: '0' } ), style0: { weight: '700' } };
	const diffs = ( fig ) => styleDiffs( [ { f: text( fig ), p: page } ] ).map( ( d ) => [ d.property, d.figma, d.page ] );
	assert.deepEqual( diffs( { weight: '400', case: 'sentence', ls: '0', runs: '1' } ), [ [ 'case', 'sentence', 'upper' ] ], 'from runs: the page\'s runs' );
	assert.deepEqual( diffs( { weight: '700' } ), [], 'a file from before: the page\'s first character' );
	// A live section's text styles likewise.
	assert.deepEqual( missingTextStyles( [ text( { font: 'Barlow', size: '17', weight: '700' } ) ], [ { ...page, style: { font: 'Barlow', size: '17', weight: '400' }, style0: { font: 'Barlow', size: '17', weight: '700' } } ] ), [] );
	assert.equal( missingTextStyles( [ text( { font: 'Barlow', size: '17', weight: '700', runs: '1' } ) ], [ { ...page, style: { font: 'Barlow', size: '17', weight: '400' }, style0: { font: 'Barlow', size: '17', weight: '700' } } ] ).length, 1 );
} );

test( 'a border only one side has counts only where the other draws no line along that edge', () => {
	const row = { type: 'surface', x: 68, y: 200, w: 600, h: 60 };
	const diffs = ( fs, ps, lines ) => styleDiffs( [ { f: { ...row, style: { stroke: fs } }, p: { ...row, style: { stroke: ps } } } ], () => false, { lines } ).map( ( d ) => [ d.figma, d.page ] );
	const rule = ( y ) => ( { x: 68, y, w: 600, h: 1 } );
	// Figma's divider along the top, nothing on the page: a missing border.
	assert.deepEqual( diffs( '#e0e0e0/1 none none none', 'none', { figma: [ rule( 200 ) ], page: [] } ), [ [ '#e0e0e0/1 none none none', 'none' ] ] );
	// The page draws it another way (a ::after rule, the element above's border): not missing.
	assert.deepEqual( diffs( '#e0e0e0/1 none none none', 'none', { figma: [ rule( 200 ) ], page: [ rule( 199 ) ] } ), [] );
	assert.deepEqual( diffs( '#e0e0e0/1 none none none', 'none', { figma: [], page: [ { x: 68, y: 199, w: 200, h: 1 } ] } ).length, 1, 'a line along a third of the edge isn\'t it' );
	assert.deepEqual( diffs( '#e0e0e0/1 none none none', 'none', { figma: [], page: [ rule( 230 ) ] } ).length, 1, 'nor one across the middle' );
	// And the other way: a page border Figma draws as a separate line isn't extra.
	assert.deepEqual( diffs( 'none', 'none none #cccccc/1 none', { figma: [ rule( 259 ) ], page: [] } ), [] );
	assert.deepEqual( diffs( 'none', 'none none #cccccc/1 none', { figma: [], page: [] } ).length, 1 );
	// Without one side's lines it can't be told.
	assert.deepEqual( diffs( '#e0e0e0/1 none none none', 'none', { figma: [], page: undefined } ), [] );
} );

test( 'an element cut off on either side is not compared by size or shape', () => {
	const card = { type: 'image', x: 1358, y: 0, w: 408, h: 272 };
	// Figma's frame ends at 1440 and the page's slider clips the card to its visible 51px.
	assert.deepEqual( analyse( [ card ], [ { type: 'image', x: 1389, y: 0, w: 51, h: 281, clipped: true } ] ).offsets, [] );
	assert.deepEqual( analyse( [ { ...card, x: 928 } ], [ { type: 'image', x: 949, y: 0, w: 51, h: 281 } ] ).offsets.length, 1, 'a whole element still is' );
	// Nor by style: a clipped fragment may pair with another element's fragment.
	const panel = { type: 'surface', x: 1358, y: 272, w: 82, h: 196, clipped: true, style: { radius: '0' } };
	assert.deepEqual( analyse( [ panel ], [ { type: 'surface', x: 1388, y: 0, w: 52, h: 555, clipped: true, style: { radius: '4' } } ] ).styles, [] );
} );

test( 'corners and sides that differ are named when a token is read out', () => {
	assert.equal( tokenValue( 'radius', '8 8 0 0' ), 'top-left 8px, top-right 8px, bottom-right 0px, bottom-left 0px' );
	assert.equal( tokenValue( 'stroke', 'none none #cccccc/1 none' ), 'top none, right none, bottom #cccccc/1, left none' );
	assert.deepEqual( [ tokenValue( 'radius', '6' ), tokenValue( 'stroke', 'none' ), tokenValue( 'size', '16' ) ], [ '6px', 'none', '16px' ] );
} );

test( 'Figma corners and borders are read per corner and side, and an image takes its clipping frame\'s corners', () => {
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	const grey = [ { type: 'SOLID', visible: true, color: { r: 0.8, g: 0.8, b: 0.8, a: 1 } } ];
	const white = [ { type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 } } ];
	const photo = [ { type: 'IMAGE', visible: true } ];
	const frame = {
		type: 'FRAME', name: 'Page', absoluteBoundingBox: abs( 0, 0, 1440, 600 ),
		children: [ {
			type: 'FRAME', name: 'Cards / Desktop', absoluteBoundingBox: abs( 0, 0, 1440, 600 ),
			children: [
				// REST: corners that differ come as rectangleCornerRadii, sides as individualStrokeWeights.
				{ type: 'RECTANGLE', name: 'Tab', absoluteBoundingBox: abs( 68, 10, 200, 40 ), fills: white, strokes: grey, strokeWeight: 1, individualStrokeWeights: { top: 0, right: 0, bottom: 1, left: 0 }, cornerRadius: 8, rectangleCornerRadii: [ 8, 8, 0, 0 ] },
				// One corner as large as it fits: radii shrink only when neighbours together overrun a side.
				{ type: 'RECTANGLE', name: 'Corner', absoluteBoundingBox: abs( 1200, 10, 100, 100 ), fills: white, strokes: [], cornerRadius: 0, rectangleCornerRadii: [ 80, 0, 0, 0 ] },
				// A pill: a radius past half the box draws as half the box.
				{ type: 'RECTANGLE', name: 'Pill', absoluteBoundingBox: abs( 300, 10, 120, 40 ), fills: white, strokes: [], cornerRadius: 999 },
				// The plugin API: figma.mixed (not a number) for a stroke that differs by side.
				{ type: 'RECTANGLE', name: 'Rule', absoluteBoundingBox: abs( 500, 10, 200, 40 ), fills: white, strokes: grey, strokeWeight: Symbol( 'mixed' ), strokeTopWeight: 2, strokeRightWeight: 0, strokeBottomWeight: 0, strokeLeftWeight: 0, cornerRadius: 0 },
				// A square photo in a rounded frame that clips it, at the same box, through a square one.
				{ type: 'FRAME', name: 'Media', absoluteBoundingBox: abs( 68, 100, 628, 419 ), clipsContent: true, fills: [], strokes: [], cornerRadius: 6, children: [
					{ type: 'FRAME', name: 'Inner', absoluteBoundingBox: abs( 68, 100, 628, 419 ), clipsContent: true, fills: [], strokes: [], cornerRadius: 0, children: [
						{ type: 'RECTANGLE', name: 'Photo', absoluteBoundingBox: abs( 68, 100, 628, 419 ), fills: photo, strokes: [], cornerRadius: 0 },
					] },
				] },
				// An avatar: a photo fill on an ellipse, and a photo masked by an ellipse.
				{ type: 'ELLIPSE', name: 'Avatar', absoluteBoundingBox: abs( 68, 560, 48, 48 ), fills: photo, strokes: [] },
				{ type: 'GROUP', name: 'Masked', absoluteBoundingBox: abs( 200, 560, 48, 48 ), children: [
					{ type: 'ELLIPSE', name: 'Mask', isMask: true, absoluteBoundingBox: abs( 200, 560, 48, 48 ), fills: white, strokes: [] },
					{ type: 'RECTANGLE', name: 'Photo', absoluteBoundingBox: abs( 200, 560, 48, 48 ), fills: photo, strokes: [], cornerRadius: 0 },
				] },
				// An oval photo has no one radius; a hidden mask clips nothing; a later mask replaces an earlier one.
				{ type: 'ELLIPSE', name: 'Oval', absoluteBoundingBox: abs( 300, 560, 80, 48 ), fills: photo, strokes: [] },
				{ type: 'GROUP', name: 'Hidden mask', absoluteBoundingBox: abs( 1000, 560, 48, 48 ), children: [
					{ type: 'ELLIPSE', name: 'Mask', isMask: true, visible: false, absoluteBoundingBox: abs( 1000, 560, 48, 48 ), fills: white, strokes: [] },
					{ type: 'RECTANGLE', name: 'Photo', absoluteBoundingBox: abs( 1000, 560, 48, 48 ), fills: photo, strokes: [], cornerRadius: 0 },
				] },
				{ type: 'GROUP', name: 'Two masks', absoluteBoundingBox: abs( 1100, 560, 48, 48 ), children: [
					{ type: 'ELLIPSE', name: 'Round mask', isMask: true, absoluteBoundingBox: abs( 1100, 560, 48, 48 ), fills: white, strokes: [] },
					{ type: 'RECTANGLE', name: 'Square mask', isMask: true, absoluteBoundingBox: abs( 1100, 560, 48, 48 ), fills: white, strokes: [], cornerRadius: 0 },
					{ type: 'RECTANGLE', name: 'Photo', absoluteBoundingBox: abs( 1100, 560, 48, 48 ), fills: photo, strokes: [], cornerRadius: 0 },
				] },
				// A card that clips a photo along its top: the card's top corners round it.
				{ type: 'FRAME', name: 'Card', absoluteBoundingBox: abs( 400, 560, 300, 30 ), clipsContent: true, fills: white, strokes: [], cornerRadius: 8, children: [
					{ type: 'RECTANGLE', name: 'Photo', absoluteBoundingBox: abs( 400, 560, 300, 20 ), fills: photo, strokes: [], cornerRadius: 0 },
				] },
				// A photo rounded 4px in a frame rounded 20px: the frame's clip is what shows.
				{ type: 'FRAME', name: 'Round', absoluteBoundingBox: abs( 800, 100, 300, 200 ), clipsContent: true, fills: [], strokes: [], cornerRadius: 20, children: [
					{ type: 'RECTANGLE', name: 'Photo', absoluteBoundingBox: abs( 800, 100, 300, 200 ), fills: photo, strokes: [], cornerRadius: 4 },
				] },
			],
		} ],
	};
	const boxes = extract( frame ).split( '\n' ).filter( ( l ) => l.startsWith( 'B|' ) );
	const style = ( x ) => boxes.find( ( l ) => l.split( '|' )[ 3 ] === String( x ) ).split( '|' )[ 11 ];
	assert.equal( style( 68 ).split( ';' ).find( ( t ) => t.startsWith( 'radius' ) ), 'radius=8 8 0 0' );
	assert.match( style( 68 ), /stroke=none none #cccccc\/1 none/ );
	assert.match( style( 300 ), /radius=20;stroke=none/ );
	assert.match( style( 1200 ), /radius=80 0 0 0;/ );
	assert.match( style( 500 ), /stroke=#cccccc\/2 none none none/ );
	const images = boxes.filter( ( l ) => l.includes( '|image|' ) );
	const at = ( x ) => images.find( ( l ) => l.split( '|' )[ 3 ] === String( x ) ).split( '|' )[ 11 ];
	assert.equal( at( 300 ), 'stroke=none', 'an oval has no one radius' );
	assert.equal( at( 1000 ), 'radius=0;stroke=none', 'a hidden mask clips nothing' );
	assert.equal( at( 1100 ), 'radius=0;stroke=none', 'the later mask replaces the earlier one' );
	const [ image, avatar, masked, , , , top, round ] = images;
	assert.equal( avatar.split( '|' )[ 11 ], 'radius=24;stroke=none', 'an ellipse with a photo fill is a circle' );
	assert.equal( masked.split( '|' )[ 11 ], 'radius=24;stroke=none', 'a photo masked by an ellipse is one too' );
	assert.equal( top.split( '|' )[ 11 ], 'radius=8 8 0 0;stroke=none', 'a card rounds the corners it shares with the photo' );
	assert.equal( image.split( '|' )[ 11 ], 'radius=6;stroke=none', 'the rounded frame\'s corners, through a square one' );
	assert.equal( round.split( '|' )[ 11 ], 'radius=20;stroke=none', 'the roundest clip shows' );
} );

test( 'a frame that clips its content hides what lies outside it, in Figma as on the page', () => {
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	const quote = ( name, x ) => ( { type: 'TEXT', name, characters: name, absoluteBoundingBox: abs( x, 160, 1080, 72 ) } );
	// A testimonial carousel: slides side by side in a track that shows 180..1260 only.
	const frame = { type: 'FRAME', name: 'Page', absoluteBoundingBox: abs( 0, 0, 1440, 474 ), children: [ {
		type: 'INSTANCE', name: 'Testimonial Slider / Desktop', clipsContent: true, absoluteBoundingBox: abs( 0, 0, 1440, 474 ), children: [
			{ type: 'FRAME', name: 'Slides', clipsContent: true, absoluteBoundingBox: abs( 180, 160, 1080, 240 ), children: [ quote( 'Current slide', 180 ), quote( 'Next slide', 1260 ) ] },
			// Half outside the track.
			{ type: 'FRAME', name: 'Peek', clipsContent: true, absoluteBoundingBox: abs( 1100, 300, 200, 40 ), children: [ { type: 'RECTANGLE', name: 'Card', fills: [ { type: 'SOLID', color: { r: 1, g: 1, b: 1 } } ], absoluteBoundingBox: abs( 1200, 300, 200, 40 ) } ] },
		],
	} ] };
	const lines = extract( frame ).split( '\n' ).filter( ( l ) => l.startsWith( 'B|' ) );
	assert.deepEqual( lines.map( ( l ) => l.split( '|' )[ 8 ] ), [ 'current slide', '' ], 'the next slide is hidden by the track' );
	const card = lines[ 1 ].split( '|' );
	assert.deepEqual( [ card[ 2 ], card[ 3 ], card[ 5 ], card[ 12 ] ], [ 'surface', '1200', '100', '1' ], 'the card keeps its visible 100px and is marked cut off' );
	const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-clip-' ) );
	fs.writeFileSync( path.join( dir, 'f.txt' ), extract( frame ) );
	const { sections } = parseFigma( path.join( dir, 'f.txt' ), DEFAULT_CONFIG );
	assert.deepEqual( sections[ 0 ].boxes.map( ( b ) => Boolean( b.clipped ) ), [ false, true ] );
	fs.rmSync( dir, { recursive: true } );
} );

// Spacing: the visible space, however each side builds it.
const spaces = ( fig, pg, opts ) => analyse( fig, pg, opts ).spacing.map( ( d ) => [ d.where, d.side ?? d.axis, d.figma, d.page ] );

test( 'the space between stacked neighbours is compared, and says which margins are in it', () => {
	const quote = words( 180, 160, 1080, 72, 'A quote from a client' );
	const name = words( 180, 264, 200, 27, 'Jane Smith' );
	// The page's quote keeps a 26px margin-bottom the design doesn't have.
	const a = analyse( [ quote, name ], [ { ...quote, mb: 26 }, { ...name, y: 290 } ], { ph: 426 } );
	const between = a.spacing.filter( ( d ) => 'between' === d.where );
	assert.deepEqual( between.map( ( d ) => [ d.axis, d.figma, d.page, d.margins.page.from ] ), [ [ 'vertical', 32, 58, 26 ] ] );
	assert.equal( between[ 0 ].from.text, quote.text );
	assert.deepEqual( between[ 0 ].area.page, { x: 180, y: 232, w: 200, h: 58 }, 'the space itself, for the report to highlight' );
} );

test( 'the same space built another way is not a difference', () => {
	const heading = words( 68, 104, 600, 67, 'Built for Every Property Type' );
	const intro = words( 68, 191, 600, 54, 'Intro copy' );
	// Figma: a 20px Text Block padding under the heading. Page: a 20px margin-top on the intro,
	// or a flex gap (no margins): the same 20px either way.
	const figma = [ { ...heading, mb: 20 }, intro ];
	assert.deepEqual( spaces( figma, [ { ...heading }, { ...intro, mt: 20 } ] ).filter( ( [ w ] ) => 'between' === w ), [] );
	assert.deepEqual( spaces( figma, [ { ...heading }, { ...intro } ] ).filter( ( [ w ] ) => 'between' === w ), [] );
} );

test( 'side-by-side neighbours and every column are compared', () => {
	const cards = [ 68, 516, 964 ].map( ( x ) => ( { type: 'image', x, y: 104, w: 408, h: 272 } ) );
	// The page's columns are 24px apart instead of 40: both gaps.
	const page = [ 68, 500, 932 ].map( ( x ) => ( { type: 'image', x, y: 104, w: 408, h: 272 } ) );
	const between = spaces( cards, page ).filter( ( [ w ] ) => 'between' === w );
	assert.deepEqual( between, [ [ 'between', 'horizontal', 40, 24 ], [ 'between', 'horizontal', 40, 24 ] ] );
	// Captions under each: each column's image-to-caption space is its own neighbour pair.
	const caption = ( x, y ) => words( x, y, 300, 27, `Caption ${ x }` );
	const figma = [ ...cards, ...cards.map( ( c ) => caption( c.x, 396 ) ) ];
	const pg = [ ...cards.map( ( c ) => ( { ...c } ) ), ...cards.map( ( c, i ) => ( { ...caption( c.x, 0 === i ? 420 : 396 ), text: caption( c.x, 0 ).text } ) ) ];
	assert.deepEqual( spaces( figma, pg ).filter( ( [ w ] ) => 'between' === w ), [ [ 'between', 'vertical', 20, 44 ] ], 'only the first column differs' );
} );

test( 'a space with something else in it, on either side, is not a space between neighbours', () => {
	const title = words( 68, 104, 600, 40, 'Title' );
	const body = words( 68, 200, 600, 40, 'Body' );
	const icon = { type: 'icon', x: 68, y: 160, w: 24, h: 24 };
	// The page has no icon between them: the 56px vs 96px is the icon, reported as missing.
	const a = analyse( [ title, icon, body ], [ { ...title }, { ...body } ] );
	assert.deepEqual( a.spacing.filter( ( d ) => 'between' === d.where && d.to.text === body.text && d.from.text === title.text ), [] );
	assert.equal( a.missing.length, 1 );
	// A card behind both holds them; it isn't between them.
	const card = { type: 'surface', x: 40, y: 80, w: 660, h: 200, style: {} };
	assert.deepEqual( spaces( [ card, title, body ], [ { ...card }, { ...title }, { ...body, y: 230 } ] ).filter( ( [ w ] ) => 'between' === w ), [ [ 'between', 'vertical', 56, 86 ] ] );
} );

test( 'elements rearranged on the page are not measured as neighbours', () => {
	const title = words( 68, 104, 600, 40, 'Title' );
	const body = words( 68, 164, 600, 40, 'Body' );
	// Stacked in Figma, side by side on the page: a layout change, not a 20px gap become -60px.
	assert.deepEqual( spaces( [ title, body ], [ { ...title }, { ...body, x: 700, y: 104 } ] ).filter( ( [ w ] ) => 'between' === w ), [] );
	// Or moved down and aside, still following but no longer overlapping.
	assert.deepEqual( spaces( [ title, body ], [ { ...title }, { ...body, x: 700, y: 180 } ] ).filter( ( [ w ] ) => 'between' === w ), [] );
	// Or in the other order: not a 20px gap become -100px.
	assert.deepEqual( spaces( [ title, body ], [ { ...title, y: 164 }, { ...body, y: 104 } ] ).filter( ( [ w ] ) => 'between' === w ), [] );
} );

test( 'the space to an element runs to what holds it, once', () => {
	const text = words( 68, 104, 300, 54, 'Card text' );
	const circle = { type: 'surface', x: 68, y: 250, w: 85, h: 85, style: {} };
	const icon = { type: 'icon', x: 86, y: 268, w: 50, h: 50 };
	// The page's next row starts 26px higher: one space (to the circle), not one to the icon too.
	const between = analyse( [ text, circle, icon ], [ { ...text }, { ...circle, y: 224 }, { ...icon, y: 242 } ] ).spacing.filter( ( d ) => 'between' === d.where );
	assert.deepEqual( between.map( ( d ) => [ d.to.type, d.figma, d.page ] ), [ [ 'surface', 92, 66 ] ] );
} );

test( 'the space inside an element, from its edges to the content nearest them, is compared', () => {
	const card = { type: 'surface', x: 68, y: 104, w: 408, h: 300, style: {} };
	const title = words( 108, 144, 328, 36, 'Card title' );
	const text = words( 108, 200, 328, 54, 'Card text' );
	// The page's card has 24px padding at the top and left instead of 40 (and is 16px smaller,
	// so its right and bottom padding stay).
	const pg = [ { ...card, w: 392, h: 284 }, { ...title, x: 92, y: 128 }, { ...text, x: 92, y: 184 } ];
	const inside = spaces( [ card, title, text ], pg ).filter( ( [ w ] ) => 'inside' === w );
	assert.deepEqual( inside, [ [ 'inside', 'top', 40, 24 ], [ 'inside', 'left', 40, 24 ] ] );
	assert.deepEqual( spaces( [ card, title, text ], [ { ...card }, { ...title }, { ...text } ] ).filter( ( [ w ] ) => 'inside' === w ), [], 'the same padding: nothing' );
} );

test( 'the space to a section\'s edge is one defect, with the padding and margin in it on each side', () => {
	const heading = words( 68, 104, 600, 67, 'Built for Every Property Type' );
	// Figma: 72px section padding under the heading's 20px Text Block padding. Page: the margin
	// is gone, the padding is 73px: 92px vs 73px to the section's bottom.
	const [ edge ] = analyse( [ { ...heading, mb: 20 } ], [ { ...heading } ], { fh: 263, ph: 244 } ).spacing.filter( ( d ) => 'bottom' === d.side );
	assert.deepEqual( [ edge.where, edge.figma, edge.page, edge.margins.figma.from, edge.margins.page.from ], [ 'edge', 92, 73, 20, 0 ] );
	// The theme dropping the last margin but padding to the same visible 92px: nothing.
	assert.deepEqual( spaces( [ { ...heading, mb: 20 } ], [ { ...heading } ], { fh: 263, ph: 263 } ).filter( ( [ , side ] ) => 'bottom' === side ), [] );
	// A background covering the section isn't content; the space runs to the text.
	const bg = { type: 'image', x: 0, y: 0, w: 1440, h: 263 };
	assert.deepEqual( spaces( [ bg, heading ], [ { ...bg }, { ...heading, y: 80 } ], { fh: 263, ph: 263 } ).filter( ( [ w, side ] ) => 'edge' === w && 'top' === side ), [ [ 'edge', 'top', 104, 80 ] ] );
} );

test( 'a space is compared at an edge only when the same element is nearest it on both sides', () => {
	const caption = words( 68, 541, 421, 45, 'Caption' );
	const arrow = { type: 'surface', x: 574, y: 600, w: 52, h: 52, style: {} };
	// The design's lowest element (a slider arrow) isn't on the page: the space is the content.
	const a = analyse( [ caption, arrow ], [ { ...caption } ], { fh: 752, ph: 690 } );
	assert.ok( ! a.spacing.some( ( d ) => 'bottom' === d.side ) );
	assert.equal( a.missing.length, 1, 'the arrow itself is still reported' );
	assert.deepEqual( spaces( [ caption ], [ { ...caption } ], { fh: 690, ph: 658 } ).filter( ( [ , side ] ) => 'bottom' === side ), [ [ 'edge', 'bottom', 104, 72 ] ] );
	// In Figma the button (right column) is lowest; on the page the caption (left column) is.
	const button = { type: 'surface', x: 744, y: 539, w: 160, h: 60, style: {} };
	assert.ok( ! analyse( [ caption, button ], [ { ...caption, y: 540 }, { ...button, y: 500 } ], { fh: 727, ph: 689 } ).spacing.some( ( d ) => 'edge' === d.where && 'bottom' === d.side ) );
	// Two columns level at the top: either can stand for the edge.
	const left = words( 68, 104, 500, 40, 'Left' );
	const right = words( 800, 104, 500, 40, 'Right' );
	assert.deepEqual( spaces( [ left, right ], [ { ...left, y: 80.5 }, { ...right, y: 80 } ] ).filter( ( [ w, side ] ) => 'edge' === w && 'top' === side ), [ [ 'edge', 'top', 104, 81 ] ] );
	// An image's frame (a border around it) is its image: the edge is still the same element.
	const img = { type: 'image', x: 68, y: 104, w: 628, h: 419 };
	const frame = { type: 'surface', x: 66, y: 102, w: 632, h: 423, style: { stroke: '#cccccc/2' } };
	assert.deepEqual( spaces( [ frame, img, caption ], [ { ...img, y: 72 }, { ...caption, y: 509 } ], { fh: 727, ph: 695 } ).filter( ( [ , side ] ) => 'top' === side ), [ [ 'edge', 'top', 102, 72 ] ] );
} );

test( 'spaces are compared only between the same words, and never to a cut-off element', () => {
	const a = words( 68, 104, 600, 40, 'Heading' );
	const b = words( 68, 164, 600, 40, 'Some text' );
	assert.deepEqual( spaces( [ a, b ], [ { ...a }, { ...words( 68, 200, 600, 40, 'Other text' ) } ] ).filter( ( [ w ] ) => 'between' === w ), [], 'different words may be another element' );
	const slide = { type: 'image', x: 1358, y: 104, w: 82, h: 272, clipped: true };
	const card = { type: 'image', x: 900, y: 104, w: 408, h: 272 };
	assert.deepEqual( spaces( [ card, slide ], [ { ...card }, { ...slide, x: 1380, w: 60 } ] ).filter( ( [ w ] ) => 'between' === w ), [] );
} );

test( 'a page space that changes with the viewport\'s height is not compared', () => {
	const image = { type: 'image', x: 68, y: 155, w: 584, h: 389 };
	const caption = words( 68, 600, 584, 27, 'Caption' );
	// A 100vh slide centres its image and caption: 155px from the top in Figma, 311px on the
	// page at one viewport, 461px at a taller one. The caption sits 30px lower than designed,
	// at either viewport.
	const at = ( b, y, alt ) => ( { ...b, y, alt: { x: b.x, y: alt, w: b.w, h: b.h } } );
	const page = { height: 1212, altHeight: 1512, boxes: [ at( image, 311, 461 ), at( caption, 786, 936 ) ] };
	const a = analyseSection( { height: 1000, boxes: [ image, caption ] }, page, { tolerance: 8, live: false, width: 1440 } );
	assert.deepEqual( a.spacing.map( ( d ) => [ d.where, d.side ?? d.axis, d.figma, d.page ] ), [ [ 'between', 'vertical', 56, 86 ] ], 'the edges move with the viewport; the space between image and caption does not' );
	const fixed = { ...page, altHeight: undefined, boxes: page.boxes.map( ( { alt, ...b } ) => b ) };
	assert.ok( analyseSection( { height: 1000, boxes: [ image, caption ] }, fixed, { tolerance: 8, live: false, width: 1440 } ).spacing.some( ( d ) => 'edge' === d.where ), 'measured once, the edges are compared' );
} );

test( 'the tolerance scales with the space: a quarter of it, at least 4px, at most the tolerance', () => {
	assert.deepEqual( [ 0, 8, 16, 24, 32, 104 ].map( ( s ) => spacingTolerance( s, 8 ) ), [ 4, 4, 4, 6, 8, 8 ] );
	assert.equal( spacingTolerance( 104, 2 ), 2, 'never looser than the tolerance asked for' );
	const icon = { type: 'icon', x: 68, y: 104, w: 24, h: 24 };
	const label = words( 100, 104, 80, 24, 'Label' );
	// 8px apart in Figma: 5px more on the page is flagged, 4px isn't.
	assert.deepEqual( spaces( [ icon, label ], [ { ...icon }, { ...label, x: 105 } ] ).filter( ( [ w ] ) => 'between' === w ), [ [ 'between', 'horizontal', 8, 13 ] ] );
	assert.deepEqual( spaces( [ icon, label ], [ { ...icon }, { ...label, x: 104 } ] ).filter( ( [ w ] ) => 'between' === w ), [] );
	// 104px of padding: 8px off isn't, 9px is.
	const text = words( 68, 104, 600, 40, 'Text' );
	assert.deepEqual( spaces( [ text ], [ { ...text, y: 96 } ] ).filter( ( [ , side ] ) => 'top' === side ), [] );
	assert.deepEqual( spaces( [ text ], [ { ...text, y: 95 } ] ).filter( ( [ , side ] ) => 'top' === side ), [ [ 'edge', 'top', 104, 95 ] ] );
} );

test( 'a Figma render padded to a minimum width keeps its scale', () => {
	// A 375px mobile frame comes back 648px wide, full height: blank canvas beside the frame.
	assert.equal( renderScale( { width: 648, height: 8500 }, { width: 375, height: 8500 } ), 1 );
	assert.equal( renderScale( { width: 2880, height: 13552 }, { width: 1440, height: 6776 } ), 2, 'a 2x render' );
	assert.equal( renderScale( { width: 1440, height: 6777 }, { width: 1440, height: 6776 } ), 1, 'rounding in the height' );
} );

// Text alignment and wrapped text's uneven edges.
const para = ( x, y, w, lines, t, align = 'left' ) => words( x, y, w, lines * 25.6, t, { style: { size: '16', lh: '25.6', align } } );

test( 'text alignment is read from Figma, via REST and the plugin API', () => {
	const abs = ( x, y, width, height ) => ( { x, y, width, height } );
	const text = ( extra ) => ( { type: 'TEXT', name: 'T', characters: 'Centred', absoluteBoundingBox: abs( 0, 0, 100, 20 ), ...extra } );
	const frame = ( t ) => ( { type: 'FRAME', name: 'Page', absoluteBoundingBox: abs( 0, 0, 375, 100 ), children: [ { type: 'FRAME', name: 'Intro / Mobile', absoluteBoundingBox: abs( 0, 0, 375, 100 ), children: [ t ] } ] } );
	const align = ( t ) => extract( frame( t ) ).split( '\n' ).find( ( l ) => l.includes( '|text|' ) ).match( /align=(\w+)/ )?.[ 1 ];
	assert.equal( align( text( { style: { textAlignHorizontal: 'CENTER' } } ) ), 'center', 'REST' );
	assert.equal( align( text( { textAlignHorizontal: 'JUSTIFIED' } ) ), 'justify', 'plugin API' );
} );

test( 'a section\'s background image holds no spaces of its own: the space inside it is the edge\'s', () => {
	const hero = { type: 'image', x: 0, y: 0, w: 375, h: 720 };
	const label = words( 21, 153, 237, 19, 'DFW Commercial Landscaping' );
	const s = spaces( [ hero, label ], [ { ...hero, h: 700 }, { ...label, y: 140 } ], { fh: 720, ph: 700, width: 375 } ).filter( ( [ , side ] ) => 'top' === side );
	assert.deepEqual( s, [ [ 'edge', 'top', 153, 140 ] ], 'once, at the edge' );
	// A card's image, not the section's background, still holds its own.
	const card = { type: 'image', x: 12, y: 0, w: 351, h: 320 };
	const title = words( 33, 140, 160, 68, 'Construction Services' );
	assert.deepEqual( spaces( [ card, title ], [ { ...card }, { ...title, y: 129 } ], { fh: 996, ph: 996, width: 375 } ).filter( ( [ w, side ] ) => 'inside' === w && 'top' === side ), [ [ 'inside', 'top', 140, 129 ] ] );
} );

test( 'wrapped text\'s uneven side is not an edge: no space measured from it', () => {
	const arrow = { type: 'surface', x: 303, y: 260, w: 40, h: 40, style: {} };
	// A left-aligned paragraph over three lines beside an arrow: its right side is where lines
	// happened to end (248px wide in Figma, 237 on the page), not a layout edge.
	const text = para( 33, 222, 248, 3, 'Landscape, irrigation, hardscape and more' );
	assert.deepEqual( spaces( [ text, arrow ], [ { ...text, w: 237 }, { ...arrow } ] ).filter( ( [ w ] ) => 'between' === w ), [] );
	// One line: its end is where the words end, the same words on both sides.
	const line = para( 33, 260, 200, 1, 'Learn more' );
	assert.deepEqual( spaces( [ line, arrow ], [ { ...line }, { ...arrow, x: 283 } ] ).filter( ( [ w ] ) => 'between' === w ), [ [ 'between', 'horizontal', 70, 50 ] ] );
	// Its left side is a real edge: a card's left padding is still compared.
	const card = { type: 'surface', x: 12, y: 200, w: 351, h: 320, style: {} };
	const inset = spaces( [ card, text ], [ { ...card }, { ...text, x: 44 } ] ).filter( ( [ w ] ) => 'inside' === w );
	assert.ok( inset.some( ( [ , side, f, p ] ) => 'left' === side && 21 === f && 32 === p ) );
	assert.ok( ! inset.some( ( [ , side ] ) => 'right' === side ), 'but not its right' );
	// Centred, both sides are uneven.
	const quote = para( 25, 97, 326, 8, '"Ac purus aliquam pellentesque"', 'center' );
	assert.deepEqual( spaces( [ quote ], [ { ...quote, x: 55, w: 266 } ] ).filter( ( [ , side ] ) => 'left' === side || 'right' === side ), [] );
} );

test( 'wrapped text is compared by its line count, not its width; its alignment only once it wraps', () => {
	const text = para( 57, 100, 191, 2, 'Lorem ipsum dolor sit amet, consectetur' );
	assert.deepEqual( analyse( [ text ], [ { ...text, w: 281 } ] ).offsets, [], 'the same two lines, broken elsewhere' );
	assert.equal( analyse( [ text ], [ { ...text, w: 281, h: 3 * 25.6 } ] ).offsets.length, 1, 'a third line still counts' );
	// With layout boxes (where lines may run), a narrower or wider column still shows: a caption
	// over two lines in a 421px box in Figma, in the image's 628px column on the page.
	const caption = { ...para( 69, 545, 421, 2, 'Caption massa vel sapien pellentesque' ), lx: 69, lw: 421 };
	const [ wider ] = analyse( [ caption ], [ { ...caption, w: 625, lw: 628 } ] ).offsets;
	assert.deepEqual( [ wider.dw, wider.dh, wider.textBox ], [ 207, 0, { figma: 421, page: 628 } ] );
	const [ defect ] = triageSection( wireframeSection( { status: 'fail', score: 0.7, drift: { dx: 0, dy: 0, resized: 1 }, offsets: [ wider ] } ), null, DEFAULTS ).defects;
	assert.match( defect.summary, /: text box 421px wide in Figma, 628px on the page \(\+207px\), 0px tall$/ );
	assert.deepEqual( analyse( [ caption ], [ { ...caption, w: 380, lw: 421 } ] ).offsets, [], 'the same box, lines broken elsewhere' );
	const styles = ( f, p ) => analyse( [ f ], [ p ] ).styles.map( ( d ) => [ d.property, d.figma, d.page ] );
	assert.deepEqual( styles( text, { ...text, style: { ...text.style, align: 'center' } } ), [ [ 'align', 'left', 'center' ] ] );
	assert.deepEqual( styles( text, { ...text } ), [], 'the same alignment' );
	const line = para( 57, 100, 191, 1, 'One line' );
	assert.deepEqual( styles( line, { ...line, style: { ...line.style, align: 'center' } } ), [], 'a single line sits where its box does' );
} );

test( 'figma-boxes.txt carries a text\'s layout box; files from before it have none', () => {
	const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'fvd-layout-' ) );
	const file = path.join( dir, 'f.txt' );
	fs.writeFileSync( file, [
		'F|375|400', 'S|0|Intro / Mobile|0|400',
		'B|0|text|20|10|269|52|h1|two lines|0|0|font=Barlow;size=16;lh=25.6||20/335',
		'B|0|text|20|80|100|26|h2|older|0|0|font=Barlow;size=16;lh=25.6',
	].join( '\n' ) );
	const [ withBox, older ] = parseFigma( file, DEFAULT_CONFIG ).sections[ 0 ].boxes;
	assert.deepEqual( [ withBox.lx, withBox.lw, withBox.clipped ], [ 20, 335, undefined ] );
	assert.deepEqual( [ older.lx, older.lw ], [ undefined, undefined ] );
	fs.rmSync( dir, { recursive: true } );
} );

test( 'a loaded image the screenshot drew as one flat colour is flagged blank', async () => {
	const { PNG } = await loadDeps();
	const png = new PNG( { width: 200, height: 300 } );
	png.data.fill( 255 );
	// A photo at y 50–150 (section at y 20): noise; the one at 160–260 left white.
	for ( let y = 70; y < 170; y++ ) {
		for ( let x = 0; x < 100; x++ ) {
			const i = ( y * 200 + x ) * 4;
			png.data[ i ] = ( x * 7 + y * 3 ) % 256;
		}
	}
	const img = ( y, loaded = true ) => ( { x: 0, y, width: 100, height: 100, loaded } );
	const block = { y: 20, media: [ img( 50 ), img( 150 ), img( 150, false ) ] };
	assert.deepEqual( blankMedia( png, block ), [ img( 150 ) ], 'the drawn photo passes; an unloaded one isn\'t the capture\'s fault' );
} );
