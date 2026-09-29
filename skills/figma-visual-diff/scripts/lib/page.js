/**
 * Code that runs inside the page. Each function here is serialised into page.evaluate(),
 * so it must stay self-contained: no imports, no references to module scope.
 */

/**
 * Runs in the page: the top-level sections, in document order, with their slugs.
 * Serialised into page.evaluate(), so it must stay self-contained.
 *
 * @param {Object} cfg Loaded config.
 * @return {Array<{el: Element, slug: string}>} Sections.
 */
export function detectSections( cfg ) {
	const patterns = ( cfg.slugPatterns || [] ).map( ( p ) => new RegExp( p ) );
	const slugOf = ( el ) => {
		for ( const re of patterns ) {
			for ( const c of el.classList ) {
				const m = re.exec( c );
				if ( m ) {
					return m[ 1 ];
				}
			}
		}
		return null;
	};
	const visible = ( el ) => el.getBoundingClientRect().height > 0;
	const root = document.querySelector( cfg.contentRoot || 'main' ) || document.body;
	let tops;
	if ( cfg.sectionSelector ) {
		tops = [ ...document.querySelectorAll( cfg.sectionSelector ) ];
	} else {
		const all = [ ...root.querySelectorAll( '[class]' ) ].filter( ( el ) => slugOf( el ) && visible( el ) );
		tops = all.filter( ( el ) => ! all.some( ( o ) => o !== el && o.contains( el ) ) );
		if ( ! tops.length ) {
			// No class convention matched: the content area's children are the sections.
			let area = root;
			while ( 1 === area.children.length ) {
				area = area.children[ 0 ];
			}
			tops = [ ...area.children ].filter( ( el ) => ! /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test( el.tagName ) );
		}
	}
	return tops.filter( visible ).map( ( el ) => ( {
		el,
		slug: slugOf( el ) || el.id || [ ...el.classList ][ 0 ] || el.tagName.toLowerCase(),
	} ) );
}

/**
 * Evaluate `fn( detectSections, config )` in the page. Composed as one expression so it
 * works under strict Content-Security-Policy, where injected script tags would not.
 *
 * @param {import('playwright').Page} page   Page.
 * @param {Function}                  fn     Browser function taking (detect, cfg).
 * @param {Object}                    config Loaded config.
 * @return {Promise<*>} Serialisable result.
 */
export function evaluateWithSections( page, fn, config ) {
	return page.evaluate( `(${ fn })(${ detectSections }, ${ JSON.stringify( config ) })` );
}

/** How much taller the viewport is for the second measurement in measureTwice(). */
const VIEWPORT_PROBE = 300;

/**
 * The page's boxes, each also measured at a taller viewport (`alt`, and the section's
 * `altHeight`): what moves with the viewport's height (a 100vh slide, a min-height hero)
 * isn't a design value, so its spacing isn't compared with Figma's.
 *
 * @param {import('playwright').Page} page   Loaded page.
 * @param {Object}                    config Loaded config.
 * @return {Promise<Array>} extractPageBoxes() sections, with `alt` on boxes found both times.
 */
export async function measureTwice( page, config ) {
	const sections = await evaluateWithSections( page, extractPageBoxes, config );
	const size = page.viewportSize();
	await page.setViewportSize( { width: size.width, height: size.height + VIEWPORT_PROBE } );
	// Let resize handlers (sliders, sticky scripts) settle.
	await page.waitForTimeout( 500 );
	const taller = await evaluateWithSections( page, extractPageBoxes, config );
	await page.setViewportSize( size );
	// Sections pair by position; if the count changed, nothing can be told apart.
	if ( taller.length !== sections.length ) {
		return sections;
	}
	sections.forEach( ( s, i ) => {
		const byKey = new Map( taller[ i ].boxes.map( ( b ) => [ b.key, b ] ) );
		s.altHeight = taller[ i ].height;
		for ( const b of s.boxes ) {
			const t = byKey.get( b.key );
			if ( t ) {
				b.alt = { x: t.x, y: t.y, w: t.w, h: t.h };
			}
		}
	} );
	return sections;
}

/**
 * Runs in the page: typed leaf boxes per top-level block, section-relative. Describes the
 * same primitives as the Figma extractor (lib/figma.js extractBoxes), so both sides compare.
 * Serialised into page.evaluate(), so it must stay self-contained.
 *
 * @param {Function} detect detectSections, passed in by evaluateWithSections.
 * @param {Object}   cfg    Loaded config.
 * @return {Array<{slug: string, y: number, height: number, boxes: Array}>} Sections.
 */
