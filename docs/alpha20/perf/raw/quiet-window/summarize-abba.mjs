// Summarize the alpha.20 quiet-window a19profile ABBA rows into p50/p95/max per route/subject.
// Usage: node summarize-abba.mjs <quiet-window-dir>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const invocations = JSON.parse(fs.readFileSync(path.join(dir, 'abba-invocations.json'), 'utf8'));
const rows = [];
for (const invocation of invocations) {
    if (invocation.exit !== 0) {
        rows.push({ ...invocation, error: 'invocation failed' });
        continue;
    }
    const files = fs.readdirSync(invocation.dir).filter(name => name.endsWith('.json'));
    if (files.length !== 1) {
        rows.push({ ...invocation, error: `expected one json in ${invocation.dir}, found ${files.length}` });
        continue;
    }
    const artifact = JSON.parse(fs.readFileSync(path.join(invocation.dir, files[0]), 'utf8'));
    const profiled = (artifact.requestRows ?? []).filter(row => row.kind === 'profiled').map(row => row.ms).sort((a, b) => a - b);
    if (profiled.length === 0) {
        rows.push({ ...invocation, error: 'no profiled rows' });
        continue;
    }
    const quantile = q => profiled[Math.min(profiled.length - 1, Math.floor(q * profiled.length))];
    rows.push({
        route: invocation.route,
        subject: invocation.subject,
        round: invocation.round,
        requests: profiled.length,
        p50: Number(quantile(0.5).toFixed(2)),
        p95: Number(quantile(0.95).toFixed(2)),
        max: Number(profiled[profiled.length - 1].toFixed(2)),
        min: Number(profiled[0].toFixed(2)),
        startupMs: artifact.startupMs,
    });
}
const summary = {};
for (const row of rows) {
    if (row.error) continue;
    const key = `${row.route}/${row.subject}`;
    (summary[key] ??= []).push({ round: row.round, p50: row.p50, p95: row.p95, max: row.max, requests: row.requests, startupMs: row.startupMs });
}
const aggregate = {};
for (const [key, series] of Object.entries(summary)) {
    const p50 = series.map(row => row.p50).sort((a, b) => a - b);
    const p95 = series.map(row => row.p95).sort((a, b) => a - b);
    const max = series.map(row => row.max).sort((a, b) => a - b);
    aggregate[key] = {
        rounds: series.length,
        p50Median: p50[Math.floor(p50.length / 2)],
        p95Median: p95[Math.floor(p95.length / 2)],
        maxMedian: max[Math.floor(max.length / 2)],
        p50Series: series.map(row => row.p50),
        p95Series: series.map(row => row.p95),
        startupSeries: series.map(row => row.startupMs),
    };
}
const effect = {};
for (const route of [...new Set(rows.filter(row => !row.error).map(row => row.route))]) {
    const before = aggregate[`${route}/before`];
    const after = aggregate[`${route}/after`];
    if (!before || !after) continue;
    effect[route] = {
        p50DeltaPct: Number((((after.p50Median - before.p50Median) / before.p50Median) * 100).toFixed(1)),
        p95DeltaPct: Number((((after.p95Median - before.p95Median) / before.p95Median) * 100).toFixed(1)),
        before, after,
    };
}
fs.writeFileSync(path.join(dir, 'abba-summary.json'), `${JSON.stringify({ rows, aggregate, effect }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ effect }, null, 2));
