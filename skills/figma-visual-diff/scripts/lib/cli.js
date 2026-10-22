/**
 * Command-line arguments, shared by the scripts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parse `--kebab-case value` pairs into camelCase keys.
 *
 * @param {string[]} argv    Arguments after the script path.
 * @param {Object}   options Parsing rules.
 * @param {Object}   options.defaults Values used when a flag is absent.
 * @param {string[]} options.flags    camelCase keys that take no value and become true.
 * @param {string[]} options.numbers  camelCase keys converted to numbers.
 * @param {string[]} options.required camelCase keys that must end up set.
 * @return {Object} Parsed arguments.
 * @throws {Error} For a missing required flag, a flag without its value, or a value that should be a number and isn't.
 */
export function parseFlags( argv, { defaults = {}, flags = [], numbers = [], required = [] } = {} ) {
	const flag = ( key ) => `--${ key.replace( /[A-Z]/g, ( c ) => `-${ c.toLowerCase() }` ) }`;
	const args = { ...defaults };
	for ( let i = 0; i < argv.length; i++ ) {
		const key = argv[ i ].replace( /^--/, '' ).replace( /-([a-z])/g, ( m, c ) => c.toUpperCase() );
		if ( flags.includes( key ) ) {
			args[ key ] = true;
			continue;
		}
		// Without this, `--url --width 1440` would take "--width" as the URL.
		const value = argv[ i + 1 ];
		if ( undefined === value || value.startsWith( '--' ) ) {
			throw new Error( `Missing value for ${ flag( key ) }` );
		}
		args[ key ] = value;
		i++;
	}
	for ( const key of numbers ) {
		if ( undefined === args[ key ] ) {
			continue;
		}
		args[ key ] = Number( args[ key ] );
		if ( ! Number.isFinite( args[ key ] ) ) {
			throw new Error( `${ flag( key ) } must be a number` );
		}
	}
	for ( const key of required ) {
		if ( ! args[ key ] ) {
			throw new Error( `Missing ${ flag( key ) }` );
		}
	}
	return args;
}

/**
 * A comma-separated option ("post-slider,hero") as a set; blanks are dropped.
 *
 * @param {string|undefined} value Option value.
 * @return {Set<string>}
 */
export function listOption( value ) {
	return new Set( String( value ?? '' ).split( ',' ).map( ( s ) => s.trim() ).filter( Boolean ) );
}

/**
 * A 0–1 ratio as a percentage with one decimal, for console output.
 *
 * @param {number} n Ratio.
 * @return {string}
 */
export const pct = ( n ) => `${ ( n * 100 ).toFixed( 1 ) }%`;

/**
 * A pixel difference with its sign, for console output and defect summaries.
 *
 * @param {number} n Pixels.
 * @return {string}
 */
export const signedPx = ( n ) => `${ n > 0 ? '+' : '' }${ n }px`;

/**
 * A section image's file name: its position and slug, in characters safe in a path and a URL
 * (sectionMap can name a slug anything).
 *
 * @param {number} i    Figma section index.
 * @param {string} slug Section slug.
 * @return {string}
 */
export const sectionImage = ( i, slug ) => `${ String( i + 1 ).padStart( 2, '0' ) }-${ slug.replace( /[^a-z0-9_-]+/gi, '-' ) }.png`;

/**
 * Whether a module is the script Node was started with.
 *
 * @param {string} metaUrl The module's import.meta.url.
 * @return {boolean}
 */
export function isMain( metaUrl ) {
	if ( ! process.argv[ 1 ] ) {
		return false;
	}
	// Node resolves a module's URL through symlinks but leaves argv as typed, so a script run
	// from a symlinked install (the skill linked into ~/.claude/skills) would never be main.
	let script = path.resolve( process.argv[ 1 ] );
	try {
		script = fs.realpathSync( script );
	} catch {
		// Not a file (e.g. `node --eval`): compare as given.
	}
	return fileURLToPath( metaUrl ) === script;
}
