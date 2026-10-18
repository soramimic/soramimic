import assert from 'node:assert/strict';
import { compare, median } from './compare.mjs';

const sample = (wallMs, cpuMs) => ({ wallMs, cpuMs });
const series = (wallMs, cpuMs) => [sample(wallMs, cpuMs), sample(wallMs, cpuMs), sample(wallMs, cpuMs)];
const run = (before, after) => compare({ generation: before }, { generation: after })[0];
assert.equal(median([10, 30, 20]), 20);
assert.equal(median([10, 40, 20, 30]), 25);
assert(!run(series(1000, 800), series(1000, 800)).regressed);
assert(!run(series(1000, 800), series(1300, 1040)).regressed, 'threshold itself passes');
assert(run(series(1000, 800), series(1310, 1048)).regressed, 'a 31% regression fails');
assert(!run(series(50, 10), series(100, 20)).regressed, 'small absolute noise passes');
assert(!run(series(1000, 800), [sample(1000, 800), sample(1000, 800), sample(9000, 7000)]).regressed,
	'a single scheduling outlier does not fail the median');
assert(run(series(1000, 800), series(1400, 800)).metrics.wallMs.regressed, 'waiting regressions fail');
assert(run(series(1000, 500), series(1000, 700)).metrics.cpuMs.regressed, 'extra CPU work fails');
assert.throws(() => compare({}, {}));
assert.throws(() => compare({ a: series(1, 1) }, { b: series(1, 1) }));
assert.throws(() => run(series(1, 1), [sample(1, 1)]));
assert.throws(() => run(series(1, 1), series(NaN, 1)));
assert.throws(() => run(series(1, 1), series(1, 0)));
console.log('[ok] performance thresholds, noise floors, outliers, CPU/wall regressions and invalid reports');