export function extractPageBoxes( detect, cfg ) {
	// Icons are at most this big, as in the Figma extractor.
	const ICON_MAX = 64;
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
	// Design tokens under the names and units the Figma extractor uses (lib/figma.js).
	const hexOf = ( css ) => {
		const m = /rgba?\(([^)]+)\)/.exec( css );
		if ( ! m ) {
			return undefined;
		}
		const [ red, green, blue, a = 1 ] = m[ 1 ].split( /[,\s/]+/ ).filter( Boolean ).map( parseFloat );
		const c = [ red, green, blue ].map( ( v ) => Math.round( v ).toString( 16 ).padStart( 2, '0' ) ).join( '' );
		return a < 0.99 ? `#${ c }${ Math.round( a * 255 ).toString( 16 ).padStart( 2, '0' ) }` : `#${ c }`;
	};
	// Four values (corners clockwise from top-left, sides clockwise from top) as one when they
	// agree, as the Figma extractor records them.
	const perSide = ( values ) => ( values.every( ( v ) => v === values[ 0 ] ) ? String( values[ 0 ] ) : values.join( ' ' ) );
	// A percentage radius is of the box. Radii that together overrun a side shrink by the same
	// factor, as CSS draws them, so a 999px or 50% pill reads as half its height.
	// Null for elliptical corners (two radii, or a percentage of a box that isn't square): Figma
	// has none, and no one number stands for them, so they aren't judged.
	const corners = ( cs, r ) => {
		const values = [ 'TopLeft', 'TopRight', 'BottomRight', 'BottomLeft' ].map( ( k ) => cs[ `border${ k }Radius` ] );
		const square = Math.abs( r.width - r.height ) <= 1;
		if ( values.some( ( v ) => /\s/.test( v.trim() ) || ( v.endsWith( '%' ) && parseFloat( v ) > 0 && ! square ) ) ) {
			return null;
		}
		const [ tl, tr, br, bl ] = values.map( ( v ) => ( v.endsWith( '%' ) ? parseFloat( v ) / 100 * r.width : parseFloat( v ) || 0 ) );
		const f = Math.min( 1, ...[ [ r.width, tl + tr ], [ r.width, bl + br ], [ r.height, tl + bl ], [ r.height, tr + br ] ].filter( ( [ , sum ] ) => sum > 0 ).map( ( [ side, sum ] ) => side / sum ) );
		return [ tl, tr, br, bl ].map( ( v ) => Math.round( v * f ) );
	};
	const strokeOf = ( cs ) => perSide( [ 'Top', 'Right', 'Bottom', 'Left' ].map( ( k ) => {
		const width = parseFloat( cs[ `border${ k }Width` ] ) || 0;
		return width > 0 && alpha( cs[ `border${ k }Color` ] ) > 0.01 ? `${ hexOf( cs[ `border${ k }Color` ] ) }/${ Math.round( width * 10 ) / 10 }` : 'none';
	} ) );
	// Rounding by clip-path: `inset( … round R )` and `circle()`, as a radius on every corner.
	// Only the whole box rounded evenly (`inset(0 round 8px)`) or a centred circle on a square box
	// is a radius; any other clip-path is a shape no radius stands for, so it's null.
	const clipRadius = ( c, r ) => {
		if ( 'none' === c.clipPath ) {
			return [ 0, 0, 0, 0 ];
		}
		const round = /^inset\(\s*0(?:px)?\s+round\s+([\d.]+)px\s*\)$/.exec( c.clipPath );
		if ( round ) {
			return new Array( 4 ).fill( Math.round( Math.min( parseFloat( round[ 1 ] ), Math.min( r.width, r.height ) / 2 ) ) );
		}
		const circle = /^circle\(\s*(?:50%|closest-side)?\s*(?:at\s+(?:50%|center)\s+(?:50%|center))?\s*\)$/.test( c.clipPath );
		return circle && Math.abs( r.width - r.height ) <= 1 ? new Array( 4 ).fill( Math.round( r.width / 2 ) ) : null;
	};
	const roundest = ( a, b ) => ( a && b ? a.map( ( v, i ) => Math.max( v, b[ i ] ) ) : null );
	const cornerPoints = ( q ) => [ [ q.left, q.top ], [ q.right, q.top ], [ q.right, q.bottom ], [ q.left, q.bottom ] ];
	// A wrapper that clips an image rounds each corner of it that it shares (overflow hidden on a
	// rounded card, the photo along its top): each corner is the roundest of them, as in Figma (see
	// extractBoxes). A wrapper with a border is larger than the image, so it is a surface of its
	// own, not part of this.
	const imageStyle = ( el, cs, r ) => {
		let radius = roundest( corners( cs, r ), clipRadius( cs, r ) );
		const own = cornerPoints( r );
		for ( let a = el.parentElement; a && a !== document.body; a = a.parentElement ) {
			const ac = getComputedStyle( a );
			if ( [ ac.overflowX, ac.overflowY ].every( ( o ) => 'visible' === o ) && 'none' === ac.clipPath ) {
				continue;
			}
			const ar = a.getBoundingClientRect();
			const theirs = cornerPoints( ar );
			const radii = roundest( corners( ac, ar ), clipRadius( ac, ar ) );
			const shares = theirs.map( ( [ x, y ], i ) => Math.abs( x - own[ i ][ 0 ] ) <= 1 && Math.abs( y - own[ i ][ 1 ] ) <= 1 );
			if ( shares.some( Boolean ) ) {
				radius = radius && radii ? radius.map( ( v, i ) => ( shares[ i ] ? Math.max( v, radii[ i ] ) : v ) ) : null;
			}
		}
		return radius ? { radius: perSide( radius ), stroke: strokeOf( cs ) } : { stroke: strokeOf( cs ) };
	};
	// A text's style is its runs': each token is the value on at least TEXT_MAJORITY of its
	// letters, else none, as Figma's is (see extractBoxes). A run is the text inside one element;
	// decoration isn't inherited but drawn through, so a run is underlined if any element around
	// it up to the section is.
	const TEXT_MAJORITY = 0.6;
	const caseOf = ( t ) => {
		const letters = t.match( /\p{L}/gu ) || [];
		if ( letters.length < 3 ) {
			return undefined;
		}
		const upper = ( c ) => c === c.toUpperCase() && c !== c.toLowerCase();
		const lower = ( c ) => c === c.toLowerCase() && c !== c.toUpperCase();
		const words = t.split( /\s+/ ).map( ( w ) => w.match( /\p{L}/gu ) || [] ).filter( ( w ) => w.length );
		if ( letters.every( upper ) ) {
			return 'upper';
		}
		if ( letters.every( lower ) ) {
			return 'lower';
		}
		if ( words.every( ( w ) => upper( w[ 0 ] ) && w.slice( 1 ).every( lower ) ) ) {
			return 'title';
		}
		return upper( letters[ 0 ] ) && letters.slice( 1 ).every( lower ) ? 'sentence' : 'mixed';
	};
	const textRunStyle = ( el, cs, root ) => {
		const runs = [];
		const walker = document.createTreeWalker( el, NodeFilter.SHOW_TEXT );
		for ( let t = walker.nextNode(); t; t = walker.nextNode() ) {
			const letters = ( t.textContent.match( /\S/g ) || [] ).length;
			const host = t.parentElement;
			// display: contents draws no box of its own, so checkVisibility() says hidden; its text shows.
			const hidden = host.checkVisibility && 'contents' !== getComputedStyle( host ).display && ! host.checkVisibility( { opacityProperty: true, visibilityProperty: true } );
			if ( ! letters || hidden ) {
				continue;
			}
			const c = getComputedStyle( host );
			let deco = 'none';
			for ( let a = host; a && a !== root.parentElement; a = a.parentElement ) {
				const line = getComputedStyle( a ).textDecorationLine;
				if ( /underline/.test( line ) || /line-through/.test( line ) ) {
					deco = /underline/.test( line ) ? 'underline' : 'strike';
					break;
				}
			}
			runs.push( { letters, caps: 'normal' !== c.fontVariantCaps, style: {
				font: c.fontFamily.split( ',' )[ 0 ].trim().replace( /^["']|["']$/g, '' ),
				size: String( Math.round( parseFloat( c.fontSize ) * 10 ) / 10 ),
				lh: 'normal' === c.lineHeight ? undefined : String( Math.round( parseFloat( c.lineHeight ) * 10 ) / 10 ),
				weight: String( c.fontWeight ),
				color: hexOf( c.color ),
				ls: String( 'normal' === c.letterSpacing ? 0 : Math.round( parseFloat( c.letterSpacing ) * 10 ) / 10 ),
				italic: 'normal' === c.fontStyle ? 'normal' : 'italic',
				deco,
			} } );
		}
		const total = runs.reduce( ( n, run ) => n + run.letters, 0 );
		const style = {};
		// Letters per value of each token: merged paragraphs are weighed together (see mergeTextRuns).
		const tally = {};
		for ( const key of [ 'font', 'size', 'lh', 'weight', 'color', 'ls', 'italic', 'deco' ] ) {
			const weights = new Map();
			for ( const run of runs ) {
				weights.set( run.style[ key ], ( weights.get( run.style[ key ] ) || 0 ) + run.letters );
			}
			tally[ key ] = [ ...weights ].filter( ( [ v ] ) => undefined !== v );
			const [ best, most ] = [ ...weights ].reduce( ( a, b ) => ( b[ 1 ] > a[ 1 ] ? b : a ), [ undefined, -1 ] );
			if ( undefined !== best && total && most / total >= TEXT_MAJORITY ) {
				style[ key ] = best;
			}
		}
		style.align = styleOf( 'text', cs ).align;
		// innerText is the text as drawn, text-transform applied; small caps it doesn't show.
		const rendered = runs.some( ( run ) => run.caps ) ? undefined : caseOf( el.innerText || '' );
		if ( rendered ) {
			style.case = rendered;
		}
		return { style, tally: { ...tally, letters: total, text: runs.some( ( run ) => run.caps ) ? null : el.innerText || '' } };
	};
	const styleOf = ( type, cs, r ) => {
		const style = {};
		if ( 'text' === type ) {
			style.font = cs.fontFamily.split( ',' )[ 0 ].trim().replace( /^["']|["']$/g, '' );
			style.size = String( Math.round( parseFloat( cs.fontSize ) * 10 ) / 10 );
			if ( 'normal' !== cs.lineHeight ) {
				style.lh = String( Math.round( parseFloat( cs.lineHeight ) * 10 ) / 10 );
			}
			style.weight = String( cs.fontWeight );
			style.color = hexOf( cs.color );
			// As Figma names it: start and end follow the writing direction.
			const rtl = 'rtl' === cs.direction;
			style.align = { start: rtl ? 'right' : 'left', end: rtl ? 'left' : 'right', left: 'left', right: 'right', center: 'center', '-webkit-center': 'center', justify: 'justify' }[ cs.textAlign ];
		} else {
			if ( alpha( cs.backgroundColor ) > 0.01 ) {
				style.fill = hexOf( cs.backgroundColor );
			}
			const radius = corners( cs, r );
			if ( radius ) {
				style.radius = perSide( radius );
			}
			style.stroke = strokeOf( cs );
		}
		return style;
	};
	// Elements that only mark up words (a link, emphasis), inline wherever the layout puts them.
	const PHRASING = /^(A|ABBR|B|BDI|BDO|CITE|CODE|DFN|EM|I|KBD|MARK|Q|S|SAMP|SMALL|SPAN|STRONG|SUB|SUP|TIME|U|VAR)$/i;
	const inlineOnly = ( el ) => [ ...el.children ].every( ( c ) => 'BR' === c.tagName || getComputedStyle( c ).display.startsWith( 'inline' ) && ! /^(IMG|SVG|VIDEO|IFRAME)$/i.test( c.tagName ) );
	// A pseudo-element has no box to read. So a stand-in with its computed style takes its
	// place, the pseudo-element hidden meanwhile, and is measured: it lands wherever the layout
	// puts the pseudo-element (centred in a flex button, after a list item's padding, moved by
	// a transform), without guessing how.
	const hidePseudo = document.createElement( 'style' );
	hidePseudo.textContent = '[data-fvd-pseudo="::before"]::before,[data-fvd-pseudo="::after"]::after{display:none!important}';
	const pseudoRect = ( el, which, s ) => {
		const stand = document.createElement( 'span' );
		for ( const prop of s ) {
			stand.style.setProperty( prop, s.getPropertyValue( prop ) );
		}
		stand.style.content = 'normal';
		el.setAttribute( 'data-fvd-pseudo', which );
		if ( '::before' === which ) {
			el.prepend( stand );
		} else {
			el.append( stand );
		}
		const r = stand.getBoundingClientRect();
		stand.remove();
		el.removeAttribute( 'data-fvd-pseudo' );
		return r;
	};

	// Each box names its element and place among that element's boxes (`key`), the same
	// between calls on this page: boxes measured twice (measureTwice) are matched by it.
	const ids = window.fvdIds || ( window.fvdIds = { next: 0, of: new WeakMap() } );
	const idOf = ( el ) => ( ids.of.has( el ) ? ids.of.get( el ) : ids.of.set( el, ids.next++ ).get( el ) );
	let owner = null;

	document.head.appendChild( hidePseudo );
	const sections = detect( cfg ).map( ( { el: sec, slug } ) => {
		const sr = sec.getBoundingClientRect();
		const boxes = [];
		// Every line the section draws, whatever draws it: a border only one side has may be drawn
		// another way on the other (a divider element, a ::after rule, a box-shadow ring), so both
		// sides record them all (see extractBoxes' L lines).
		const lines = [];
		const THIN = 3;
		// Only the part a clipping ancestor leaves visible is drawn (walk sets lineClip).
		let lineClip = null;
		const lineAt = ( x, y, w, h ) => {
			const q = clipTo( { left: x, top: y, width: Math.max( 1, w ), height: Math.max( 1, h ) }, lineClip );
			if ( q ) {
				lines.push( { x: Math.round( q.left - sr.left ), y: Math.round( q.top - sr.top ), w: Math.max( 1, Math.round( q.width ) ), h: Math.max( 1, Math.round( q.height ) ) } );
			}
		};
		// The straight run of one side of a box (0 top, 1 right, 2 bottom, 3 left), `t` px thick and
		// clear of its rounded corners: a circle's outline only touches its box's edges. None when the
		// rounding leaves no straight part, or isn't known (elliptical corners).
		const side = ( q, s, t, radii ) => {
			if ( ! radii ) {
				return;
			}
			const [ tl, tr, br, bl ] = radii;
			const len = ( 0 === s || 2 === s ? q.width : q.height ) - [ tl + tr, tr + br, bl + br, tl + bl ][ s ];
			if ( len >= 1 ) {
				lineAt( ...[ [ q.left + tl, q.top, len, t ], [ q.left + q.width - t, q.top + tr, t, len ], [ q.left + bl, q.top + q.height - t, len, t ], [ q.left, q.top + tl, t, len ] ][ s ] );
			}
		};
		const ring = ( q, radii ) => [ 0, 1, 2, 3 ].forEach( ( s ) => side( q, s, 1, radii ) );
		// A shadow with (almost) no blur, offset or spread a few px, draws a rule on the sides it's
		// offset to (inside the box for an inset one, so on the opposite edge), or round the box when
		// it's spread. One offset further draws away from the edge, so it isn't that edge's line.
		const shadowEdges = ( shadow, q, radii ) => 'none' !== shadow && shadow.split( /,(?![^(]*\))/ ).forEach( ( one ) => {
			const [ x = 0, y = 0, blur = 0, spread = 0 ] = ( one.match( /-?[\d.]+px/g ) || [] ).map( parseFloat );
			if ( alpha( one ) <= 0.01 || Math.abs( blur ) > 2 || Math.max( Math.abs( x ), Math.abs( y ) ) > THIN || Math.abs( spread ) > THIN ) {
				return;
			}
			const inset = /\binset\b/.test( one );
			const sides = spread > 0 ? [ 0, 1, 2, 3 ] : [ y < 0 && 0, x > 0 && 1, y > 0 && 2, x < 0 && 3 ].filter( ( v ) => false !== v );
			sides.map( ( s ) => ( inset ? ( s + 2 ) % 4 : s ) ).forEach( ( s ) => side( q, s, 1, radii ) );
		} );
		const drawn = ( c, q, tag = '' ) => {
			const width = ( k ) => ( parseFloat( c[ `border${ k }Width` ] ) > 0 && alpha( c[ `border${ k }Color` ] ) > 0.01 ? parseFloat( c[ `border${ k }Width` ] ) : 0 );
			const [ top, right, bottom, left ] = [ 'Top', 'Right', 'Bottom', 'Left' ].map( width );
			const radii = corners( c, q );
			[ top, right, bottom, left ].forEach( ( w, s ) => w > 0 && side( q, s, w, radii ) );
			shadowEdges( c.boxShadow, q, radii );
			// An outline draws round the box, outside it by its offset: within a few px, it's the edge's.
			if ( 'none' !== c.outlineStyle && parseFloat( c.outlineWidth ) > 0 && alpha( c.outlineColor ) > 0.01 && Math.abs( parseFloat( c.outlineOffset ) || 0 ) <= THIN ) {
				ring( q, radii );
			}
			// A no-repeat gradient a few px thick is a rule painted as a background: where it sits.
			if ( /gradient\(/.test( c.backgroundImage ) && ! /,/.test( c.backgroundImage.replace( /\([^()]*\)/g, '' ).replace( /\([^()]*\)/g, '' ) ) && 'no-repeat' === c.backgroundRepeat ) {
				const size = ( v, box ) => ( v.endsWith( '%' ) ? parseFloat( v ) / 100 * box : parseFloat( v ) );
				const [ sw = '100%', sh = sw ] = c.backgroundSize.split( /\s+/ );
				const [ w, h ] = [ size( sw, q.width ), size( sh, q.height ) ];
				if ( w > 0 && h > 0 && Math.min( w, h ) <= THIN ) {
					const [ px, py = '50%' ] = c.backgroundPosition.split( /\s+(?![^(]*\))/ );
					lineAt( q.left + bgOffset( px, q.width, w ), q.top + bgOffset( py, q.height, h ), w, h );
				}
			}
			// A thin box that paints anything is a rule.
			const paints = alpha( c.backgroundColor ) > 0.01 || 'none' !== c.backgroundImage || /^(IMG|SVG|HR|CANVAS)$/i.test( tag );
			if ( paints && Math.min( q.width, q.height ) <= THIN && Math.max( q.width, q.height ) >= 8 ) {
				lineAt( q.left, q.top, q.width, q.height );
			}
		};
		const drawnLines = ( el, cs, r ) => {
			drawn( cs, r, el.tagName );
			// An element that clips its overflow clips its own ::before and ::after too.
			if ( [ cs.overflowX, cs.overflowY ].some( ( o ) => 'visible' !== o ) ) {
				const own = clipTo( r, lineClip );
				lineClip = own ? { left: own.left, top: own.top, right: own.left + own.width, bottom: own.top + own.height } : { left: 0, top: 0, right: 0, bottom: 0 };
			}
			// A ::before or ::after that paints (a rule, a divider): measured where the layout puts it.
			for ( const which of [ '::before', '::after' ] ) {
				const ps = getComputedStyle( el, which );
				if ( 'none' === ps.content || 'normal' === ps.content || 'none' === ps.display || 'visible' !== ps.visibility || Number( ps.opacity ) < 0.01 ) {
					continue;
				}
				const paints = alpha( ps.backgroundColor ) > 0.01 || 'none' !== ps.backgroundImage || 'none' !== ps.boxShadow || [ 'Top', 'Right', 'Bottom', 'Left' ].some( ( k ) => parseFloat( ps[ `border${ k }Width` ] ) > 0 );
				if ( paints ) {
					drawn( ps, pseudoRect( el, which, ps ) );
				}
			}
		};
		const push = ( type, r, text, cs, styleCs = cs, layout = null, style = null ) => {
			if ( ! r ) {
				return;
			}
			const x = r.left - sr.left;
			if ( r.width < 1 || r.height < 1 || x >= vw || x + r.width <= 0 ) {
				return;
			}
			const b = { type, x: Math.round( x ), y: Math.round( r.top - sr.top ), w: Math.round( r.width ), h: Math.round( r.height ) };
			const own = `${ idOf( owner ) }:${ type }:`;
			b.key = own + boxes.filter( ( o ) => o.key.startsWith( own ) ).length;
			if ( r.clipped ) {
				b.clipped = true;
			}
			if ( undefined !== text ) {
				b.text = text;
				// The text element's own vertical margins, as Figma records its Text Block's padding.
				b.mt = Math.round( parseFloat( cs.marginTop ) || 0 );
				b.mb = Math.round( parseFloat( cs.marginBottom ) || 0 );
			}
			if ( style ) {
				b.style = style;
			} else if ( cs ) {
				b.style = styleOf( type, styleCs, r );
			}
			// A text's style by its runs; the first character's stays, for Figma files from before
			// runs were read (see styleDiffs).
			if ( 'text' === type && owner ) {
				const { style: runStyle, tally } = textRunStyle( owner, cs, sec );
				b.style0 = b.style;
				b.style = runStyle;
				b.tally = tally;
			}
			// A text's layout box, as Figma records its text layer's: where its lines may run,
			// the element's content box (a list item's padding holds its bullet, not its text).
			if ( layout ) {
				const inset = ( side ) => ( parseFloat( cs[ `padding${ side }` ] ) || 0 ) + ( parseFloat( cs[ `border${ side }Width` ] ) || 0 );
				b.lx = Math.round( layout.left + inset( 'Left' ) - sr.left );
				b.lw = Math.round( layout.width - inset( 'Left' ) - inset( 'Right' ) );
			}
			boxes.push( b );
		};
		// Icon-font glyphs and masked icons drawn by ::before/::after (e.g. list checkmarks).
		const pseudoIcon = ( el, r, cut ) => {
			for ( const which of [ '::before', '::after' ] ) {
				const s = getComputedStyle( el, which );
				if ( 'none' === s.content || 'normal' === s.content ) {
					continue;
				}
				const w = parseFloat( s.width );
				const h = parseFloat( s.height );
				if ( ! ( w > 0 && h > 0 && w <= ICON_MAX && h <= ICON_MAX ) ) {
					// An icon-font glyph with no explicit size (e.g. an arrow button): the empty,
					// icon-sized element is the icon's box.
					if ( '""' !== s.content && ! el.textContent.trim() && ! el.children.length && r.width <= ICON_MAX && r.height <= ICON_MAX ) {
						push( 'icon', cut( r ) );
						return;
					}
					continue;
				}
				push( 'icon', cut( pseudoRect( el, which, s ) ) );
			}
		};
		// The part of a rect left visible inside a clip (an ancestor with overflow hidden), or
		// null when none is: a carousel's off-screen slides are in the DOM but not on screen.
		const clipTo = ( q, clip ) => {
			if ( ! clip ) {
				return q;
			}
			const left = Math.max( q.left, clip.left );
			const top = Math.max( q.top, clip.top );
			const right = Math.min( q.left + q.width, clip.right );
			const bottom = Math.min( q.top + q.height, clip.bottom );
			// More than a pixel hidden counts; line boxes and edges differ by fractions of one.
			const clipped = left > q.left + 1 || top > q.top + 1 || right < q.left + q.width - 1 || bottom < q.top + q.height - 1;
			return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top, clipped } : null;
		};
		// Where a no-repeat background of an explicit size sits in its box: `Npx`, `N%` or
		// `calc(N% - Mpx)`, per CSS background-position (a percentage of the leftover space).
		const bgOffset = ( value, box, size ) => {
			const m = /^calc\(\s*([\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/.exec( value );
			if ( m ) {
				return ( box - size ) * m[ 1 ] / 100 + ( '-' === m[ 2 ] ? -1 : 1 ) * Number( m[ 3 ] );
			}
			return value.endsWith( '%' ) ? ( box - size ) * parseFloat( value ) / 100 : parseFloat( value ) || 0;
		};
		// A background drawn smaller than its box (a select's chevron, a bullet) is an icon or
		// image inside the box, not the box being an image.
		const background = ( cs, r ) => {
			const [ bw, bh ] = cs.backgroundSize.split( ' ' ).map( parseFloat );
			if ( 'no-repeat' !== cs.backgroundRepeat || ! ( bw > 0 ) || ! ( ( bh || bw ) > 0 ) || ( bw >= r.width - 1 && ( bh || bw ) >= r.height - 1 ) ) {
				return { type: 'image', rect: r };
			}
			const h = bh || bw;
			const [ px, py ] = cs.backgroundPosition.split( /\s+(?![^(]*\))/ );
			const rect = { left: r.left + bgOffset( px, r.width, bw ), top: r.top + bgOffset( py ?? '50%', r.height, h ), width: bw, height: h };
			return { type: bw <= ICON_MAX && h <= ICON_MAX ? 'icon' : 'image', rect };
		};
		// textDone: an ancestor already emitted this text; still collect icons and media inside it.
		const walk = ( el, isRoot, textDone = false, clip = null ) => {
			owner = el;
			const cs = getComputedStyle( el );
			// Children whose text this element already emitted (see ownRun below).
			const consumed = new Set();
			const children = ( childClip ) => {
				for ( const child of el.children ) {
					walk( child, false, textDone || consumed.has( child ), childClip );
				}
			};
			// `display: contents` draws no box of its own, only its children.
			if ( 'contents' === cs.display ) {
				children( clip );
				return;
			}
			if ( el.checkVisibility && ! el.checkVisibility( { opacityProperty: true, visibilityProperty: true } ) ) {
				return;
			}
			const r = el.getBoundingClientRect();
			// Screen-reader-only content (clipped to nothing, or to a 1px box) isn't on screen.
			const clips = [ cs.overflowX, cs.overflowY ].some( ( o ) => 'visible' !== o );
			if ( /inset\(\s*50%/.test( cs.clipPath ) || /^rect/.test( cs.clip ) || ( r.width <= 1 && r.height <= 1 && clips ) ) {
				return;
			}
			// A zero-size box that doesn't clip (an anchor for positioned children) shows only them.
			if ( r.width <= 1 && r.height <= 1 ) {
				children( clip );
				return;
			}
			const cut = ( q ) => clipTo( q, clip );
			lineClip = clip;
			drawnLines( el, cs, r );
			const tag = el.tagName.toUpperCase();
			if ( /^(IMG|VIDEO|IFRAME|CANVAS)$/.test( tag ) ) {
				push( 'image', cut( r ), undefined, undefined, undefined, null, imageStyle( el, cs, r ) );
				return;
			}
			if ( 'SVG' === tag ) {
				push( 'icon', cut( r ) );
				return;
			}
			if ( iconClass.test( el.className ) && ! el.textContent.trim() ) {
				push( 'icon', cut( r ) );
				return;
			}
			if ( /url\(/.test( cs.backgroundImage ) ) {
				const bg = background( cs, r );
				// A background filling its box has that box's corners and border.
				push( bg.type, cut( bg.rect ), undefined, undefined, undefined, null, 'image' === bg.type && bg.rect === r ? imageStyle( el, cs, r ) : null );
			}
			const border = [ 'Top', 'Right', 'Bottom', 'Left' ].some( ( s ) => parseFloat( cs[ `border${ s }Width` ] ) > 0 && alpha( cs[ `border${ s }Color` ] ) > 0.01 );
			if ( ! isRoot && r.width < vw - 1 && ( alpha( cs.backgroundColor ) > 0.01 || border || 'none' !== cs.boxShadow ) ) {
				push( 'surface', cut( r ), undefined, cs );
			}
			pseudoIcon( el, r, cut );
			// A select draws its chosen option ("Select one"), which is no text node of its own.
			// (A listbox, multiple or size > 1, draws its option rows, walked like any content.)
			if ( 'SELECT' === tag && ! el.multiple && el.size <= 1 ) {
				const option = el.selectedOptions[ 0 ];
				const text = option?.label.trim();
				if ( ! textDone && text ) {
					// Its style is the shown option's, not every option's text together.
					owner = option;
					const font = document.createElement( 'canvas' ).getContext( '2d' );
					font.font = cs.font;
					const lineHeight = parseFloat( cs.lineHeight ) || parseFloat( cs.fontSize ) * 1.2;
					const left = r.left + parseFloat( cs.borderLeftWidth ) + parseFloat( cs.paddingLeft );
					push( 'text', cut( { left, top: r.top + ( r.height - lineHeight ) / 2, width: Math.min( font.measureText( text ).width, r.right - left ), height: lineHeight } ), text, cs );
				}
				return;
			}
			// Text of its own beside a box that isn't inline (a checkbox label: the input, then
			// "I have read the <a>Privacy Policy</a>", in a flex row that makes every child a
			// block): the words and the phrasing elements around them are one text.
			const words = ( n ) => 3 === n.nodeType || ( 1 === n.nodeType && PHRASING.test( n.tagName ) && inlineOnly( n ) && n.checkVisibility( { opacityProperty: true, visibilityProperty: true } ) );
			const ownRun = ! textDone && ! inlineOnly( el ) && [ ...el.childNodes ].some( ( n ) => 3 === n.nodeType && n.textContent.trim() )
				? [ ...el.childNodes ].filter( ( n ) => words( n ) && n.textContent.trim() )
				: [];
			if ( ownRun.length ) {
				// Line boxes, as the inline-text path below measures them.
				const lineHeight = parseFloat( cs.lineHeight );
				const rects = ownRun.flatMap( ( n ) => {
					const part = document.createRange();
					part.selectNodeContents( n );
					return [ ...part.getClientRects() ];
				} ).filter( ( q ) => q.width > 0 && q.height > 0 ).map( ( q ) => {
					const grow = lineHeight > q.height ? ( lineHeight - q.height ) / 2 : 0;
					return { left: q.left, right: q.right, top: q.top - grow, bottom: q.bottom + grow };
				} );
				if ( rects.length ) {
					const left = Math.min( ...rects.map( ( q ) => q.left ) );
					const top = Math.min( ...rects.map( ( q ) => q.top ) );
					// The spaces between the parts are drawn too ("Terms <a>…</a> <a>…</a>").
					const nodes = [ ...el.childNodes ];
					const span = nodes.slice( nodes.indexOf( ownRun[ 0 ] ), nodes.indexOf( ownRun[ ownRun.length - 1 ] ) + 1 ).filter( words );
					const text = span.map( ( n ) => n.textContent ).join( '' ).replace( /\s+/g, ' ' ).trim();
					const first = 3 === ownRun[ 0 ].nodeType ? el : ownRun[ 0 ];
					push( 'text', cut( { left, top, width: Math.max( ...rects.map( ( q ) => q.right ) ) - left, height: Math.max( ...rects.map( ( q ) => q.bottom ) ) - top } ), text, cs, getComputedStyle( first ), r );
					ownRun.filter( ( n ) => 1 === n.nodeType ).forEach( ( n ) => consumed.add( n ) );
				}
			}
			if ( ! textDone && el.textContent.trim() && inlineOnly( el ) ) {
				const range = document.createRange();
				range.selectNodeContents( el );
				// Range rects are glyph boxes; Figma measures text by its line boxes. Grow each
				// line to the line-height around its glyphs, as the browser lays the line out.
				const lineHeight = parseFloat( cs.lineHeight );
				const rects = [ ...range.getClientRects() ].filter( ( q ) => q.width > 0 && q.height > 0 ).map( ( q ) => {
					const grow = lineHeight > q.height ? ( lineHeight - q.height ) / 2 : 0;
					return { left: q.left, right: q.right, top: q.top - grow, bottom: q.bottom + grow };
				} );
				if ( rects.length ) {
					const left = Math.min( ...rects.map( ( q ) => q.left ) );
					const top = Math.min( ...rects.map( ( q ) => q.top ) );
					// Figma styles a text layer by its first character, so the page does too: the
					// element around the first visible text ("2026" in <p><b>2026</b> | Dallas</p>).
					const walker = document.createTreeWalker( el, NodeFilter.SHOW_TEXT, { acceptNode: ( t ) => ( t.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP ) } );
					const first = walker.nextNode();
					push( 'text', cut( { left, top, width: Math.max( ...rects.map( ( q ) => q.right ) ) - left, height: Math.max( ...rects.map( ( q ) => q.bottom ) ) - top } ), el.innerText || el.textContent, cs, first ? getComputedStyle( first.parentElement ) : cs, r );
				}
				textDone = true;
			}
			// Content outside a box that clips its overflow (a carousel's track) can't be seen.
			const inner = clips ? ( clipTo( r, clip ) ?? { left: 0, top: 0, width: 0, height: 0 } ) : null;
			children( clips ? { left: inner.left, top: inner.top, right: inner.left + inner.width, bottom: inner.top + inner.height } : clip );
		};
		walk( sec, true );
		return { slug, y: sr.top + window.scrollY, height: sr.height, boxes, lines };
	} );
	hidePseudo.remove();
	return sections;
}

/**
 * Runs in the page: each top-level section's position and the media inside it, for the
 * pixel diff to crop the screenshot and mask images.
 *
 * @param {Function} detect detectSections, passed in by evaluateWithSections.
 * @param {Object}   cfg    Loaded config.
 * @return {Array<{slug: string, y: number, height: number, media: Array}>} Sections.
 */
export function sectionMedia( detect, cfg ) {
	return detect( cfg ).map( ( { el, slug } ) => {
		const rect = el.getBoundingClientRect();
		const media = [ ...el.querySelectorAll( 'img, video, iframe, picture' ) ].map( ( m ) => {
			const r = m.getBoundingClientRect();
			// Loaded and shown as far as the page knows (a slider's other slides sit at opacity
			// 0), so the screenshot should draw it.
			const loaded = 'IMG' === m.tagName && m.complete && m.naturalWidth > 0 && m.checkVisibility( { opacityProperty: true, visibilityProperty: true } );
			return { x: r.left, y: r.top - rect.top, width: r.width, height: r.height, loaded };
		} ).filter( ( r ) => r.width > 0 && r.height > 0 );
		return { slug, y: rect.top + window.scrollY, height: rect.height, media };
	} );
}
