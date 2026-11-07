export const MAX_SLOWDOWN = 0.30;
export const NOISE_FLOOR_MS = { wallMs: 100, cpuMs: 50 };

export function median(values) {
	if (!values.length || values.some(value => !Number.isFinite(value) || value <= 0)) {
		throw new Error('Timing samples must be finite positive numbers');
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function compare(base, head) {
	const names = Object.keys(base);
	if (!names.length || names.join('\n') !== Object.keys(head).join('\n')) {
		throw new Error('Baseline and candidate must contain the same nonempty set of cases');
	}
	return names.map(name => {
		if (base[name].length < 3 || base[name].length !== head[name].length) {
			throw new Error(`${name}: at least three paired samples are required`);
		}
		const metrics = Object.fromEntries(Object.entries(NOISE_FLOOR_MS).map(([metric, floor]) => {
			const before = median(base[name].map(sample => sample[metric]));
			const after = median(head[name].map(sample => sample[metric]));
			return [metric, { base: before, head: after, ratio: after / before,
				limit: Math.max(before * (1 + MAX_SLOWDOWN), before + floor),
				regressed: after > Math.max(before * (1 + MAX_SLOWDOWN), before + floor) }];
		}));
		return { name, metrics, regressed: Object.values(metrics).some(metric => metric.regressed) };
	});
}
