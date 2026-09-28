/**
 * Defects: every difference between a page section and its Figma section, one entry each.
 *
 * A section can be short of logos and have a misaligned heading at once; each needs its own
 * fix, often by someone else. So every defect names its kind, who fixes it, and the values
 * on both sides, and the section's verdict is its most severe kind:
 *
 *   structure  sections missing, extra or out of order          → page: add/remove/reorder blocks
 *   content    elements missing or extra, or copy differs       → page: fix blocks and copy
 *   alignment  an element or the content shifted sideways       → page: align attribute
 *   layout     everything present, sizes or spacing differ      → developer: block CSS
 *   visual     design tokens differ, or geometry matches but pixels don't
 *                                                              → page: theme/fontSize, else developer
 *
 * Element coordinates are px at the breakpoint, relative to the top-left of the section on
 * that side. triage.schema.json describes each defect's fields.
 */

import { describe, MAX_OFFSETS } from './boxes.js';
import { signedPx as sign } from './cli.js';

export const SEVERITY = [ 'structure', 'content', 'alignment', 'layout', 'visual' ];

export const OWNERS = {
	structure: 'page',
	content: 'page',
	alignment: 'page',
	layout: 'developer',
	visual: 'page-or-developer',
};

export const TOKEN_LABELS = { font: 'font', size: 'font size', lh: 'line height', weight: 'font weight', color: 'text colour', fill: 'fill', radius: 'corner radius', stroke: 'border', align: 'text alignment', 'text-style': 'text style', ls: 'letter spacing', italic: 'italic', deco: 'text decoration', case: 'letter case' };
export const TOKEN_UNITS = { size: 'px', lh: 'px', radius: 'px', ls: 'px' };

const PER_SIDE = { radius: [ 'top-left', 'top-right', 'bottom-right', 'bottom-left' ], stroke: [ 'top', 'right', 'bottom', 'left' ] };

/**
 * A token's value as people read it, with its unit; corners and sides named where they differ
 * ("top-left 8px, top-right 8px, bottom-right 0px, bottom-left 0px").
 *
 * @param {string} property Token name.
 * @param {string} value    Token value, as triage.json records it.
 * @return {string}
 */
export function tokenValue( property, value ) {
	const unit = TOKEN_UNITS[ property ] ?? '';
	const parts = String( value ).split( ' ' );
	if ( PER_SIDE[ property ] && 4 === parts.length ) {
		return parts.map( ( v, i ) => `${ PER_SIDE[ property ][ i ] } ${ v }${ 'none' === v ? '' : unit }` ).join( ', ' );
	}
	return `${ value }${ 'none' === value ? '' : unit }`;
}

/** Relative aspect-ratio change an image may show before it counts: whole-pixel rounding. */
const ASPECT_TOLERANCE = 0.02;
const round2 = ( n ) => Math.round( n * 100 ) / 100;
/** How much an image's shape changed: its page aspect ratio over its Figma one, minus 1. */
const aspectChange = ( o ) => ( o.page.w / o.page.h ) / ( o.figma.w / o.figma.h ) - 1;

const defect = ( kind, issue, fields, summary ) => ( { kind, issue, owner: OWNERS[ kind ], summary, ...fields } );

const pctOf = ( n ) => `${ ( n * 100 ).toFixed( 1 ) }%`;

/** Differences with the same key as one, the first standing for the rest, with their count. */
const group = ( list, keyOf ) => {
	const groups = new Map();
	for ( const d of list ) {
		const key = JSON.stringify( keyOf( d ) );
		groups.set( key, { ...( groups.get( key ) ?? d ), count: ( groups.get( key )?.count ?? 0 ) + 1 } );
	}
	return [ ...groups.values() ];
};

const named = ( e ) => ( e.text ? `${ e.type } "${ e.text }"` : `${ e.type } ${ e.w }×${ e.h } at ${ e.x },${ e.y }` );

/**
 * A space in words, with how each side builds it: `92px in Figma (72 padding + 20 margin)`.
 * Between two elements the margins are named per element; the rest of the space is the gap.
 */
