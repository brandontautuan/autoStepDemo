#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const iterations = Math.max(1, Number(process.argv.find((arg) => arg.startsWith('--iterations='))?.split('=')[1]) || 10);
const root = path.resolve(__dirname, '..');
const nativeBinary = path.join(root, 'rust-collector', 'target', 'debug', 'macos-native-collector');
const rustBinary = path.join(root, 'rust-collector', 'target', 'debug', 'window-observer-collector');
const excludedPid = process.pid;

function rssKb(pid) {
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  const value = Number(result.stdout?.trim());
  return Number.isFinite(value) ? value : null;
}

function persistentBenchmark(label, binary, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
    child.stdout.setEncoding('utf8');
    let buffer = '';
    const pending = [];
    const latencies = [];
    let peakRssKb = 0;
    let successes = 0;
    let nonEmptyResponses = 0;
    let totalWindows = 0;
    let done = false;
    let safetyTimer;
    let errorOutput = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        const request = pending.shift();
        if (!request) continue;
        try {
          const response = JSON.parse(line);
          if (!Array.isArray(response.windows)) throw new Error('missing windows array');
          successes += 1;
          totalWindows += response.windows.length;
          if (response.windows.length > 0) nonEmptyResponses += 1;
          latencies.push(Number(process.hrtime.bigint() - request.started) / 1e6);
        } catch (_) {}
      }
    });

    const started = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) {
      pending.push({ started: process.hrtime.bigint() });
      child.stdin.write('capture\n');
      peakRssKb = Math.max(peakRssKb, rssKb(child.pid) || 0);
    }
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      if (successes >= iterations) child.stdin.end('shutdown\n');
      else child.kill('SIGTERM');
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ label, iterations, successes, nonEmptyResponses, totalWindows, elapsedMs, averageLatencyMs: average(latencies), peakRssKb: peakRssKb || null, error: errorOutput.trim() || null });
    };
    const poll = setInterval(() => {
      if (successes >= iterations || child.exitCode !== null) {
        clearInterval(poll);
        finish();
      }
    }, 10);
    safetyTimer = setTimeout(() => {
      clearInterval(poll);
      if (successes < iterations) finish();
    }, 5000);
  });
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function jxaBenchmark() {
  const script = 'const se=Application("System Events"); const rows=[]; for(const p of se.processes()){try{for(const w of p.windows()){try{rows.push({appName:p.name(),title:w.name()||""})}catch(_){}}}catch(_){}} JSON.stringify(rows);';
  const latencies = [];
  let successes = 0;
  let totalWindows = 0;
  let error = null;
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      encoding: 'utf8',
      timeout: 2000,
      killSignal: 'SIGTERM'
    });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    if (result.status === 0) {
      try {
        const rows = JSON.parse(result.stdout.trim() || '[]');
        successes += 1;
        totalWindows += rows.length;
        latencies.push(elapsed);
      } catch (_) {}
    } else if (!error) {
      error = (result.stderr || 'JXA collection failed').trim();
    }
  }
  return { label: 'jxa-one-shot-fallback', iterations, successes, nonEmptyResponses: totalWindows > 0 ? successes : 0, averageLatencyMs: average(latencies), totalWindows: successes ? totalWindows : null, peakRssKb: null, error };
}

(async () => {
  const results = [];
  results.push(await persistentBenchmark('native-helper-persistent', nativeBinary, [String(excludedPid)]));
  results.push(await persistentBenchmark('rust-persistent-native-only', rustBinary, ['--exclude-pid', String(excludedPid)], { WINDOW_OBSERVER_MACOS_NATIVE_ONLY: '1' }));
  results.push(jxaBenchmark());
  console.log(JSON.stringify({ platform: process.platform, iterations, results }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
