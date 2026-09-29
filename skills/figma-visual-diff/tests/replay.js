#!/usr/bin/env node
/**
 * Replay stored triage runs offline, to prove a change to the comparison only adds what it
 * means to. A run folder keeps what the page looked like (wireframe/page-boxes.json) and its
 * pixel scores (pixel/report.json) next to the Figma boxes it was compared with, so the
 * wireframe comparison and defect rules can run again on exactly the same inputs.
 *
 *   node tests/replay.js --scripts <scripts dir> --out <dir> <run dir or corpus root>...
 *       Replays every run found under the paths with that code; writes <out>/<run>.json and
 *       prints how many sections reproduce the run's own triage.json.
 *   node tests/replay.js --diff <before out> <after out>
 *       Lists, per section, the defects the second replay removed, added or changed.
 *
 * Replay the code before and after a change with the same runs, then --diff the two: removed
 * or changed defects are regressions unless the change is about them; review every added one
 * against the run's overlay.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isMain } from '../scripts/lib/cli.js';

const CONFIG_NAMES = [ '.figma-visual-diff.json', 'figma-visual-diff.json' ];

/** Every run folder under the paths: one holding triage.json and wireframe/page-boxes.json. */
export function findRuns( roots ) {
	const runs = [];
	const walk = ( dir ) => {
		if ( fs.existsSync( path.join( dir, 'triage.json' ) ) && fs.existsSync( path.join( dir, 'wireframe', 'page-boxes.json' ) ) ) {
			runs.push( dir );
			return;
		}
		for ( const e of fs.readdirSync( dir, { withFileTypes: true } ) ) {
			// `latest` is a link to a run already found by its own name.
			if ( e.isDirectory() && 'latest' !== e.name ) {
				walk( path.join( dir, e.name ) );
			}
		}
	};
	roots.forEach( ( r ) => walk( path.resolve( r ) ) );
	return runs.sort();
}

/** The nearest project config above a run, which named its sections and live blocks. */
function configFor( run ) {
	for ( let dir = run; path.dirname( dir ) !== dir; dir = path.dirname( dir ) ) {
		const found = CONFIG_NAMES.map( ( n ) => path.join( dir, n ) ).find( ( f ) => fs.existsSync( f ) );
		if ( found ) {
			return found;
		}
	}
	return null;
}

/** What identifies a defect across replays: everything but its number and Jev's ranking. */
const defectKey = ( d ) => `${ d.kind }/${ d.issue } [${ d.owner }] ${ d.summary }`;
// Runs from before defects existed have none to compare, so they replay without a reference.
const sectionDefects = ( sections ) => Object.fromEntries( sections.filter( ( s ) => s.defects ).map( ( s ) => [ `${ s.index } ${ s.slug }`, s.defects.map( defectKey ) ] ) );
const runName = ( run ) => run.split( path.sep ).slice( -5 ).join( '__' );

/**
 * One run through the given code: its wireframe diff from the stored page, then triage's
 * defect rules with the stored pixel scores.
 */
async function replayRun( run, scripts, triage, tmp ) {
	const stored = JSON.parse( fs.readFileSync( path.join( run, 'triage.json' ), 'utf8' ) );
	const out = fs.mkdtempSync( path.join( tmp, 'run-' ) );
	const config = configFor( run );
	const argv = [
		path.join( scripts, 'wireframe-diff.js' ),
		'--url', stored.url, '--width', String( stored.width ), '--out', out,
		'--figma', path.join( path.dirname( run ), 'figma-boxes.txt' ),
		'--page-boxes', path.join( run, 'wireframe', 'page-boxes.json' ),
		'--threshold', String( triage.DEFAULTS.wireframeThreshold ),
		...( config ? [ '--config', config ] : [] ),
	];
	try {
		execFileSync( process.execPath, argv, { stdio: 'pipe' } );
	} catch ( error ) {
		// Exit 1 is a failing comparison, which still writes its report.
		if ( 1 !== error.status ) {
			throw new Error( `${ run }: ${ error.stderr }` );
		}
	}
	const wireframe = JSON.parse( fs.readFileSync( path.join( out, 'report.json' ), 'utf8' ) );
	const pixelFile = path.join( run, 'pixel', 'report.json' );
	const pixelOf = triage.sameSection( fs.existsSync( pixelFile ) ? JSON.parse( fs.readFileSync( pixelFile, 'utf8' ) ).sections : [] );
	const sections = wireframe.sections.map( ( w ) => triage.triageSection( w, pixelOf( w ), triage.DEFAULTS ) );
	return { run, config, replayed: sectionDefects( sections ), stored: sectionDefects( stored.sections ) };
}