function spacingSummary( s ) {
	const more = s.count > 1 ? ` (and ${ s.count - 1 } more like it)` : '';
	const [ first, second ] = { vertical: [ 'bottom', 'top' ], horizontal: [ 'right', 'left' ] }[ s.axis ] ?? [ s.side ];
	// A margin either side has is named on both, so the two read side by side.
	const labels = { from: s.to ? `margin-${ first } on the ${ { bottom: 'upper', right: 'left' }[ first ] }` : 'margin', to: `margin-${ second } on the ${ { top: 'lower', left: 'right' }[ second ] }` };
	const shown = Object.keys( labels ).filter( ( k ) => s.margins.figma[ k ] || s.margins.page[ k ] );
	const built = ( space, m ) => {
		const rest = space - shown.reduce( ( sum, k ) => sum + m[ k ], 0 );
		return shown.length ? ` (${ [ `${ rest } ${ s.to ? 'gap' : 'padding' }`, ...shown.map( ( k ) => `${ m[ k ] } ${ labels[ k ] }` ) ].join( ' + ' ) })` : '';
	};
	const what = {
		between: () => `space between ${ named( s.from ) } and ${ named( s.to ) }${ more }`,
		inside: () => `space inside ${ named( s.container ) } from its ${ s.side } edge to ${ named( s.from ) }${ more }`,
		edge: () => `space from ${ named( s.from ) } to the section's ${ s.side } edge${ more }`,
	}[ s.where ]();
	return `${ what }: ${ s.figma }px in Figma${ built( s.figma, s.margins.figma ) }, ${ s.page }px on the page${ built( s.page, s.margins.page ) } (${ sign( s.page - s.figma ) })`;
}

/**
 * Every defect in one section, most severe first.
 *
 * @param {Object}      w    Wireframe report section.
 * @param {Object|null} p    Pixel report section for the same Figma section, if compared.
 * @param {Object}      args Thresholds: alignmentShift, tolerance, heightTolerance, pixelThreshold.
 * @return {Array} Defects; empty when the section matches or is masked.
 */
