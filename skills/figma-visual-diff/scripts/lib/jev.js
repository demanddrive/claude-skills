/**
 * Diagnosis: Jev, TypeSafe's System One model, judges what the measurements can't: which
 * differences a reviewer would actually ask to fix, and whether they'd accept the module.
 *
 * The rules already say what differs, by how much and who fixes it. What they can't say is
 * whether an image 14px wider, a 2-shade grey or a 4px padding matters. So Jev gets one
 * narrow question per defect ("would a reviewer ask for this to be fixed?") and one per
 * module ("would they accept it?"), all in one request per module: it evaluates the questions
 * in parallel and independently, and answers with calibrated probabilities, the same for the
 * same input, so they can be tracked from run to run.
 *
 * Its answers are only as good as its input, so the state is built for judging: structured,
 * only what bears on the question, and with the arithmetic done, since Jev is weak at it:
 * absolute and relative differences, how much of the section an element covers, perceptual
 * colour distance (ΔE), weights by name.
 *
 * The default provider is OpenCode Zen (OPENCODE_API_KEY, free model jev-1.13-free). The
 * config's `jev` names another: any endpoint that speaks TypeSafe's System One API
 * (https://docs.typesafe.ai/), such as TypeSafe itself or a local router. Keys are read from
 * the environment variable the provider names, never from config files.
 */