async function replay( scripts, outDir, roots ) {
	const triage = await import( pathToFileURL( path.join( path.resolve( scripts ), 'triage.js' ) ) );
	const tmp = fs.mkdtempSync( path.join( os.tmpdir(), 'replay-' ) );
	fs.mkdirSync( outDir, { recursive: true } );
	let sections = 0;
	let same = 0;
	for ( const run of findRuns( roots ) ) {
		const r = await replayRun( run, path.resolve( scripts ), triage, tmp );
		fs.writeFileSync( path.join( outDir, `${ runName( run ) }.json` ), JSON.stringify( r, null, '\t' ) );
		const keys = Object.keys( r.stored );
		const matching = keys.filter( ( k ) => JSON.stringify( r.stored[ k ] ) === JSON.stringify( r.replayed[ k ] ) ).length;
		sections += keys.length;
		same += matching;
		console.log( `${ matching === keys.length ? 'same ' : 'DIFF ' } ${ matching }/${ keys.length } sections  ${ run }` );
	}
	fs.rmSync( tmp, { recursive: true, force: true } );
	console.log( `\n${ same }/${ sections } sections reproduce their stored triage.json` );
}

/** Per section: defects only in `before` (removed), only in `after` (added). */
export function diffDefects( before, after ) {
	const changes = [];
	for ( const section of new Set( [ ...Object.keys( before ), ...Object.keys( after ) ] ) ) {
		const b = before[ section ] || [];
		const a = after[ section ] || [];
		// As multisets: two defects can share a summary, and losing one of them is a change.
		const minus = ( x, y ) => {
			const left = [ ...y ];
			return x.filter( ( d ) => {
				const i = left.indexOf( d );
				return i < 0 || ( left.splice( i, 1 ), false );
			} );
		};
		const removed = minus( b, a );
		const added = minus( a, b );
		if ( removed.length || added.length ) {
			changes.push( { section, removed, added } );
		}
	}
	return changes;
}

function diff( beforeDir, afterDir ) {
	let removed = 0;
	let added = 0;
	const files = ( dir ) => fs.readdirSync( dir ).filter( ( f ) => f.endsWith( '.json' ) ).sort();
	// A run replayed on one side only means the two replays didn't cover the same corpus.
	const unpaired = [ ...files( beforeDir ).filter( ( f ) => ! fs.existsSync( path.join( afterDir, f ) ) ).map( ( f ) => `only in before: ${ f }` ),
		...files( afterDir ).filter( ( f ) => ! fs.existsSync( path.join( beforeDir, f ) ) ).map( ( f ) => `only in after: ${ f }` ) ];
	unpaired.forEach( ( u ) => console.log( u ) );
	for ( const file of files( beforeDir ).filter( ( f ) => fs.existsSync( path.join( afterDir, f ) ) ) ) {
		const before = JSON.parse( fs.readFileSync( path.join( beforeDir, file ), 'utf8' ) );
		const afterFile = path.join( afterDir, file );
		const after = JSON.parse( fs.readFileSync( afterFile, 'utf8' ) );
		for ( const c of diffDefects( before.replayed, after.replayed ) ) {
			console.log( `\n${ before.run }\n  section ${ c.section }  (overlay: ${ path.join( before.run, 'wireframe' ) })` );
			c.removed.forEach( ( d ) => console.log( `  - ${ d }` ) );
			c.added.forEach( ( d ) => console.log( `  + ${ d }` ) );
			removed += c.removed.length;
			added += c.added.length;
		}
	}
	console.log( `\n${ removed } removed, ${ added } added${ unpaired.length ? `, ${ unpaired.length } run(s) unpaired` : '' }` );
	process.exitCode = removed || unpaired.length ? 1 : 0;
}

async function main( argv ) {
	if ( '--diff' === argv[ 0 ] ) {
		return diff( argv[ 1 ], argv[ 2 ] );
	}
	const flag = ( name ) => argv[ argv.indexOf( name ) + 1 ];
	const roots = argv.filter( ( a, i ) => ! a.startsWith( '--' ) && ! argv[ i - 1 ]?.startsWith( '--' ) );
	if ( ! argv.includes( '--scripts' ) || ! argv.includes( '--out' ) || ! roots.length ) {
		throw new Error( 'usage: replay.js --scripts <dir> --out <dir> <run dir or corpus root>... | --diff <before> <after>' );
	}
	return replay( flag( '--scripts' ), flag( '--out' ), roots );
}

if ( isMain( import.meta.url ) ) {
	main( process.argv.slice( 2 ) ).catch( ( error ) => {
		console.error( error.stack || error.message );
		process.exitCode = 2;
	} );
}