export function sectionDefects( w, p, args ) {
	if ( 'masked' === w.status ) {
		return [];
	}
	w = { missing: [], extra: [], copy: [], shifted: [], offsets: [], drift: { dx: 0, dy: 0, resized: 0 }, heightDelta: 0, ...w };
	// Live sections (post feeds) arrive with only their template elements compared (see
	// analyseSection); their height follows the posts, so it isn't compared either.
	const defects = [
		...w.missing.map( ( e ) => defect( 'content', 'missing', { figma: e }, `missing ${ describe( e ) }` ) ),
		// Elements Figma doesn't have (e.g. a 4th card where the design shows 3).
		...w.extra.map( ( e ) => defect( 'content', 'extra', { page: e }, `extra ${ describe( e ) }` ) ),
		...w.copy.map( ( c ) => defect( 'content', 'copy', { figma: c.figma, page: c.page }, `copy "${ c.figma.text }" → "${ c.page.text }"` ) ),
		...w.shifted.map( ( s ) => defect( 'alignment', 'shifted', { figma: s.figma, page: s.page, delta: { x: s.dx } }, `${ describe( s.figma ) } shifted ${ sign( s.dx ) }` ) ),
	];
	const { dx, dy, resized } = w.drift;
	if ( ! w.shifted.length && Math.abs( dx ) >= args.alignmentShift && Math.abs( dx ) > Math.abs( dy ) ) {
		defects.push( defect( 'alignment', 'content-shifted', { delta: { x: dx } }, `section content shifted ${ sign( dx ) } horizontally` ) );
	}
	const tallerOrShorter = ! w.live && Math.abs( w.heightDelta ) > args.heightTolerance;
	if ( tallerOrShorter ) {
		defects.push( defect( 'layout', 'height', { figma: w.figmaHeight, page: w.pageHeight, delta: w.heightDelta }, `section height ${ w.figmaHeight } → ${ w.pageHeight } (${ sign( w.heightDelta ) })` ) );
	}
	// Elements of a different size, largest offsets first (the wireframe report keeps a dozen):
	// each is a size to fix. Elements that only moved are left out; they mostly follow from
	// something above them changing size, and the overlays show where they went.
	if ( w.live || tallerOrShorter || ( 'fail' === w.status && ( resized || Math.abs( dy ) > args.tolerance ) ) ) {
		for ( const o of w.offsets ) {
			if ( Math.abs( o.dw ) <= args.tolerance && Math.abs( o.dh ) <= args.tolerance ) {
				continue;
			}
			// An image's size follows its column; its aspect ratio is what the build controls
			// (cropping, object-fit). So a scaled image is fine and only its shape is a defect.
			if ( 'image' === o.figma.type ) {
				const change = aspectChange( o );
				if ( Math.abs( change ) > ASPECT_TOLERANCE ) {
					const [ figmaRatio, pageRatio ] = [ o.figma.w / o.figma.h, o.page.w / o.page.h ];
					const shape = change > 0 ? 'wider' : 'taller';
					defects.push( defect( 'layout', 'aspect', { figma: o.figma, page: o.page, ratio: { figma: round2( figmaRatio ), page: round2( pageRatio ) } },
						`${ describe( o.figma ) } is ${ o.page.w }×${ o.page.h } on the page: aspect ratio ${ round2( figmaRatio ) } in Figma, ${ round2( pageRatio ) } on the page (${ Math.round( Math.abs( change ) * 100 ) }% ${ shape })` ) );
				}
				continue;
			}
			const summary = o.textBox
				? `${ describe( o.figma ) }: text box ${ o.textBox.figma }px wide in Figma, ${ o.textBox.page }px on the page (${ sign( o.dw ) }), ${ sign( o.dh ) } tall`
				: `${ describe( o.figma ) } is ${ o.page.w }×${ o.page.h } on the page (${ sign( o.dw ) } wide, ${ sign( o.dh ) } tall)`;
			defects.push( defect( 'layout', 'resized', { figma: o.figma, page: o.page, delta: { w: o.dw, h: o.dh }, ...( o.textBox ? { textBox: o.textBox } : {} ) }, summary ) );
		}
	}
	// Spacing: one defect per differing space, however many share it (e.g. every card's gap
	// under its image), naming the margins in it, which say where to fix it.
	for ( const g of group( w.spacing || [], ( d ) => [ d.where, d.side ?? d.axis, d.from.type, d.to?.type, d.figma, d.page ] ) ) {
		defects.push( defect( 'layout', 'spacing', { ...g, delta: g.page - g.figma }, spacingSummary( g ) ) );
	}
	// Design tokens: one defect per difference, however many elements share it (e.g. every
	// card title a size smaller), with how many do.
	for ( const { property, figma, page, count, element } of group( w.styles || [], ( d ) => [ d.element.type, d.property, d.figma, d.page ] ) ) {
		const name = `${ element.type }${ element.text ? ` "${ element.text }"` : '' }${ count > 1 ? ` and ${ count - 1 } more like it` : '' }`;
		const summary = 'text-style' === property
			? `text style ${ figma } (e.g. "${ element.text }") isn't used on the page${ page ? `; closest: ${ page }` : '' }`
			: `${ name }: ${ TOKEN_LABELS[ property ] } ${ tokenValue( property, figma ) } in Figma, ${ tokenValue( property, page ) } on the page`;
		defects.push( defect( 'visual', 'style', { property, figma, page, count, element }, summary ) );
	}
	// Pixels only add information once geometry agrees; otherwise they re-report the layout.
	if ( ! defects.some( ( d ) => 'layout' === d.kind ) && undefined !== p?.score && p.score < args.pixelThreshold ) {
		defects.push( defect( 'visual', 'pixels', { score: p.score, threshold: args.pixelThreshold }, `geometry matches, pixels ${ pctOf( p.score ) } (threshold ${ pctOf( args.pixelThreshold ) })` ) );
	}
	// A failing wireframe score must never read as ok, even when no single rule explains it
	// (except in a live section, whose score also counts the posts' own text and cards, or
	// when all it measured is images scaled to the same shape, which are fine; a full offsets
	// list may have left others out, so it can't tell).
	const scaledOnly = w.offsets.length && w.offsets.length < MAX_OFFSETS && w.offsets.every( ( o ) => 'image' === o.figma.type && Math.abs( aspectChange( o ) ) <= ASPECT_TOLERANCE );
	if ( ! defects.length && 'fail' === w.status && ! w.live && ! scaledOnly ) {
		const score = w.score ?? 0;
		defects.push( defect( 'layout', 'overlap', { score }, `boxes overlap Figma's by ${ pctOf( score ) }, below the threshold, without one dominant offset` ) );
	}
	// Stable: within a kind, defects keep the order above.
	return defects.sort( ( a, b ) => SEVERITY.indexOf( a.kind ) - SEVERITY.indexOf( b.kind ) );
}

/**
 * Sections missing from the page or not in Figma, as structure defects.
 *
 * @param {Object} structure The wireframe report's structure: missing, extra and moved.
 * @return {Array} Defects.
 */
export function structureDefects( { missing, extra, moved } ) {
	const note = ( slug ) => ( moved.includes( slug ) ? ' (moved)' : '' );
	return [
		...missing.map( ( m ) => defect( 'structure', 'missing', { index: m.index, slug: m.slug, figma: m.figma, moved: moved.includes( m.slug ) }, `section #${ m.index } ${ m.slug } missing${ note( m.slug ) }` ) ),
		...extra.map( ( e ) => defect( 'structure', 'extra', { index: e.index, slug: e.slug, moved: moved.includes( e.slug ) }, `page block #${ e.index } ${ e.slug } not in Figma${ note( e.slug ) }` ) ),
	];
}

/**
 * The section's headline: its most severe defect kind.
 *
 * @param {Object} w       Wireframe report section.
 * @param {Array}  defects sectionDefects() result.
 * @return {string} A defect kind, `dynamic` or `ok`.
 */
export function verdictOf( w, defects ) {
	if ( 'masked' === w.status ) {
		return 'dynamic';
	}
	return defects[ 0 ]?.kind ?? 'ok';
}
