/**
 * report.html: a page for reviewing each defect against its evidence, one at a time.
 *
 * A list on the left holds every defect, grouped by module and, with Jev, ordered by how likely
 * a reviewer asks to fix it; each module row carries its rule verdict, Jev's judgement and a
 * flag where they disagree. The pane on the right shows the selected defect: large Figma and
 * page crops around it, its values on both sides, and the whole section with it outlined. A
 * module row shows the module instead: Jev's answers, what Jev was shown, and the overlays.
 * triage.json stays the source of truth; this only presents it. The page sits in the run folder
 * and links the overlays relatively, and every pane is rendered here, so only navigation needs
 * the script.
 */

import { alignedBox } from './align.js';
import { TOKEN_LABELS, TOKEN_UNITS } from './defects.js';
import { moduleQuestions, moduleState, REJECT, SIGN_OFF } from './jev.js';

const esc = ( s ) => String( s ).replace( /[&<>"']/g, ( c ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ c ] ) );
const pct = ( n ) => `${ ( n * 100 ).toFixed( 1 ) }%`;
const signed = ( n ) => `${ n > 0 ? '+' : '' }${ n }`;
const num = ( n ) => Number( n.toFixed( 3 ) );

const OWNER_LABELS = { page: 'Page', developer: 'Developer', 'page-or-developer': 'Page, else developer' };

/** A defect side (Figma or page) as HTML. */
function side( value ) {
	if ( undefined === value ) {
		return '<span class="muted">—</span>';
	}
	if ( 'number' === typeof value ) {
		return `${ value }px`;
	}
	if ( 'string' === typeof value ) {
		return esc( value );
	}
	const text = value.text ? `<div class="copy">“${ esc( value.text ) }”</div>` : '';
	return `${ esc( value.type ) } ${ value.w }×${ value.h }<div class="muted">at ${ value.x }, ${ value.y }</div>${ text }`;
}

/** A defect's difference. */
function difference( d ) {
	if ( undefined !== d.score ) {
		return d.threshold ? `${ pct( d.score ) } <span class="muted">(min ${ pct( d.threshold ) })</span>` : pct( d.score );
	}
	if ( 'number' === typeof d.delta ) {
		return `${ signed( d.delta ) }px`;
	}
	if ( d.ratio ) {
		return `aspect ${ d.ratio.figma } → ${ d.ratio.page }`;
	}
	if ( d.delta ) {
		const labels = { x: 'x', y: 'y', w: 'width', h: 'height' };
		return Object.entries( d.delta ).filter( ( [ , v ] ) => v ).map( ( [ k, v ] ) => `${ labels[ k ] } ${ signed( v ) }px` ).join( '<br>' ) || '0px';
	}
	return '<span class="muted">—</span>';
}

/** A design token's value, with its unit and a swatch for colours. */
function token( property, value ) {
	if ( ! value ) {
		return '<span class="muted">—</span>';
	}
	const swatches = String( value ).match( /#[0-9a-f]{6,8}/gi ) || [];
	return `${ swatches.map( ( c ) => `<span class="swatch" style="background:${ c }"></span>` ).join( '' ) }${ esc( value ) }${ TOKEN_UNITS[ property ] ?? '' }`;
}

/** Jev's "would a reviewer ask to fix this" level for one defect. */
const mattersLevel = ( m ) => ( m >= SIGN_OFF ? 'rejected' : m <= REJECT ? 'signed-off' : 'review' );

/** Gap (px) between the pixel image's Figma, page and diff panels (lib/png.js sideBySide). */
const PANEL_GAP = 8;
/** A crop's context around a defect and its size limits, in section px; it's shown at most maxScale. */
const CROP = { margin: 40, minWidth: 200, minHeight: 120, maxScale: 2 };

/**
 * Where a defect is, on each side, in section px: the element on the side that has it, and
 * where it would be (a ghost) on the side that doesn't; for a spacing defect, the space. Null
 * for defects without one (height, overall scores). A ghost keeps the side its box was
 * measured on (`from`), so the pixel image can place it through that side's rows.
 */
export function locate( d ) {
	const box = ( b, ghost = false, from = undefined ) => b && { x: b.x, y: b.y, w: b.w, h: b.h, ghost, ...( from ? { from } : {} ) };
	switch ( d.issue ) {
		case 'missing':
			return { figma: box( d.figma ), page: box( d.figma, true, 'figma' ) };
		case 'extra':
			return { figma: box( d.page, true, 'page' ), page: box( d.page ) };
		case 'resized':
		case 'aspect':
		case 'shifted':
		case 'copy':
			return { figma: box( d.figma ), page: box( d.page ) };
		case 'style':
			// Only the Figma element is recorded; its page partner is paired close by.
			return { figma: box( d.element ), page: box( d.element, true, 'figma' ) };
		case 'spacing':
			// The space itself, on each side.
			return { figma: box( d.area.figma ), page: box( d.area.page ) };
		default:
			return null;
	}
}

/**
 * A located defect placed in the pixel image, whose rows line both sections up (see
 * lib/align.js): each box goes through the rows of the side it was measured on.
 *
 * @param {Object|null} where locate() result.
 * @param {Object}      s     Triage section, with pixelRows.
 * @return {Object|null} {figma, page} in pixel image rows, or null without an alignment.
 */
export function inPixelImage( where, s ) {
	if ( ! where || ! s.pixelRows ) {
		return null;
	}
	const place = ( b, side ) => b && alignedBox( s.pixelRows, b.from ?? side, b );
	return { figma: place( where.figma, 'figma' ), page: place( where.page, 'page' ) };
}

/** The overlay images' own sizes (see wireframe-diff.js and pixel-diff.js), to place boxes on them. */
function imageSizes( s, width ) {
	return {
		wireframe: [ width, Math.ceil( Math.max( s.figmaHeight, s.pageHeight ) ) ],
		pixel: [ 3 * width + 2 * PANEL_GAP, s.pixelHeight ?? Math.round( s.figmaHeight ) ],
	};
}

/** An outline over an image or crop, positioned in % of the w×h area it sits in. */
function outline( b, sideName, x0, y0, w, h, cls = '' ) {
	if ( ! b ) {
		return '';
	}
	const at = ( v ) => num( v * 100 );
	return `<span class="hl hl-${ sideName }${ b.ghost ? ' ghost' : '' }${ cls }" style="left:${ at( ( b.x - x0 ) / w ) }%;top:${ at( ( b.y - y0 ) / h ) }%;width:${ Math.max( 0.3, at( b.w / w ) ) }%;height:${ Math.max( 0.3, at( b.h / h ) ) }%"></span>`;
}

/** A background showing the cw×ch area at x, y of a size[0]×size[1] image, scaled to fill its box. */
function cut( src, size, x, y, cw, ch ) {
	const [ iw, ih ] = size;
	const posX = iw > cw ? x / ( iw - cw ) : 0;
	const posY = ih > ch ? y / ( ih - ch ) : 0;
	return `background-image:url('${ esc( src ) }');background-size:${ num( ( iw / cw ) * 100 ) }% auto;background-position:${ num( posX * 100 ) }% ${ num( posY * 100 ) }%`;
}

/**
 * Figma and page stacked in one frame of the pixel image, the page shown right of a divider the
 * slider moves: what moved, resized or changed colour jumps as the divider passes it. The pixel
 * image lines both sides up row by row, so the same area of each panel is the same place.
 */
function swipe( src, size, x0, y0, cw, ch, pageX, overlay, label, maxWidth ) {
	return `<div class="swipe" style="max-width:${ Math.round( maxWidth ) }px;aspect-ratio:${ num( cw ) }/${ num( ch ) }">
		<span class="layer" style="${ cut( src, size, x0, y0, cw, ch ) }"></span><span class="layer page" style="${ cut( src, size, pageX + x0, y0, cw, ch ) }"></span>${ overlay }
		<span class="divider"></span><span class="side l">Figma</span><span class="side r">Page</span>
		<input type="range" min="0" max="100" step="0.5" value="50" aria-label="${ esc( `Divider between Figma and page, ${ label }` ) }">
	</div>`;
}

/**
 * Figma | page crops around a defect, cut from the pixel image (the wireframe overlay when a
 * section has no pixel image), with the element outlined. They scale with the pane: the crop is
 * a background positioned in %, so it needs no script.
 */
function crops( d, s, width ) {
	const pixel = s.images.pixel && inPixelImage( locate( d ), s );
	const where = pixel || locate( d );
	const src = pixel ? s.images.pixel : s.images.wireframe;
	if ( ! where || ! src ) {
		return '';
	}
	const [ imageWidth, imageHeight ] = imageSizes( s, width )[ pixel ? 'pixel' : 'wireframe' ];
	const boxes = [ where.figma, where.page ].filter( Boolean );
	const left = Math.min( ...boxes.map( ( b ) => b.x ) ) - CROP.margin;
	const right = Math.max( ...boxes.map( ( b ) => b.x + b.w ) ) + CROP.margin;
	const top = Math.min( ...boxes.map( ( b ) => b.y ) ) - CROP.margin;
	const bottom = Math.max( ...boxes.map( ( b ) => b.y + b.h ) ) + CROP.margin;
	const cw = Math.min( width, Math.max( right - left, CROP.minWidth ) );
	// At least a third as tall as wide, so a full-width strip still shows its surroundings.
	const ch = Math.min( imageHeight, Math.max( bottom - top, CROP.minHeight, cw / 3 ) );
	const clamp = ( v, max ) => Math.max( 0, Math.min( v, max ) );
	const x0 = clamp( ( left + right - cw ) / 2, width - cw );
	const y0 = clamp( ( top + bottom - ch ) / 2, imageHeight - ch );
	const size = [ imageWidth, imageHeight ];
	const crop = ( panelX, label, figmaBox, pageBox ) => {
		const style = `max-width:${ Math.round( cw * CROP.maxScale ) }px;aspect-ratio:${ num( cw ) }/${ num( ch ) };${ cut( src, size, panelX + x0, y0, cw, ch ) }`;
		return `<figure class="crop"><figcaption>${ label }</figcaption><span class="view" role="img" aria-label="${ esc( `${ label } around ${ d.summary }` ) }" style="${ style }">${ outline( figmaBox, 'figma', x0, y0, cw, ch ) }${ outline( pageBox, 'page', x0, y0, cw, ch ) }</span></figure>`;
	};
	if ( ! pixel ) {
		return `<div class="crops">${ crop( 0, 'Wireframe', where.figma, where.page ) }</div>`;
	}
	const both = outline( where.figma, 'figma', x0, y0, cw, ch ) + outline( where.page, 'page', x0, y0, cw, ch );
	return `<div class="crops mode-side">${ crop( 0, 'Figma', where.figma, null ) }${ crop( width + PANEL_GAP, 'Page', null, where.page ) }</div>
		<div class="mode-swipe">${ swipe( src, size, x0, y0, cw, ch, width + PANEL_GAP, both, `around ${ d.id }`, cw * CROP.maxScale ) }</div>`;
}

/** A defect's outlines on its section's whole overlay image; a height defect marks each side's bottom. */
function outlines( d, s, width, kind ) {
	const [ w, h ] = imageSizes( s, width )[ kind ];
	if ( 'height' === d.issue && 'wireframe' === kind ) {
		const line = ( y ) => ( { x: 0, y: y - 2, w: width, h: 4 } );
		return outline( line( s.figmaHeight ), 'figma', 0, 0, w, h, ' sel' ) + outline( line( s.pageHeight ), 'page', 0, 0, w, h, ' sel' );
	}
	const where = 'pixel' === kind ? inPixelImage( locate( d ), s ) : locate( d );
	if ( ! where ) {
		return '';
	}
	// The pixel image's page panel sits one section width and a gap to the right.
	const pageX = 'pixel' === kind ? width + PANEL_GAP : 0;
	return outline( where.figma, 'figma', 0, 0, w, h, ' sel' ) + outline( where.page, 'page', -pageX, 0, w, h, ' sel' );
}

/** A defect's element and its values on both sides, as HTML. */
function facts( d ) {
	if ( 'style' === d.issue ) {
		const which = `${ d.element.type }${ d.element.text ? ` “${ esc( d.element.text ) }”` : ` ${ d.element.w }×${ d.element.h }` }${ d.count > 1 ? ` <span class="muted">+${ d.count - 1 } more</span>` : '' }`;
		return { label: TOKEN_LABELS[ d.property ], what: `${ TOKEN_LABELS[ d.property ] }<div class="muted">${ which }</div>`, figma: token( d.property, d.figma ), page: token( d.property, d.page ), diff: '<span class="muted">—</span>' };
	}
	if ( 'spacing' === d.issue ) {
		const named = ( e ) => ( e.text ? `“${ esc( e.text ) }”` : `${ e.type } ${ e.w }×${ e.h }` );
		const which = {
			between: () => `between ${ named( d.from ) } and ${ named( d.to ) }`,
			inside: () => `inside ${ named( d.container ) }, ${ d.side } edge to ${ named( d.from ) }`,
			edge: () => `section ${ d.side } edge to ${ named( d.from ) }`,
		}[ d.where ]();
		const margin = ( m ) => ( m.from || 0 ) + ( m.to || 0 );
		const withMargin = margin( d.margins.figma ) || margin( d.margins.page );
		const space = ( px, m ) => `${ px }px${ withMargin ? `<div class="muted">${ margin( m ) }px of it margin</div>` : '' }`;
		return { label: 'spacing', what: `spacing<div class="muted">${ which }${ d.count > 1 ? ` <span class="muted">+${ d.count - 1 } more</span>` : '' }</div>`, figma: space( d.figma, d.margins.figma ), page: space( d.page, d.margins.page ), diff: difference( d ) };
	}
	return { label: esc( d.issue ), what: esc( d.issue ), figma: side( d.figma ), page: side( d.page ), diff: difference( d ) };
}

/** A defect's one-line label in the list: what differs, and by how much. */
function listLabel( d ) {
	if ( 'style' === d.issue ) {
		return `${ TOKEN_LABELS[ d.property ] } <span class="muted">${ esc( d.figma ?? '—' ) } → ${ esc( d.page ?? '—' ) }</span>`;
	}
	const element = { missing: d.figma?.type, extra: d.page?.type }[ d.issue ];
	return `${ esc( d.issue ) } <span class="muted">${ element ? esc( element ) : difference( d ).replace( /<br>/g, ', ' ) }</span>`;
}

/** Jev's bucket for a module: signed off, review or rejected. */
function bucket( d ) {
	if ( d.correct >= SIGN_OFF ) {
		return 'signed-off';
	}
	return d.correct <= REJECT ? 'rejected' : 'review';
}

const BUCKET_LABELS = { 'signed-off': 'Signed off', review: 'Review', rejected: 'Rejected' };

/**
 * Where Jev and the measurements disagree, for a person to settle.
 *
 * @param {Object} s Triage section with a diagnosis.
 * @return {string[]} Human-readable flags.
 */
export function disagreements( s ) {
	const d = s.diagnosis;
	const flags = [];
	const rulesOk = 'ok' === s.verdict;
	if ( rulesOk && d.correct < SIGN_OFF ) {
		flags.push( `rules pass it, Jev wouldn't sign it off (${ pct( d.correct ) })` );
	}
	if ( ! rulesOk && d.correct >= SIGN_OFF ) {
		flags.push( `rules fail it (${ s.verdict }), Jev would sign it off (${ pct( d.correct ) })` );
	}
	// Measured differences Jev doesn't think anyone would ask to fix: noise, or a miscall.
	const negligible = s.defects.filter( ( defect ) => defect.matters <= REJECT );
	if ( negligible.length ) {
		flags.push( `${ negligible.length } defect(s) Jev thinks a reviewer wouldn't ask to fix: ${ negligible.slice( 0, 4 ).map( ( defect ) => defect.id ).join( ', ' ) }${ negligible.length > 4 ? ', …' : '' }` );
	}
	return flags;
}

/** A module's defects in review order: with Jev, the ones a reviewer would most likely ask to fix first. */
const ordered = ( s ) => ( s.diagnosis ? [ ...s.defects ].sort( ( a, b ) => b.matters - a.matters ) : s.defects );

function diagnosisPanel( s, width ) {
	const d = s.diagnosis;
	if ( ! d ) {
		return `<p class="muted">${ 'dynamic' === s.verdict ? 'Live content: not diagnosed.' : 'Not diagnosed by Jev.' }</p>`;
	}
	const flags = disagreements( s );
	const worth = s.defects.filter( ( defect ) => defect.matters >= 0.5 ).length;
	return `<div class="jev">
		${ flags.length ? `<ul class="flags">${ flags.map( ( f ) => `<li>${ esc( f ) }</li>` ).join( '' ) }</ul>` : '' }
		<div class="answers">
			<div><h3>Reviewer would accept</h3>
				<div class="gauge"><span class="fill b-${ bucket( d ) }" style="width:${ ( d.correct * 100 ).toFixed( 1 ) }%"></span><span class="mark" style="left:${ REJECT * 100 }%"></span><span class="mark" style="left:${ SIGN_OFF * 100 }%"></span></div>
				<p><strong>${ pct( d.correct ) }</strong> · ${ BUCKET_LABELS[ bucket( d ) ] }</p></div>
			<div><h3>Defects worth fixing</h3>
				<p><strong>${ worth } of ${ s.defects.length }</strong> <span class="muted">(Jev: 50% or more likely a reviewer asks for it; the list is ordered by it)</span></p></div>
		</div>
		<details><summary>What Jev was shown and asked</summary><pre>${ esc( JSON.stringify( { state: moduleState( s, width ), questions: moduleQuestions( s ) }, null, 2 ) ) }</pre></details>
	</div>`;
}

/** A section's overlay image, with outlines over it when given; its size is set so the pane doesn't shift as it loads. */
function figure( s, width, kind, overlay = '' ) {
	const src = s.images[ kind ];
	if ( ! src ) {
		return '';
	}
	const [ w, h ] = imageSizes( s, width )[ kind ];
	const [ title, score, caption ] = 'pixel' === kind
		? [ 'Pixels', s.pixelScore, 'Figma | page | diff' ]
		: [ 'Wireframe', s.wireframeScore, 'Figma red, page blue; thick boxes are unmatched' ];
	return `<figure class="${ kind }${ 'pixel' === kind ? ' mode-side' : '' }"><figcaption><strong>${ title }${ undefined === score ? '' : ` ${ pct( score ) }` }</strong> <span class="muted">${ caption }</span></figcaption><a class="frame" href="${ esc( src ) }"><img src="${ esc( src ) }" width="${ w }" height="${ h }" alt="${ title } comparison for ${ esc( s.slug ) }" loading="lazy">${ overlay }</a></figure>`;
}

/** The whole section as a swipe, when it has a pixel image; outlines in section px over it. */
function sectionSwipe( s, width, overlay = '' ) {
	if ( ! s.images.pixel ) {
		return '';
	}
	const size = imageSizes( s, width ).pixel;
	return `<figure class="mode-swipe"><figcaption><strong>Pixels ${ pct( s.pixelScore ) }</strong> <span class="muted">Figma left of the divider, page right; drag across it</span></figcaption>${ swipe( s.images.pixel, size, 0, 0, width, size[ 1 ], width + PANEL_GAP, overlay, s.slug, width ) }</figure>`;
}

/** A defect's outlines on the whole-section swipe: both sides in the same panel's coordinates. */
function swipeOutlines( d, s, width ) {
	const where = inPixelImage( locate( d ), s );
	const h = imageSizes( s, width ).pixel[ 1 ];
	return where ? outline( where.figma, 'figma', 0, 0, width, h, ' sel' ) + outline( where.page, 'page', 0, 0, width, h, ' sel' ) : '';
}

/** A module's measured comparison: its numbers, then the pixel and wireframe overlays under their scores. */
function comparison( s, width ) {
	const stat = ( label, value ) => `<div class="stat"><div class="muted small">${ label }</div><div class="value">${ value }</div></div>`;
	const stats = [
		stat( 'Height, Figma → page', `${ s.figmaHeight } → ${ s.pageHeight }px <span class="delta">${ signed( s.heightDelta ) }</span>` ),
		s.drift && stat( 'Median drift x/y', `${ signed( s.drift.dx ) }/${ signed( s.drift.dy ) }px` ),
	].filter( Boolean ).join( '' );
	const images = sectionSwipe( s, width ) + figure( s, width, 'pixel' ) + figure( s, width, 'wireframe' );
	return `<div class="comparison"><div class="stats">${ stats }</div>${ images ? `<div class="images">${ images }</div>` : '' }</div>`;
}

/** A module's pane: its verdict, Jev's judgement and the overlays. */
function modulePane( s, width ) {
	const empty = s.defects.length ? '' : `<p class="muted">${ 'dynamic' === s.verdict ? 'Live content: only its presence is checked.' : 'No defects.' }</p>`;
	return `<section class="pane" id="s${ s.index }" hidden>
		<header>
			<h2><span class="muted">#${ s.index }</span> ${ esc( s.slug ) } <span class="tag tag-${ s.verdict }">${ s.verdict }</span></h2>
			<p class="muted">${ esc( s.figma ) } · ${ s.defects.length } defect(s)</p>
		</header>
		${ empty }
		${ diagnosisPanel( s, width ) }
		${ comparison( s, width ) }
	</section>`;
}

/** A defect as a ticket, in markdown; the script appends the link to it in this report. */
function ticket( d, s, report ) {
	return [ `**${ d.id }** ${ d.kind } · ${ d.issue } · ${ OWNER_LABELS[ d.owner ] }`, '', d.summary, '', `Section #${ s.index } ${ s.slug } (${ s.figma }), at ${ report.width }px on ${ report.url }` ].join( '\n' );
}

/** A defect's pane: large crops, its values on both sides, then the whole section with it outlined. */
function defectPane( d, s, report ) {
	const width = report.width;
	const f = facts( d );
	const matters = undefined === d.matters
		? ''
		: `<span class="matters" title="Jev: how likely a reviewer asks to fix it"><span class="minigauge"><span class="fill b-${ mattersLevel( d.matters ) }" style="width:${ ( d.matters * 100 ).toFixed( 1 ) }%"></span></span> worth fixing ${ pct( d.matters ) }</span>`;
	const shown = crops( d, s, width );
	const group = d.count > 1 ? `<p class="muted small">One defect for ${ d.count } elements with the same difference; the first is outlined.</p>` : '';
	const whole = sectionSwipe( s, width, swipeOutlines( d, s, width ) ) + figure( s, width, 'pixel', outlines( d, s, width, 'pixel' ) ) + figure( s, width, 'wireframe', outlines( d, s, width, 'wireframe' ) );
	return `<article class="pane" id="d-${ esc( d.id ) }" data-defect="${ esc( d.id ) }" hidden>
		<p class="crumb"><a href="#s${ s.index }" data-go="s${ s.index }"><span class="muted">#${ s.index }</span> ${ esc( s.slug ) }</a> <span class="tag tag-${ s.verdict }">${ s.verdict }</span></p>
		<header>
			<h2><span class="id">${ esc( d.id ) }</span> <span class="tag tag-${ d.kind }">${ d.kind }</span> ${ f.label } <span class="owner muted">· ${ OWNER_LABELS[ d.owner ] }</span></h2>
			${ matters }
			<button type="button" class="copy-ticket" data-ticket="${ esc( ticket( d, s, report ) ) }">Copy ticket</button>
		</header>
		<p class="summary">${ esc( d.summary ) }</p>
		${ shown || '<p class="muted">No element to crop around: see the whole section below.</p>' }
		<table class="facts"><thead><tr><th>What</th><th>Figma</th><th>Page</th><th>Difference</th></tr></thead>
			<tbody><tr><td>${ f.what }</td><td>${ f.figma }</td><td>${ f.page }</td><td>${ f.diff }</td></tr></tbody></table>
		${ group }
		<details class="whole" open><summary>Whole section</summary><div class="images">${ whole }</div></details>
	</article>`;
}

/** The list: one group per module, its defects below it in review order. */
function list( sections ) {
	return sections.map( ( s ) => {
		const d = s.diagnosis;
		const flags = d ? disagreements( s ) : [];
		const jev = d ? `<span class="pill b-${ bucket( d ) }" title="Jev: reviewer would accept">${ pct( d.correct ) }</span>` : '';
		const flag = flags.length ? `<span class="flag" title="${ esc( flags.join( '\n' ) ) }">⚑ ${ flags.length }</span>` : '';
		const items = ordered( s ).map( ( x ) => `<li data-kind="${ x.kind }" data-owner="${ x.owner }"${ undefined === x.matters ? '' : ` data-jev="${ x.matters >= 0.5 ? 'worth' : x.matters <= REJECT ? 'noise' : 'unsure' }"` }>
			<a href="#d-${ esc( x.id ) }" data-go="d-${ esc( x.id ) }"><span class="dot tag-${ x.kind }"></span><span class="id">${ esc( x.id ) }</span> <span class="label">${ listLabel( x ) }</span>${ undefined === x.matters ? '' : ` <span class="small muted">${ Math.round( x.matters * 100 ) }%</span>` }</a></li>` ).join( '' );
		return `<li class="module" data-disagree="${ flags.length ? 'yes' : 'no' }">
			<a class="head" href="#s${ s.index }" data-go="s${ s.index }"><span class="muted">#${ s.index }</span> <span class="name">${ esc( s.slug ) }</span> <span class="tag tag-${ s.verdict }">${ s.verdict }</span> ${ jev } ${ flag } <span class="count muted">${ s.defects.length }</span></a>
			${ items ? `<ul>${ items }</ul>` : '' }
		</li>`;
	} ).join( '' );
}

/** Filters over the list, by defect (kind, owner, Jev) and by module (disagreements). */
function filters( sections ) {
	const defects = sections.flatMap( ( s ) => s.defects );
	const select = ( key, label, options ) => ( options.length > 1
		? `<label>${ label } <select data-filter="${ key }"><option value="">All</option>${ options.map( ( [ v, text ] ) => `<option value="${ v }">${ text }</option>` ).join( '' ) }</select></label>`
		: '' );
	const kinds = [ ...new Set( defects.map( ( d ) => d.kind ) ) ].map( ( k ) => [ k, k ] );
	const owners = [ ...new Set( defects.map( ( d ) => d.owner ) ) ].map( ( o ) => [ o, OWNER_LABELS[ o ] ] );
	const diagnosed = defects.some( ( d ) => undefined !== d.matters );
	const jev = diagnosed ? [ [ 'worth', 'Worth fixing' ], [ 'unsure', 'Unsure' ], [ 'noise', 'Likely noise' ] ] : [];
	const disagree = sections.some( ( s ) => s.diagnosis && disagreements( s ).length )
		? '<label><input type="checkbox" data-filter="disagree"> Disagreements only</label>'
		: '';
	return `<div class="filters">${ select( 'kind', 'Kind', kinds ) }${ select( 'owner', 'Owner', owners ) }${ select( 'jev', 'Jev', jev ) }${ disagree }</div>`;
}

/**
 * Runs in report.html: shows one pane at a time. A list link or #d-<id> / #s<n> selects a pane,
 * the pager steps through the defects left visible by the filters, and the swipe sliders and
 * Copy ticket buttons work. Embedded as source, so it must stay self-contained.
 */
function navigation() {
	const panes = [ ...document.querySelectorAll( '.pane' ) ];
	const links = [ ...document.querySelectorAll( '.list [data-go]' ) ];
	const pager = document.querySelector( '.pager' );
	const visible = () => links.filter( ( a ) => a.closest( 'li:not(.module)' ) && a.offsetParent );
	let current = null;
	const show = ( id, scroll ) => {
		const pane = document.getElementById( id );
		if ( ! pane || ! pane.classList.contains( 'pane' ) ) {
			return;
		}
		current = id;
		panes.forEach( ( p ) => { p.hidden = p !== pane; } );
		// An empty aria-current reads as false: it needs a value.
		links.forEach( ( a ) => ( a.dataset.go === id ? a.setAttribute( 'aria-current', 'true' ) : a.removeAttribute( 'aria-current' ) ) );
		links.find( ( a ) => a.dataset.go === id )?.scrollIntoView( { block: 'nearest' } );
		history.replaceState( null, '', `#${ id }` );
		const steps = visible();
		const at = steps.findIndex( ( a ) => a.dataset.go === id );
		pager.querySelector( '.pos' ).textContent = at < 0 ? `${ steps.length } defects` : `${ at + 1 } of ${ steps.length }`;
		const main = document.querySelector( '.detail' );
		if ( scroll && main.getBoundingClientRect().top < 0 ) {
			main.scrollIntoView( { block: 'start' } );
		}
	};
	const step = ( by ) => {
		const steps = visible();
		if ( ! steps.length ) {
			return;
		}
		const at = steps.findIndex( ( a ) => a.dataset.go === current );
		// From a module, step into its first defect (or the one before it, going back).
		const from = at >= 0 ? at : steps.findIndex( ( a ) => a.closest( '.module' ).querySelector( '.head' ).dataset.go === current );
		const next = from < 0 ? 0 : Math.max( 0, Math.min( steps.length - 1, at < 0 && by > 0 ? from : from + by ) );
		show( steps[ next ].dataset.go, true );
	};
	const mode = document.querySelector( '[data-mode]' );
	const toggleSwipe = () => mode.setAttribute( 'aria-pressed', String( document.body.classList.toggle( 'swipe-mode' ) ) );
	document.addEventListener( 'input', ( event ) => {
		const frame = event.target.closest( '.swipe' );
		if ( frame ) {
			frame.style.setProperty( '--cut', `${ event.target.value }%` );
		}
	} );
	const copyTicket = async ( button ) => {
		const text = `${ button.dataset.ticket }\n\n${ location.href.split( '#' )[ 0 ] }#${ button.closest( '.pane' ).id }`;
		let copied = true;
		try {
			await navigator.clipboard.writeText( text );
		} catch {
			// No clipboard API (an insecure context): copy through a selected textarea instead.
			const area = Object.assign( document.createElement( 'textarea' ), { value: text } );
			document.body.append( area );
			area.select();
			try {
				copied = document.execCommand( 'copy' );
			} catch {
				copied = false;
			}
			area.remove();
		}
		button.textContent = copied ? 'Copied' : 'Copy failed';
		setTimeout( () => { button.textContent = 'Copy ticket'; }, 1500 );
	};
	document.addEventListener( 'click', ( event ) => {
		if ( event.target.closest( '[data-mode]' ) ) {
			toggleSwipe();
		}
		const copy = event.target.closest( '.copy-ticket' );
		if ( copy ) {
			copyTicket( copy );
		}
		const link = event.target.closest( '[data-go]' );
		if ( link ) {
			event.preventDefault();
			show( link.dataset.go, true );
		}
		const button = event.target.closest( '[data-step]' );
		if ( button ) {
			step( Number( button.dataset.step ) );
		}
	} );
	const filter = () => {
		const value = ( key ) => document.querySelector( `[data-filter="${ key }"]` );
		const by = [ 'kind', 'owner', 'jev' ].map( ( key ) => [ key, value( key )?.value ] ).filter( ( [ , v ] ) => v );
		const disagree = value( 'disagree' )?.checked;
		document.querySelectorAll( '.list .module' ).forEach( ( module ) => {
			const items = [ ...module.querySelectorAll( 'li' ) ];
			items.forEach( ( li ) => { li.hidden = by.some( ( [ key, v ] ) => li.dataset[ key ] !== v ); } );
			module.hidden = ( disagree && 'yes' !== module.dataset.disagree ) || ( by.length > 0 && items.every( ( li ) => li.hidden ) );
		} );
		show( current );
	};
	document.querySelectorAll( '[data-filter]' ).forEach( ( el ) => el.addEventListener( 'change', filter ) );
	const linked = () => {
		// A malformed hash (#d-%) would otherwise throw and leave every pane hidden.
		try {
			return decodeURIComponent( location.hash.slice( 1 ) );
		} catch {
			return '';
		}
	};
	// A #d-<id> link pasted into an open report changes only the hash.
	window.addEventListener( 'hashchange', () => show( linked(), true ) );
	const first = visible()[ 0 ] ?? links[ 0 ];
	// No sections compared (a structure-only report): nothing to show or step through.
	if ( ! first ) {
		pager.hidden = true;
		return;
	}
	show( document.getElementById( linked() )?.classList.contains( 'pane' ) ? linked() : first.dataset.go );
}

/** Headline metrics, with the change since the previous run. */
function metricsSummary( report ) {
	const m = report.metrics;
	const delta = ( n, scale = 100, unit = 'pt' ) => ( undefined === n ? '' : ` <span class="delta">${ n > 0 ? '+' : '' }${ Number( ( n * scale ).toFixed( 1 ) ) }${ unit }</span>` );
	const d = report.metricsDelta ?? {};
	const items = [
		[ 'Measured correctness', `${ pct( m.correctness ) }${ delta( d.correctness ) }`, `${ m.sections.ok } of ${ m.sections.figma - m.sections.dynamic } sections without defects` ],
		m.diagnosis && [ 'Jev expected correctness', `${ pct( m.diagnosis.expectedCorrectness ) }${ delta( d.expectedCorrectness ) }`, `${ m.diagnosis.signedOff } signed off · ${ m.diagnosis.needsReview } review · ${ m.diagnosis.rejected } rejected · ${ m.diagnosis.expectedFixes } fixes expected · ${ m.diagnosis.negligible } negligible · ${ esc( m.diagnosis.model ) }` ],
		[ 'Defects', `${ m.defects.total }${ delta( d.defects, 1, '' ) }`, `page ${ m.defects.byOwner.page } · developer ${ m.defects.byOwner.developer } · either ${ m.defects.byOwner[ 'page-or-developer' ] }` ],
		[ 'Scores', `wireframe ${ pct( m.scores.wireframe ) } · pixels ${ pct( m.scores.pixel ) }`, '' ],
	].filter( Boolean );
	const since = report.metricsDelta ? `<p class="muted small">Changes are since run ${ esc( report.previous ) }.</p>` : '';
	return `${ since }<div class="metrics">${ items.map( ( [ label, value, note ] ) => `<div class="metric"><div class="muted">${ label }</div><div class="value">${ value }</div><div class="muted small">${ note }</div></div>` ).join( '' ) }</div>`;
}

/**
 * The report page.
 *
 * @param {Object} report triage.json content.
 * @param {string} run    The run folder's name, shown as the date.
 * @return {string} HTML.
 */
export function renderReport( report, run ) {
	const sections = report.sections;
	const width = report.width;
	const structure = report.structure.length ? `<section class="card"><h2>Structure</h2><ul>${ report.structure.map( ( d ) => `<li><span class="id">${ esc( d.id ) }</span> ${ esc( d.summary ) }</li>` ).join( '' ) }</ul></section>` : '';
	const warnings = report.warnings.map( ( w ) => `<p class="warning">${ esc( w ) }</p>` ).join( '' );
	const panes = sections.map( ( s ) => modulePane( s, width ) + ordered( s ).map( ( d ) => defectPane( d, s, report ) ).join( '' ) ).join( '\n' );
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual diff ${ esc( new URL( report.url ).pathname ) } ${ width }px</title>
<style>
:root { --bg: #f7f7f8; --card: #fff; --text: #1d1d20; --muted: #6b6b76; --line: #e3e3e8; --accent: #3056d3; --track: #ececf1;
	--structure: #8a1c7c; --content: #c0392b; --alignment: #b35c00; --layout: #1f5fbf; --visual: #6c3fc5; --ok: #1e7b45; --dynamic: #6b6b76; --review: #b58100; --flag: #b35c00; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #141417; --card: #1d1d22; --text: #ececf1; --muted: #9a9aa6; --line: #2e2e36; --accent: #7d9bff; --track: #2a2a31;
	--structure: #e07fd3; --content: #ff7b6e; --alignment: #ffae57; --layout: #74a7ff; --visual: #b596ff; --ok: #5fd08f; --dynamic: #9a9aa6; --review: #e8c15a; --flag: #ffae57; } }
:root[data-theme="dark"] { --bg: #141417; --card: #1d1d22; --text: #ececf1; --muted: #9a9aa6; --line: #2e2e36; --accent: #7d9bff; --track: #2a2a31;
	--structure: #e07fd3; --content: #ff7b6e; --alignment: #ffae57; --layout: #74a7ff; --visual: #b596ff; --ok: #5fd08f; --dynamic: #9a9aa6; --review: #e8c15a; --flag: #ffae57; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
.top { max-width: 1680px; margin: 0 auto; padding: 24px 16px 0; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0; }
h3 { font-size: 13px; margin: 0 0 6px; }
a { color: var(--accent); overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.warning { border-left: 3px solid var(--alignment); padding: 4px 10px; background: var(--card); }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 16px 0; }
.metric { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.metric .value { font-size: 18px; font-weight: 600; }
.delta { font-size: 13px; font-weight: 500; color: var(--muted); }
.card, .detail, .list-wrap { background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
.card { padding: 16px; margin-bottom: 16px; }
.review { max-width: 1680px; margin: 0 auto; padding: 0 16px 64px; display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); gap: 16px; align-items: start; }
.list-wrap { position: sticky; top: 8px; max-height: calc(100vh - 16px); display: flex; flex-direction: column; overflow: hidden; }
.filters { display: flex; flex-wrap: wrap; gap: 6px 12px; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
.filters select { font: inherit; background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 6px; }
.list { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; }
.list ul { list-style: none; margin: 0 0 6px; padding: 0; }
.list a { display: flex; gap: 6px; align-items: baseline; padding: 3px 12px; color: var(--text); text-decoration: none; overflow-wrap: normal; }
.list a:hover { background: var(--bg); }
.list a[aria-current] { background: var(--bg); box-shadow: inset 3px 0 0 var(--accent); }
.list a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.list .head { font-weight: 600; padding-top: 8px; align-items: center; flex-wrap: wrap; }
.list .head .count { margin-left: auto; font-weight: 400; }
.list li:not(.module) a { padding-left: 24px; }
.list .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; align-self: center; }
.pill { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 0 6px; color: var(--card); }
.detail { padding: 16px; min-width: 0; }
.pager { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 13px; }
.pager button { white-space: nowrap; font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 999px; padding: 2px 12px; cursor: pointer; }
.pager button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pane header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-bottom: 8px; }
.pane header p { margin: 0; flex-basis: 100%; }
.crumb { margin: 0 0 6px; font-size: 13px; }
.crumb a { text-decoration: none; }
.summary { margin: 0 0 12px; }
.tag { display: inline-block; font-size: 12px; font-weight: 600; border-radius: 4px; padding: 0 6px; color: var(--card); background: var(--muted); vertical-align: 1px; }
${ [ 'structure', 'content', 'alignment', 'layout', 'visual', 'ok', 'dynamic' ].map( ( k ) => `.tag-${ k } { background: var(--${ k }); }` ).join( '\n' ) }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-top: 1px solid var(--line); }
th { font-size: 12px; color: var(--muted); font-weight: 600; border-top: 0; }
.facts { margin: 12px 0; }
.id { font-family: ui-monospace, monospace; color: var(--muted); white-space: nowrap; }
.copy { font-style: italic; }
.crops { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.crop { margin: 0; }
.crop .view { position: relative; display: block; width: 100%; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background-color: #fff; background-repeat: no-repeat; }
.frame { position: relative; display: block; }
.hl { position: absolute; box-sizing: border-box; border: 2px solid; border-radius: 2px; pointer-events: none; }
.hl-figma { border-color: #e62828; background: rgba(230, 40, 40, 0.12); }
.hl-page { border-color: #1e5ae6; background: rgba(30, 90, 230, 0.12); }
.hl.ghost { border-style: dashed; background: none; }
.frame .hl.sel { border-width: 3px; box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.8); }
.swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--line); margin-right: 6px; vertical-align: -1px; }
.owner, .matters { white-space: nowrap; }
.flag, .flags li { color: var(--flag); }
.flags { margin: 0 0 12px; padding: 8px 12px 8px 28px; border: 1px solid var(--flag); border-radius: 8px; }
.answers { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
.answers p { margin: 6px 0 0; }
.gauge, .minigauge { position: relative; display: block; height: 10px; background: var(--track); border-radius: 5px; overflow: hidden; }
.minigauge { display: inline-block; width: 60px; height: 8px; vertical-align: middle; }
.gauge .mark { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--muted); }
.fill { display: block; height: 100%; background: var(--accent); }
.b-signed-off { background: var(--ok); } .b-review { background: var(--review); } .b-rejected { background: var(--content); }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
ul { margin: 0; padding-left: 18px; }
details summary { cursor: pointer; margin-top: 12px; color: var(--accent); }
.comparison { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.stats { display: flex; flex-wrap: wrap; gap: 8px 32px; margin-bottom: 12px; }
.stat .value { font-size: 16px; font-weight: 600; }
.images { display: grid; gap: 16px; align-items: start; margin-top: 8px; }
@media (min-width: 900px) { .images .wireframe { max-width: 50%; } }
figure { margin: 0; }
figcaption { margin-bottom: 6px; font-size: 13px; }
figure img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
body:not(.swipe-mode) .mode-swipe, body.swipe-mode .mode-side { display: none; }
.pager [aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.copy-ticket { font: inherit; font-size: 13px; margin-left: auto; border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 999px; padding: 2px 12px; cursor: pointer; }
.copy-ticket:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.swipe { --cut: 50%; position: relative; width: 100%; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
.swipe .layer { position: absolute; inset: 0; background-repeat: no-repeat; }
.swipe .page { clip-path: inset(0 0 0 var(--cut)); }
.swipe .hl { z-index: 1; }
.swipe .divider { position: absolute; z-index: 2; top: 0; bottom: 0; left: var(--cut); width: 2px; margin-left: -1px; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45); pointer-events: none; }
.swipe:focus-within .divider { background: var(--accent); }
.swipe .side { position: absolute; z-index: 2; top: 6px; font-size: 11px; padding: 0 6px; border-radius: 4px; background: rgba(0, 0, 0, 0.6); color: #fff; pointer-events: none; }
.swipe .l { left: 6px; } .swipe .r { right: 6px; }
.swipe input { position: absolute; z-index: 3; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; -webkit-appearance: none; appearance: none; }
.swipe input::-webkit-slider-thumb { -webkit-appearance: none; width: 2px; height: 100vh; }
.swipe input::-moz-range-thumb { width: 2px; height: 100%; border: 0; }
[hidden] { display: none !important; }
@media (max-width: 800px) {
	.review { grid-template-columns: minmax(0, 1fr); }
	.list-wrap { position: static; max-height: 45vh; }
}
</style>
</head>
<body>
<div class="top">
<h1>${ report.pass ? '<span class="tag tag-ok">PASS</span>' : '<span class="tag tag-content">FAIL</span>' } ${ esc( new URL( report.url ).pathname ) } at ${ width }px</h1>
<p class="muted"><a href="${ esc( report.url ) }">${ esc( report.url ) }</a> · run ${ esc( run ) }</p>
${ warnings }
${ metricsSummary( report ) }
${ structure }
</div>
<div class="review">
<nav class="list-wrap" aria-label="Defects">${ filters( sections ) }<ul class="list">${ list( sections ) }</ul></nav>
<main class="detail">
<div class="pager"><button type="button" data-step="-1">← Previous</button><button type="button" data-step="1">Next →</button><button type="button" data-mode aria-pressed="false">Swipe</button><span class="pos muted"></span></div>
${ panes }
</main>
</div>
<script>
(${ navigation })();
</script>
</body>
</html>
`;
}
