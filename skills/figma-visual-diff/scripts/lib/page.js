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
	const styleOf = ( type, cs ) => {
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
			style.radius = String( Math.round( parseFloat( cs.borderTopLeftRadius ) || 0 ) );
			const width = parseFloat( cs.borderTopWidth ) || 0;
			if ( width > 0 && alpha( cs.borderTopColor ) > 0.01 ) {
				style.stroke = `${ hexOf( cs.borderTopColor ) }/${ Math.round( width * 10 ) / 10 }`;
			}
		}
		return style;
	};
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
		const push = ( type, r, text, cs, styleCs = cs, layout = null ) => {
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
			if ( cs ) {
				b.style = styleOf( type, styleCs );
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
			const children = ( childClip ) => {
				for ( const child of el.children ) {
					walk( child, false, textDone, childClip );
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
			const tag = el.tagName.toUpperCase();
			if ( /^(IMG|VIDEO|IFRAME|CANVAS)$/.test( tag ) ) {
				push( 'image', cut( r ) );
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
				push( bg.type, cut( bg.rect ) );
			}
			const border = [ 'Top', 'Right', 'Bottom', 'Left' ].some( ( s ) => parseFloat( cs[ `border${ s }Width` ] ) > 0 && alpha( cs[ `border${ s }Color` ] ) > 0.01 );
			if ( ! isRoot && r.width < vw - 1 && ( alpha( cs.backgroundColor ) > 0.01 || border || 'none' !== cs.boxShadow ) ) {
				push( 'surface', cut( r ), undefined, cs );
			}
			pseudoIcon( el, r, cut );
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
		return { slug, y: sr.top + window.scrollY, height: sr.height, boxes };
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
			return { x: r.left, y: r.top - rect.top, width: r.width, height: r.height };
		} ).filter( ( r ) => r.width > 0 && r.height > 0 );
		return { slug, y: rect.top + window.scrollY, height: rect.height, media };
	} );
}
