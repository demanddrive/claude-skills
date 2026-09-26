/**
 * report.html: a page for reviewing Jev's diagnoses against the evidence.
 *
 * An overview puts each module's rule verdict next to Jev's judgement and flags where they
 * disagree (e.g. rules say ok, Jev wouldn't sign it off; or Jev names another owner than the
 * defects do). Each module card then shows Jev's answers with their full probabilities, the
 * exact state Jev was shown, the measured defects and the overlay images, so a person can
 * judge each diagnosis. triage.json stays the source of truth; this only presents it. The
 * page sits in the run folder and links the overlays relatively.
 */

import { alignedBox } from './align.js';
import { TOKEN_LABELS, TOKEN_UNITS } from './defects.js';
import { moduleQuestions, moduleState, REJECT, SIGN_OFF } from './jev.js';

const esc = ( s ) => String( s ).replace( /[&<>"']/g, ( c ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ c ] ) );
const pct = ( n ) => `${ ( n * 100 ).toFixed( 1 ) }%`;
const signed = ( n ) => `${ n > 0 ? '+' : '' }${ n }`;

const OWNER_LABELS = { page: 'Page', developer: 'Developer', 'page-or-developer': 'Page, else developer' };

/** A defect side (Figma or page) as table cell HTML. */
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

/** A defect's difference column. */
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

/** Jev's "would a reviewer ask to fix this" for one defect, as a small gauge. */
function mattersCell( d ) {
	if ( undefined === d.matters ) {
		return '';
	}
	const level = d.matters >= SIGN_OFF ? 'rejected' : d.matters <= REJECT ? 'signed-off' : 'review';
	return `<td class="nowrap"><span class="minigauge"><span class="fill b-${ level }" style="width:${ ( d.matters * 100 ).toFixed( 1 ) }%"></span></span> ${ pct( d.matters ) }</td>`;
}

/** Gap (px) between the pixel image's Figma, page and diff panels (lib/png.js sideBySide). */
const PANEL_GAP = 8;
const THUMB = { width: 132, height: 88, margin: 16 };

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

/** A defect's band on the wireframe (the section's height), in section px per side. */
function band( d, s ) {
	if ( 'height' === d.issue ) {
		return { side: 'height', figma: s.figmaHeight, page: s.pageHeight };
	}
	return null;
}

/**
 * Figma | page previews of a defect, cut from the pixel image (the wireframe overlay when a
 * section has no pixel image), with the element outlined. Built here, so they need no script.
 */
function thumbnails( d, s, width ) {
	const where = ( s.images.pixel && inPixelImage( locate( d ), s ) ) || locate( d );
	if ( ! where || ( ! s.images.pixel && ! s.images.wireframe ) ) {
		return '<span class="muted">—</span>';
	}
	const boxes = [ where.figma, where.page ].filter( Boolean );
	const x0 = Math.max( 0, Math.min( ...boxes.map( ( b ) => b.x ) ) - THUMB.margin );
	const y0 = Math.max( 0, Math.min( ...boxes.map( ( b ) => b.y ) ) - THUMB.margin );
	const cw = Math.max( 64, Math.min( width, Math.max( ...boxes.map( ( b ) => b.x + b.w ) ) + THUMB.margin ) - x0 );
	const ch = Math.max( 48, Math.max( ...boxes.map( ( b ) => b.y + b.h ) ) + THUMB.margin - y0 );
	const k = Math.min( THUMB.width / cw, THUMB.height / ch );
	const [ tw, th ] = [ Math.round( cw * k ), Math.round( ch * k ) ];
	const outline = ( b, side ) => ( b ? `<span class="hl hl-${ side }${ b.ghost ? ' ghost' : '' }" style="left:${ ( ( b.x - x0 ) * k ).toFixed( 1 ) }px;top:${ ( ( b.y - y0 ) * k ).toFixed( 1 ) }px;width:${ Math.max( 2, b.w * k ).toFixed( 1 ) }px;height:${ Math.max( 2, b.h * k ).toFixed( 1 ) }px"></span>` : '' );
	const thumb = ( src, imageWidth, panelX, shiftY, label, figmaBox, pageBox ) => `<span class="thumb" role="img" aria-label="${ esc( label ) }" style="width:${ tw }px;height:${ th }px;background-image:url('${ esc( src ) }');background-size:${ ( imageWidth * k ).toFixed( 1 ) }px auto;background-position:${ ( -( panelX + x0 ) * k ).toFixed( 1 ) }px ${ ( -( y0 - shiftY ) * k ).toFixed( 1 ) }px">${ outline( figmaBox, 'figma' ) }${ outline( pageBox, 'page' ) }</span>`;
	const what = d.summary;
	if ( ! s.images.pixel ) {
		return thumb( s.images.wireframe, width, 0, 0, `Wireframe around ${ what }`, where.figma, where.page );
	}
	return `<span class="thumbs">${ thumb( s.images.pixel, 3 * width + 2 * PANEL_GAP, 0, 0, `Figma around ${ what }`, where.figma, null ) }${ thumb( s.images.pixel, 3 * width + 2 * PANEL_GAP, width + PANEL_GAP, 0, `Page around ${ what }`, null, where.page ) }</span>`;
}

/** The row's attributes for selecting it: its id, and where to highlight on the full images. */
function rowAttrs( d, s ) {
	const pixel = inPixelImage( locate( d ), s );
	const loc = { ...( locate( d ) ?? {} ), ...( band( d, s ) ? { band: band( d, s ) } : {} ), ...( pixel ? { pixel } : {} ) };
	return `id="d-${ esc( d.id ) }" data-defect="${ esc( d.id ) }" data-summary="${ esc( d.summary ) }" data-loc="${ esc( JSON.stringify( loc ) ) }"`;
}

/** The id cell: a button, so rows can be selected from the keyboard too. */
const idCell = ( d ) => `<td class="id"><button type="button" class="select" aria-label="Show ${ esc( d.id ) } on the images">${ esc( d.id ) }</button></td>`;

function defectRow( d, s, width ) {
	if ( 'style' === d.issue ) {
		const which = `${ d.element.type }${ d.element.text ? ` “${ esc( d.element.text ) }”` : ` ${ d.element.w }×${ d.element.h }` }${ d.count > 1 ? ` <span class="muted">+${ d.count - 1 } more</span>` : '' }`;
		return `<tr ${ rowAttrs( d, s ) }>
		${ idCell( d ) }${ mattersCell( d ) }
		<td>${ thumbnails( d, s, width ) }</td>
		<td><span class="tag tag-${ d.kind }">${ d.kind }</span></td>
		<td>${ TOKEN_LABELS[ d.property ] }<div class="muted">${ which }</div></td>
		<td>${ token( d.property, d.figma ) }</td>
		<td>${ token( d.property, d.page ) }</td>
		<td><span class="muted">—</span></td>
		<td class="owner">${ OWNER_LABELS[ d.owner ] }</td>
	</tr>`;
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
		return `<tr ${ rowAttrs( d, s ) }>
		${ idCell( d ) }${ mattersCell( d ) }
		<td>${ thumbnails( d, s, width ) }</td>
		<td><span class="tag tag-${ d.kind }">${ d.kind }</span></td>
		<td>spacing<div class="muted">${ which }${ d.count > 1 ? ` <span class="muted">+${ d.count - 1 } more</span>` : '' }</div></td>
		<td>${ space( d.figma, d.margins.figma ) }</td>
		<td>${ space( d.page, d.margins.page ) }</td>
		<td>${ difference( d ) }</td>
		<td class="owner">${ OWNER_LABELS[ d.owner ] }</td>
	</tr>`;
	}
	return `<tr ${ rowAttrs( d, s ) }>
		${ idCell( d ) }${ mattersCell( d ) }
		<td>${ thumbnails( d, s, width ) }</td>
		<td><span class="tag tag-${ d.kind }">${ d.kind }</span></td>
		<td>${ esc( d.issue ) }</td>
		<td>${ side( d.figma ) }</td>
		<td>${ side( d.page ) }</td>
		<td>${ difference( d ) }</td>
		<td class="owner">${ OWNER_LABELS[ d.owner ] }</td>
	</tr>`;
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
				<p><strong>${ worth } of ${ s.defects.length }</strong> <span class="muted">(Jev: 50% or more likely a reviewer asks for it; the table is ordered by it)</span></p></div>
		</div>
		<details><summary>What Jev was shown and asked</summary><pre>${ esc( JSON.stringify( { state: moduleState( s, width ), questions: moduleQuestions( s ) }, null, 2 ) ) }</pre></details>
	</div>`;
}

/** A module's measured comparison: its numbers, then the wireframe and pixel overlays under their scores. */
function comparison( s, width ) {
	const stat = ( label, value ) => `<div class="stat"><div class="muted small">${ label }</div><div class="value">${ value }</div></div>`;
	const stats = [
		stat( 'Height, Figma → page', `${ s.figmaHeight } → ${ s.pageHeight }px <span class="delta">${ signed( s.heightDelta ) }</span>` ),
		s.drift && stat( 'Median drift x/y', `${ signed( s.drift.dx ) }/${ signed( s.drift.dy ) }px` ),
	].filter( Boolean ).join( '' );
	// The images' own sizes (see wireframe-diff.js and pixel-diff.js), so the page doesn't shift as
	// they load and a selected defect scrolls to where it stays.
	const sizes = {
		wireframe: [ width, Math.ceil( Math.max( s.figmaHeight, s.pageHeight ) ) ],
		pixel: [ 3 * width + 2 * PANEL_GAP, s.pixelHeight ?? Math.round( s.figmaHeight ) ],
	};
	const figure = ( src, title, score, caption, kind ) => ( src
		? `<figure><figcaption><strong>${ title }${ undefined === score ? '' : ` ${ pct( score ) }` }</strong> <span class="muted">${ caption }</span></figcaption><a class="frame" data-image="${ kind }" href="${ esc( src ) }"><img src="${ esc( src ) }" width="${ sizes[ kind ][ 0 ] }" height="${ sizes[ kind ][ 1 ] }" alt="${ title } comparison for ${ esc( s.slug ) }" loading="lazy"></a></figure>`
		: '' );
	// Pixels first and full width: three panels side by side need the room.
	const images = figure( s.images.pixel, 'Pixels', s.pixelScore, 'Figma | page | diff', 'pixel' ) +
		figure( s.images.wireframe, 'Wireframe', s.wireframeScore, 'Figma red, page blue; thick boxes are unmatched', 'wireframe' );
	return `<div class="comparison"><div class="stats">${ stats }</div><div class="focus" hidden role="status"></div>${ images ? `<div class="images">${ images }</div>` : '' }</div>`;
}

function sectionCard( s, width ) {
	const tags = [ s.diagnosis ? bucket( s.diagnosis ) : 'undiagnosed', s.diagnosis && disagreements( s ).length ? 'disagree' : '' ].filter( Boolean );
	// With Jev, the defects a reviewer would most likely ask to fix come first.
	const rows = s.diagnosis ? [ ...s.defects ].sort( ( a, b ) => b.matters - a.matters ) : s.defects;
	const table = s.defects.length ? `<div class="scroll"><table>
		<thead><tr><th>ID</th>${ s.diagnosis ? '<th>Worth fixing</th>' : '' }<th>Where</th><th>Kind</th><th>Issue</th><th>Figma</th><th>Page</th><th>Difference</th><th>Owner</th></tr></thead>
		<tbody>${ rows.map( ( d ) => defectRow( d, s, width ) ).join( '' ) }</tbody>
	</table></div>` : `<p class="muted">${ 'dynamic' === s.verdict ? 'Live content: only its presence is checked.' : 'No defects.' }</p>`;
	return `<section class="card" id="s${ s.index }" data-tags="${ tags.join( ' ' ) }">
		<header>
			<h2><span class="muted">#${ s.index }</span> ${ esc( s.slug ) } <span class="tag tag-${ s.verdict }">${ s.verdict }</span></h2>
			<p class="muted">${ esc( s.figma ) }</p>
		</header>
		${ diagnosisPanel( s, width ) }
		<details${ s.defects.length ? ' open' : '' }><summary>Measured defects (${ s.defects.length })</summary>${ table }</details>
		${ comparison( s, width ) }
	</section>`;
}

/**
 * Runs in report.html: select a defect to outline it on its section's full images, Figma red
 * and page blue, dashed where it would be but isn't. Click or Enter on a row selects it (and
 * scrolls to the images), hovering previews, Escape clears, and #d-<id> selects on load.
 * Embedded as source, so it must stay self-contained.
 */
function selection() {
	const width = Number( document.body.dataset.width );
	const gap = Number( document.body.dataset.gap );
	const smooth = matchMedia( '(prefers-reduced-motion: reduce)' ).matches ? 'auto' : 'smooth';
	const clear = ( card, cls ) => card.querySelectorAll( `.frame .${ cls }` ).forEach( ( el ) => el.remove() );
	const mark = ( frame, cls, side, box, x, y, ghost ) => {
		const img = frame.querySelector( 'img' );
		// A lazy image not loaded yet has no size to place the outline by: redraw the
		// selection once it has (a #d-<id> link selects before images load).
		if ( ! img.naturalWidth ) {
			img.addEventListener( 'load', () => {
				const selected = frame.closest( '.card' ).querySelector( 'tr.selected' );
				if ( selected ) {
					highlight( selected, 'sel' );
				}
			}, { once: true } );
			return;
		}
		const el = document.createElement( 'span' );
		el.className = `hl hl-${ side } ${ cls }${ ghost ? ' ghost' : '' }`;
		Object.assign( el.style, {
			left: `${ ( x / img.naturalWidth ) * 100 }%`, top: `${ ( y / img.naturalHeight ) * 100 }%`,
			width: `${ Math.max( 0.3, ( box.w / img.naturalWidth ) * 100 ) }%`, height: `${ Math.max( 0.3, ( box.h / img.naturalHeight ) * 100 ) }%`,
		} );
		frame.appendChild( el );
	};
	// The section's bottom on each side, as a thin line.
	const bandBoxes = ( b ) => [ { x: 0, y: b.figma - 2, w: width, h: 4 }, { x: 0, y: b.page - 2, w: width, h: 4 } ];
	const highlight = ( row, cls ) => {
		const card = row.closest( '.card' );
		clear( card, cls );
		const loc = JSON.parse( row.dataset.loc );
		card.querySelectorAll( '.frame' ).forEach( ( frame ) => {
			const pixel = 'pixel' === frame.dataset.image;
			// The pixel image lines both sections up row by row, so its boxes are placed apart.
			const { figma, page } = pixel && loc.pixel ? loc.pixel : loc;
			if ( figma ) {
				mark( frame, cls, 'figma', figma, figma.x, figma.y, figma.ghost );
			}
			if ( page ) {
				mark( frame, cls, 'page', page, page.x + ( pixel ? width + gap : 0 ), page.y, page.ghost );
			}
			if ( loc.band && ! pixel ) {
				const [ f, p ] = bandBoxes( loc.band );
				mark( frame, cls, 'figma', f, f.x, f.y );
				mark( frame, cls, 'page', p, p.x, p.y );
			}
		} );
	};
	const select = ( row, scroll ) => {
		document.querySelectorAll( 'tr.selected' ).forEach( ( r ) => {
			r.classList.remove( 'selected' );
			clear( r.closest( '.card' ), 'sel' );
			r.closest( '.card' ).querySelector( '.focus' ).hidden = true;
		} );
		if ( ! row ) {
			history.replaceState( null, '', location.pathname );
			return;
		}
		row.classList.add( 'selected' );
		row.closest( 'details' ).open = true;
		highlight( row, 'sel' );
		const card = row.closest( '.card' );
		const focus = card.querySelector( '.focus' );
		focus.hidden = false;
		focus.innerHTML = '';
		const label = document.createElement( 'span' );
		label.textContent = `Showing ${ row.dataset.defect }: ${ row.dataset.summary }`;
		const back = document.createElement( 'button' );
		back.type = 'button';
		back.textContent = 'Back to defect';
		back.addEventListener( 'click', () => {
			row.scrollIntoView( { behavior: smooth, block: 'center' } );
			row.querySelector( 'button.select' ).focus();
		} );
		focus.append( label, back );
		history.replaceState( null, '', `#d-${ row.dataset.defect }` );
		if ( scroll ) {
			// The caption first, then the images below it; scroll-margin keeps it clear of the sticky filters.
			focus.scrollIntoView( { behavior: smooth, block: 'start' } );
		}
	};
	document.querySelectorAll( 'tr[data-defect]' ).forEach( ( row ) => {
		row.addEventListener( 'click', ( event ) => {
			if ( ! event.target.closest( 'a' ) ) {
				select( row, true );
			}
		} );
		row.addEventListener( 'mouseenter', () => highlight( row, 'hover' ) );
		row.addEventListener( 'mouseleave', () => clear( row.closest( '.card' ), 'hover' ) );
	} );
	document.addEventListener( 'keydown', ( event ) => {
		if ( 'Escape' === event.key ) {
			select( null );
		}
	} );
	const linked = location.hash.startsWith( '#d-' ) && document.getElementById( decodeURIComponent( location.hash.slice( 1 ) ) );
	if ( linked ) {
		const go = () => select( linked, true );
		const imgs = [ ...linked.closest( '.card' ).querySelectorAll( '.frame img' ) ];
		Promise.all( imgs.map( ( img ) => ( img.complete ? null : new Promise( ( resolve ) => img.addEventListener( 'load', resolve, { once: true } ) ) ) ) ).then( go );
		imgs.forEach( ( img ) => { img.loading = 'eager'; } );
	}
}

/** The overview: one row per module, rule verdict beside Jev's judgement. */
function overview( sections ) {
	const rows = sections.map( ( s ) => {
		const d = s.diagnosis;
		const flags = d ? disagreements( s ) : [];
		const jev = d
			? `<td><span class="minigauge"><span class="fill b-${ bucket( d ) }" style="width:${ ( d.correct * 100 ).toFixed( 1 ) }%"></span></span> ${ pct( d.correct ) }</td><td>${ s.defects.filter( ( x ) => x.matters >= 0.5 ).length } of ${ s.defects.length }</td>`
			: '<td colspan="2" class="muted">not diagnosed</td>';
		return `<tr><td><a href="#s${ s.index }"><span class="muted">#${ s.index }</span> ${ esc( s.slug ) }</a></td><td><span class="tag tag-${ s.verdict }">${ s.verdict }</span></td><td>${ s.defects.length }</td>${ jev }<td>${ flags.length ? `<span class="flag" title="${ esc( flags.join( '\n' ) ) }">⚑ ${ flags.length }</span>` : '' }</td></tr>`;
	} ).join( '' );
	return `<div class="card scroll"><table class="overview">
		<thead><tr><th>Module</th><th>Rules</th><th>Defects</th><th>Jev: accept</th><th>Worth fixing</th><th>Flags</th></tr></thead>
		<tbody>${ rows }</tbody>
	</table></div>`;
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
	const cards = report.sections;
	const count = ( tag ) => cards.filter( ( s ) => ( s.diagnosis ? [ bucket( s.diagnosis ), disagreements( s ).length ? 'disagree' : '' ] : [ 'undiagnosed' ] ).includes( tag ) ).length;
	const filters = [ [ 'all', 'All', cards.length ], [ 'disagree', 'Disagreements', count( 'disagree' ) ], ...Object.entries( BUCKET_LABELS ).map( ( [ k, label ] ) => [ k, label, count( k ) ] ), [ 'undiagnosed', 'Not diagnosed', count( 'undiagnosed' ) ] ]
		.filter( ( [ key, , n ] ) => 'all' === key || n )
		.map( ( [ key, label, n ] ) => `<button type="button" data-filter="${ key }" aria-pressed="${ 'all' === key }">${ label } <span>${ n }</span></button>` ).join( '' );
	const structure = report.structure.length ? `<section class="card"><header><h2>Structure</h2></header><ul>${ report.structure.map( ( d ) => `<li><span class="id">${ esc( d.id ) }</span> ${ esc( d.summary ) }</li>` ).join( '' ) }</ul></section>` : '';
	const warnings = report.warnings.map( ( w ) => `<p class="warning">${ esc( w ) }</p>` ).join( '' );
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual diff ${ esc( new URL( report.url ).pathname ) } ${ report.width }px</title>
<style>
:root { --bg: #f7f7f8; --card: #fff; --text: #1d1d20; --muted: #6b6b76; --line: #e3e3e8; --accent: #3056d3; --track: #ececf1;
	--structure: #8a1c7c; --content: #c0392b; --alignment: #b35c00; --layout: #1f5fbf; --visual: #6c3fc5; --ok: #1e7b45; --dynamic: #6b6b76; --review: #b58100; --flag: #b35c00; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #141417; --card: #1d1d22; --text: #ececf1; --muted: #9a9aa6; --line: #2e2e36; --accent: #7d9bff; --track: #2a2a31;
	--structure: #e07fd3; --content: #ff7b6e; --alignment: #ffae57; --layout: #74a7ff; --visual: #b596ff; --ok: #5fd08f; --dynamic: #9a9aa6; --review: #e8c15a; --flag: #ffae57; } }
:root[data-theme="dark"] { --bg: #141417; --card: #1d1d22; --text: #ececf1; --muted: #9a9aa6; --line: #2e2e36; --accent: #7d9bff; --track: #2a2a31;
	--structure: #e07fd3; --content: #ff7b6e; --alignment: #ffae57; --layout: #74a7ff; --visual: #b596ff; --ok: #5fd08f; --dynamic: #9a9aa6; --review: #e8c15a; --flag: #ffae57; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 64px; }
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
.bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; position: sticky; top: 0; background: var(--bg); padding: 8px 0; z-index: 1; }
.bar button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.bar button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.bar button span { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.card header p { margin: 4px 0 12px; }
.tag { display: inline-block; font-size: 12px; font-weight: 600; border-radius: 4px; padding: 0 6px; color: var(--card); background: var(--muted); vertical-align: 1px; }
${ [ 'structure', 'content', 'alignment', 'layout', 'visual', 'ok', 'dynamic' ].map( ( k ) => `.tag-${ k } { background: var(--${ k }); }` ).join( '\n' ) }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-top: 1px solid var(--line); }
th { font-size: 12px; color: var(--muted); font-weight: 600; border-top: 0; }
.overview td { vertical-align: middle; white-space: nowrap; }
.overview a { text-decoration: none; }
.id { font-family: ui-monospace, monospace; color: var(--muted); white-space: nowrap; }
.copy { font-style: italic; }
.thumbs { display: inline-flex; gap: 4px; }
.thumb { position: relative; display: inline-block; overflow: hidden; border: 1px solid var(--line); border-radius: 4px; background-color: #fff; background-repeat: no-repeat; vertical-align: middle; }
.frame { position: relative; display: block; }
.hl { position: absolute; box-sizing: border-box; border: 2px solid; border-radius: 2px; pointer-events: none; }
.hl-figma { border-color: #e62828; background: rgba(230, 40, 40, 0.12); }
.hl-page { border-color: #1e5ae6; background: rgba(30, 90, 230, 0.12); }
.hl.ghost { border-style: dashed; background: none; }
.frame .hl.sel { border-width: 3px; box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.8); }
.frame .hl.hover { opacity: 0.7; }
tr[data-defect] { cursor: pointer; }
tr[data-defect]:hover { background: var(--bg); }
tr.selected { background: var(--bg); box-shadow: inset 3px 0 0 var(--accent); }
button.select { font: inherit; font-family: ui-monospace, monospace; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline dotted; }
button.select:focus-visible, .focus button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.focus { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 12px; padding: 8px 12px; border: 1px solid var(--accent); border-radius: 8px; }
.focus[hidden] { display: none; }
.focus, tr[data-defect] { scroll-margin-top: 72px; }
.focus button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 999px; padding: 2px 10px; cursor: pointer; }
.swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--line); margin-right: 6px; vertical-align: -1px; }
.owner, .nowrap { white-space: nowrap; }
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
.images { display: grid; gap: 16px; align-items: start; }
@media (min-width: 900px) { .images figure + figure { max-width: 50%; } }
figure { margin: 0; }
figcaption { margin-bottom: 6px; }
figure img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
figcaption { font-size: 13px; }
[hidden] { display: none !important; }
</style>
</head>
<body data-width="${ report.width }" data-gap="${ PANEL_GAP }">
<main>
<h1>${ report.pass ? '<span class="tag tag-ok">PASS</span>' : '<span class="tag tag-content">FAIL</span>' } ${ esc( new URL( report.url ).pathname ) } at ${ report.width }px</h1>
<p class="muted"><a href="${ esc( report.url ) }">${ esc( report.url ) }</a> · run ${ esc( run ) }</p>
${ warnings }
${ metricsSummary( report ) }
${ overview( cards ) }
<div class="bar" role="group" aria-label="Show modules">${ filters }</div>
${ structure }
${ cards.map( ( s ) => sectionCard( s, report.width ) ).join( '\n' ) }
</main>
<script>
document.querySelectorAll( '[data-filter]' ).forEach( ( button ) => button.addEventListener( 'click', () => {
	const tag = button.dataset.filter;
	document.querySelectorAll( '[data-filter]' ).forEach( ( b ) => b.setAttribute( 'aria-pressed', String( b === button ) ) );
	document.querySelectorAll( '.card[data-tags]' ).forEach( ( card ) => { card.hidden = 'all' !== tag && ! card.dataset.tags.split( ' ' ).includes( tag ); } );
} ) );

(${ selection })();
</script>
</body>
</html>
`;
}