/** The default provider. */
export const ZEN = { url: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free', keyEnv: 'OPENCODE_API_KEY' };

/** A module this likely to be accepted is signed off; this unlikely, rejected. The same cut-offs mark a defect as mattering or negligible. */
export const SIGN_OFF = 0.8;
export const REJECT = 0.2;

/**
 * Where to send requests: the config's provider, or OpenCode Zen.
 *
 * @param {Object|null} provider The config's `jev`: { url, model, keyEnv }, or null for Zen.
 * @param {Object}      env      Environment variables, where the key is read from.
 * @param {string}      model    Model override (--jev-model).
 * @return {{url: string, model: string, keyEnv: string, key: string|undefined}} The key is
 *   undefined when its environment variable isn't set.
 * @throws {Error} When a custom provider leaves out its url or keyEnv.
 */
export function jevEndpoint( provider, env, model ) {
	const chosen = provider ?? ZEN;
	if ( ! chosen.url || ! chosen.keyEnv ) {
		throw new Error( 'The config\'s "jev" provider needs "url" and "keyEnv" (the environment variable holding its key); "model" defaults to jev-1.13-free.' );
	}
	const { url, keyEnv } = chosen;
	return { url, keyEnv, model: model || chosen.model || ZEN.model, key: env[ keyEnv ] };
}

const pct = ( n ) => `${ Math.round( n * 100 ) }%`;
const px = ( n ) => `${ Math.round( n ) }px`;
const signed = ( n, unit = 'px' ) => `${ n > 0 ? '+' : '' }${ Math.round( n * 10 ) / 10 }${ unit }`;

/** A change as "32px less than 104px (31%)", so Jev needn't compute how big it is. */
function change( from, to, unit = 'px' ) {
	const diff = to - from;
	const rel = from ? ` (${ pct( Math.abs( diff ) / from ) } ${ diff > 0 ? 'more' : 'less' })` : '';
	return `${ from }${ unit } in Figma, ${ to }${ unit } on the page: ${ signed( diff, unit ) }${ rel }`;
}

const WEIGHTS = { 100: 'thin', 200: 'extra light', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extra bold', 900: 'black' };

/** CIE Lab of a #rrggbb colour (D65), for a perceptual distance. */
function lab( hex ) {
	const [ r, g, b ] = ( hex.match( /[0-9a-f]{2}/gi ) || [] ).slice( 0, 3 ).map( ( c ) => {
		const v = parseInt( c, 16 ) / 255;
		return v > 0.04045 ? ( ( v + 0.055 ) / 1.055 ) ** 2.4 : v / 12.92;
	} );
	const xyz = [ ( r * 0.4124 + g * 0.3576 + b * 0.1805 ) / 0.95047, r * 0.2126 + g * 0.7152 + b * 0.0722, ( r * 0.0193 + g * 0.1192 + b * 0.9505 ) / 1.08883 ]
		.map( ( t ) => ( t > 0.008856 ? Math.cbrt( t ) : 7.787 * t + 16 / 116 ) );
	return [ 116 * xyz[ 1 ] - 16, 500 * ( xyz[ 0 ] - xyz[ 1 ] ), 200 * ( xyz[ 1 ] - xyz[ 2 ] ) ];
}

/**
 * How far apart two colours look: ΔE (CIE76), with alpha when either is translucent.
 *
 * @param {string} a #rrggbb(aa).
 * @param {string} b #rrggbb(aa).
 * @return {string}
 */
export function colourDistance( a, b ) {
	const [ la, lb ] = [ lab( a ), lab( b ) ];
	const delta = Math.hypot( la[ 0 ] - lb[ 0 ], la[ 1 ] - lb[ 1 ], la[ 2 ] - lb[ 2 ] );
	const alpha = ( h ) => ( 9 === h.length ? parseInt( h.slice( 7 ), 16 ) / 255 : 1 );
	const opacity = alpha( a ) !== alpha( b ) ? `; opacity ${ pct( alpha( a ) ) } in Figma, ${ pct( alpha( b ) ) } on the page` : '';
	return `${ a } in Figma, ${ b } on the page: ΔE ${ delta.toFixed( 1 ) } (about 2.3 is the smallest difference an eye notices side by side; above 10 reads as a different colour)${ opacity }`;
}

/** One design token's difference, spelled out for judging. */
function tokenChange( key, figma, page ) {
	if ( 'color' === key || 'fill' === key ) {
		return colourDistance( figma, page );
	}
	if ( 'stroke' === key ) {
		if ( 'none' === page ) {
			return `${ figma.replace( '/', ', ' ) }px wide in Figma; no border on the page`;
		}
		const [ [ ca, wa ], [ cb, wb ] ] = [ figma.split( '/' ), page.split( '/' ) ];
		return `${ Number( wa ) === Number( wb ) ? `${ wa }px wide on both; ` : `${ change( Number( wa ), Number( wb ) ) }; ` }colour ${ colourDistance( ca, cb ) }`;
	}
	if ( 'weight' === key ) {
		return `${ WEIGHTS[ figma ] ?? figma } (${ figma }) in Figma, ${ WEIGHTS[ page ] ?? page } (${ page }) on the page`;
	}
	if ( 'font' === key || 'align' === key ) {
		return `${ figma } in Figma, ${ page } on the page`;
	}
	return change( Number( figma ), Number( page ) );
}

const TOKEN_NAMES = { font: 'font family', size: 'font size', lh: 'line height', weight: 'font weight', color: 'text colour', fill: 'fill colour', radius: 'corner radius', stroke: 'border', align: 'text alignment' };

/**
 * What one defect is, in the terms a reviewer judges it by.
 *
 * @param {Object} d       Defect.
 * @param {Object} section Its triage section.
 * @param {number} width   Breakpoint width.
 * @return {Object} Facts about the defect.
 */
export function defectFacts( d, section, width ) {
	const el = ( e ) => `${ e.type }${ e.text ? ` "${ e.text }"` : '' }, ${ e.w }×${ e.h }px at x ${ e.x }, y ${ e.y }`;
	const share = ( e ) => `covers ${ pct( ( e.w * e.h ) / ( width * section.figmaHeight ) ) } of the section`;
	switch ( d.issue ) {
		case 'missing':
			return { what: 'element in the design, missing on the page', element: el( d.figma ), size: share( d.figma ) };
		case 'extra':
			return { what: 'element on the page that the design does not have', element: el( d.page ), size: share( d.page ) };
		case 'copy':
			return { what: 'text reads differently', figma: `"${ d.figma.text }…"`, page: `"${ d.page.text }…"`, note: 'only the first 28 characters are compared, lower-cased' };
		case 'shifted':
			return { what: 'element the same size, moved sideways', element: el( d.figma ), moved: `${ signed( d.delta.x ) } (${ pct( Math.abs( d.delta.x ) / width ) } of the width)` };
		case 'content-shifted':
			return { what: 'the section\'s content as a whole sits to one side', moved: `${ signed( d.delta.x ) } (${ pct( Math.abs( d.delta.x ) / width ) } of the width)` };
		case 'height':
			return { what: 'section height', change: change( d.figma, d.page ) };
		case 'resized':
			return {
				what: d.textBox ? 'text over several lines, laid out in a box of a different width (its lines break elsewhere)' : 'element a different size',
				element: el( d.figma ),
				width: d.textBox ? change( d.textBox.figma, d.textBox.page ) : change( d.figma.w, d.page.w ),
				height: change( d.figma.h, d.page.h ),
			};
		case 'aspect':
			return {
				what: 'image with a different shape (its size may differ freely; only the aspect ratio matters)',
				element: el( d.figma ),
				aspectRatio: `${ d.ratio.figma } in Figma, ${ d.ratio.page } on the page (${ Math.round( Math.abs( d.ratio.page / d.ratio.figma - 1 ) * 100 ) }% ${ d.ratio.page > d.ratio.figma ? 'wider' : 'taller' })`,
			};
		case 'spacing': {
			const margins = ( m ) => [ m.from && `${ m.from }px`, m.to && `${ m.to }px` ].filter( Boolean ).join( ' and ' ) || 'none';
			return {
				what: {
					between: `visible space between two ${ 'vertical' === d.axis ? 'stacked' : 'side-by-side' } elements with nothing between them`,
					inside: `visible space inside an element, from its ${ d.side } edge to the content nearest it (its padding)`,
					edge: `visible space from the section's ${ d.side } edge to the content nearest it`,
				}[ d.where ],
				...( d.to ? { between: `${ el( d.from ) } and ${ el( d.to ) }` } : { element: el( d.from ) } ),
				...( d.container ? { container: el( d.container ) } : {} ),
				...( d.count > 1 ? { spaces: d.count } : {} ),
				change: change( d.figma, d.page ),
				marginsInTheSpace: `in Figma ${ margins( d.margins.figma ) }; on the page ${ margins( d.margins.page ) }`,
			};
		}
		case 'overlap':
			return { what: 'elements overall line up poorly, without one clear offset', matched: `${ pct( d.score ) } of the design's element area` };
		case 'pixels':
			return { what: 'layout matches but the pixels differ (colour, theme, type, images)', matched: `${ pct( d.score ) } of pixels (well-built sections score 75–88% because of font rendering)` };
		case 'style':
			if ( 'text-style' === d.property ) {
				const keys = [ 'font', 'size', 'lh', 'weight', 'color' ];
				const [ f, p ] = [ d.figma.split( '/' ), d.page.split( '/' ) ];
				const differs = keys.map( ( k, i ) => [ k, f[ i ], p[ i ] ] ).filter( ( [ , a, b ] ) => a && b && a !== b );
				return {
					what: 'a text style the design uses that no text on the page has. The words come from live posts and may differ; the style (font, size, weight, colour) comes from the template and should match the design',
					example: `"${ d.element.text }"`,
					closestPageStyle: p.length > 1 ? Object.fromEntries( differs.map( ( [ k, a, b ] ) => [ TOKEN_NAMES[ k ], tokenChange( k, a, b ) ] ) ) : 'no text on the page',
				};
			}
			return { what: `${ TOKEN_NAMES[ d.property ] } differs`, element: el( d.element ), elements: d.count, change: tokenChange( d.property, d.figma, d.page ) };
		default:
			return { what: d.summary };
	}
}

/** A defect id as a state key and backticked path: "9.6" → "d9_6". */
const key = ( id ) => `d${ id.replace( /\./g, '_' ) }`;

/**
 * What Jev is shown for one module: its context and each defect's facts, by id.
 *
 * @param {Object} section Triage section.
 * @param {number} width   Breakpoint width.
 * @return {Object} State.
 */
export function moduleState( section, width ) {
	const overall = {
		elementsMatched: undefined === section.wireframeScore ? 'not compared' : `${ pct( section.wireframeScore ) } of the design's element area`,
		pixelsMatched: undefined === section.pixelScore ? 'not compared' : `${ pct( section.pixelScore ) } (well-built sections score 75–88% because of font rendering)`,
	};
	if ( ! section.live ) {
		overall.height = change( section.figmaHeight, section.pageHeight );
	}
	return {
		module: {
			block: section.slug,
			figmaLayer: section.figma,
			breakpoint: `${ width }px wide`,
			...( section.live ? { content: 'live posts: their words, and how many there are, come from the site and are not compared; the template (images, spacing, text styles, colours) should still match the design' } : {} ),
		},
		overall,
		defects: section.defects.length ? Object.fromEntries( section.defects.map( ( d ) => [ key( d.id ), defectFacts( d, section, width ) ] ) ) : 'none: nothing measurable differs',
	};
}

/**
 * The questions for one module: would a reviewer accept it, and for each defect, would they
 * ask for it to be fixed.
 *
 * @param {Object} section Triage section.
 * @return {Object} Questions keyed by id.
 */
export function moduleQuestions( section ) {
	return {
		correct: {
			type: 'noul',
			instructions: 'Would a careful reviewer accept `module` as a faithful build of its Figma design at this breakpoint, given its `defects`?',
			criteria: {
				true: 'Yes: it matches the design; whatever differs is too small or subtle to ask for a change.',
				false: 'No: at least one difference needs fixing before sign-off.',
			},
		},
		...Object.fromEntries( section.defects.map( ( d ) => [ key( d.id ), {
			type: 'noul',
			instructions: `Would a careful reviewer ask for \`defects.${ key( d.id ) }\` to be fixed before accepting \`module\`?`,
			criteria: {
				true: 'Yes: someone comparing the page with the design would notice it and ask for it to be changed.',
				false: 'No: too small or subtle to notice at this size (rounding, font rendering, a pixel or two).',
			},
		} ] ) ),
	};
}

/** Tries per module when the provider rate-limits or is overloaded. */
const JEV_ATTEMPTS = 5;

/**
 * Ask Jev about one module, retrying once when it is rate-limited or overloaded.
 *
 * @param {Object}   endpoint  jevEndpoint() result.
 * @param {Object}   state     moduleState() result.
 * @param {Object}   questions moduleQuestions() result.
 * @param {Function} request   fetch-compatible function (injectable for tests).
 * @return {Promise<Object>} Jev's response: model, answers, usage.
 * @throws {Error} On any other failure.
 */
export async function askJev( endpoint, state, questions, request = fetch ) {
	for ( let attempt = 1; ; attempt++ ) {
		const response = await request( endpoint.url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ endpoint.key }`, 'Content-Type': 'application/json' },
			body: JSON.stringify( { model: endpoint.model, state, questions } ),
		} );
		if ( response.ok ) {
			return response.json();
		}
		// A rate limit or overload is retried, waiting as long as the provider says or longer each
		// time, with jitter so modules that hit it together don't retry together.
		if ( attempt < JEV_ATTEMPTS && [ 429, 529 ].includes( response.status ) ) {
			const header = response.headers?.get?.( 'retry-after' );
			const wait = null !== header && undefined !== header && '' !== header && ! Number.isNaN( Number( header ) ) ? Number( header ) : 2 ** attempt;
			await new Promise( ( resolve ) => setTimeout( resolve, ( wait + Math.random() ) * 1000 ) );
			continue;
		}
		throw new Error( `Jev answered ${ response.status }: ${ ( await response.text() ).slice( 0, 300 ) }` );
	}
}

const round = ( n ) => Number( n.toFixed( 4 ) );

/** Modules asked about at once. */
const JEV_CONCURRENCY = 4;

/**
 * Diagnose every compared module, JEV_CONCURRENCY at a time. Masked (dynamic) modules are skipped. Each
 * diagnosed section gains `diagnosis` ({ model, correct }), and each of its defects `matters`.
 *
 * @param {Object}   report   triage.json content.
 * @param {Object}   endpoint jevEndpoint() result.
 * @param {Function} request  fetch-compatible function (injectable for tests).
 * @return {Promise<string[]>} Warnings for modules Jev couldn't diagnose.
 */
export async function diagnose( report, endpoint, request = fetch ) {
	const warnings = [];
	const queue = report.sections.filter( ( s ) => 'dynamic' !== s.verdict );
	const probability = ( p ) => 'number' === typeof p && p >= 0 && p <= 1;
	const next = async () => {
		for ( let s = queue.shift(); s; s = queue.shift() ) {
			try {
				const { model, answers } = await askJev( endpoint, moduleState( s, report.width ), moduleQuestions( s ), request );
				// Kept only when every answer is there, so a module is diagnosed whole or not at all.
				const values = [ answers.correct?.noul, ...s.defects.map( ( d ) => answers[ key( d.id ) ]?.noul ) ];
				if ( ! values.every( probability ) ) {
					throw new Error( 'Jev left questions unanswered' );
				}
				s.diagnosis = { model, correct: round( values[ 0 ] ) };
				s.defects.forEach( ( d, i ) => ( d.matters = round( values[ i + 1 ] ) ) );
			} catch ( error ) {
				// fetch() hides why a connection failed (DNS, TLS, refused) in `cause`.
				const why = error.cause ? `${ error.message } (${ error.cause.code || error.cause.message })` : error.message;
				warnings.push( `Jev couldn't diagnose #${ s.index } ${ s.slug }: ${ why }` );
			}
		}
	};
	// A few requests at a time, so a long page doesn't trip the provider's rate limit.
	await Promise.all( Array.from( { length: JEV_CONCURRENCY }, next ) );
	return warnings;
}

