/**
 * Metrics: how correct the build is, as numbers that can be compared run to run: measured
 * (sections without defects, defect counts, scores) and, when Jev ran, judged (the expected
 * share of sections a reviewer would accept).
 *
 * triage.json carries them for the current run and their change since the previous run;
 * every run also appends them to metrics.jsonl in its page/breakpoint folder, which outlives
 * pruned runs, so a build's progress can be tracked over its whole history.
 */

import fs from 'node:fs';
import path from 'node:path';
import { OWNERS, SEVERITY } from './defects.js';
import { diagnosisMetrics } from './jev.js';

const round = ( n ) => Number( n.toFixed( 4 ) );
const tally = ( keys, items, key ) => Object.fromEntries( keys.map( ( k ) => [ k, items.filter( ( d ) => d[ key ] === k ).length ] ) );

/**
 * The run's metrics.
 *
 * @param {Object} report    triage.json content (structure and sections).
 * @param {Object} wireframe The wireframe report.
 * @param {Object} pixel     The pixel report.
 * @return {Object} Metrics, as triage.schema.json describes them.
 */
export function buildMetrics( report, wireframe, pixel ) {
	const { sections, structure } = report;
	const defects = [ ...structure, ...sections.flatMap( ( s ) => s.defects ) ];
	const dynamic = sections.filter( ( s ) => 'dynamic' === s.verdict ).length;
	const ok = sections.filter( ( s ) => 'ok' === s.verdict ).length;
	const expected = wireframe.structure.figmaSections - dynamic;
	const diagnosis = diagnosisMetrics( report, expected );
	return {
		// Figma sections on the page without a defect; missing sections count against it.
		correctness: expected > 0 ? round( ok / expected ) : 1,
		sections: {
			figma: wireframe.structure.figmaSections,
			page: wireframe.structure.pageSections,
			paired: sections.length,
			ok,
			dynamic,
			withDefects: sections.length - ok - dynamic,
			missing: wireframe.structure.missing.length,
			extra: wireframe.structure.extra.length,
		},
		defects: {
			total: defects.length,
			byKind: tally( SEVERITY, defects, 'kind' ),
			byOwner: tally( [ ...new Set( Object.values( OWNERS ) ) ], defects, 'owner' ),
		},
		scores: { wireframe: wireframe.pageScore, pixel: pixel.pageScore },
		...( diagnosis ? { diagnosis } : {} ),
	};
}

/**
 * The change in the headline metrics since an earlier run (current minus earlier).
 *
 * @param {Object} now    buildMetrics() for this run.
 * @param {Object} before buildMetrics() for the earlier run.
 * @return {Object} Deltas.
 */
export function metricsDelta( now, before ) {
	return {
		correctness: round( now.correctness - before.correctness ),
		defects: now.defects.total - before.defects.total,
		pageDefects: now.defects.byOwner.page - before.defects.byOwner.page,
		developerDefects: now.defects.byOwner.developer - before.defects.byOwner.developer,
		wireframe: round( now.scores.wireframe - before.scores.wireframe ),
		pixel: round( now.scores.pixel - before.scores.pixel ),
		...( now.diagnosis && before.diagnosis ? { expectedCorrectness: round( now.diagnosis.expectedCorrectness - before.diagnosis.expectedCorrectness ) } : {} ),
	};
}

/**
 * Append the run's metrics to <runsDir>/metrics.jsonl, one JSON object per line.
 *
 * @param {string} runsDir Page/breakpoint runs folder.
 * @param {string} run     This run's folder name.
 * @param {Object} report  triage.json content, with metrics.
 */
export function appendHistory( runsDir, run, report ) {
	// The Figma inputs tell runs against different variants of a design apart.
	const figma = report.figma ? { figma: report.figma.hash, ...( report.figma.nodeId ? { nodeId: report.figma.nodeId } : {} ) } : {};
	const line = { run, url: report.url, width: report.width, pass: report.pass, ...figma, ...report.metrics };
	fs.appendFileSync( path.join( runsDir, 'metrics.jsonl' ), `${ JSON.stringify( line ) }\n` );
}