/**
 * Metrics over the diagnoses, or null when no module was diagnosed.
 *
 * @param {Object} report   triage.json content, after diagnose().
 * @param {number} expected Figma sections expected on the page (masked ones left out).
 * @return {Object|null}
 */
export function diagnosisMetrics( report, expected ) {
	const diagnosed = report.sections.filter( ( s ) => s.diagnosis );
	if ( ! diagnosed.length ) {
		return null;
	}
	const sum = ( values ) => values.reduce( ( a, n ) => a + n, 0 );
	const correct = diagnosed.map( ( s ) => s.diagnosis.correct );
	const matters = diagnosed.flatMap( ( s ) => s.defects.map( ( d ) => d.matters ) );
	return {
		model: diagnosed[ 0 ].diagnosis.model,
		diagnosed: diagnosed.length,
		// Expected share of sections a reviewer would accept; missing sections count as 0.
		expectedCorrectness: expected > 0 ? round( sum( correct ) / expected ) : 1,
		signedOff: correct.filter( ( p ) => p >= SIGN_OFF ).length,
		needsReview: correct.filter( ( p ) => p > REJECT && p < SIGN_OFF ).length,
		rejected: correct.filter( ( p ) => p <= REJECT ).length,
		// Expected number of defects a reviewer would ask to fix, and those they wouldn't.
		expectedFixes: Math.round( sum( matters ) * 10 ) / 10,
		negligible: matters.filter( ( p ) => p <= REJECT ).length,
	};
}
