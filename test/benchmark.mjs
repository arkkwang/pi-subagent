// Run with PI_SDK_ENTRY=/absolute/path/to/pi/dist/index.js node test/benchmark.mjs
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Subagents } from '../manager.mjs';

if (!process.env.PI_SDK_ENTRY) throw new Error('Set PI_SDK_ENTRY to installed Pi dist/index.js');
const sdk = await import(pathToFileURL(path.resolve(process.env.PI_SDK_ENTRY)).href);
const dir = await mkdtemp(path.join(tmpdir(), 'pi-subagent-bench-'));
await mkdir(path.join(dir, 'agent'));
const extension = fileURLToPath(new URL('../index.js', import.meta.url));
const samples = { before: [], after: [] };
try {
  for (let i = 0; i < 9; i++) {
    for (const variant of i % 2 ? ['after', 'before'] : ['before', 'after']) {
      const loader = new sdk.DefaultResourceLoader({
        cwd: dir, agentDir: path.join(dir, 'agent'),
        settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: variant === 'after' ? [extension] : [],
      });
      const start = performance.now(); await loader.reload();
      if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
      if (i) samples[variant].push(performance.now() - start); // discard cold warm-up
    }
  }
  const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const manager = new Subagents({ createSession() {}, notify() {} });
  const record = { id: 'bench', status: 'idle', session: { isIdle: true }, lastOutput: 'x'.repeat(1024 * 1024) };
  manager.records.set(record.id, record);
  const start = performance.now();
  for (let i = 0; i < 10000; i++) JSON.stringify(manager.status({ id: 'bench' }));
  console.log(JSON.stringify({ platform: process.platform, node: process.version,
    resourceLoadMedianMs: { before: median(samples.before), after: median(samples.after) },
    status10000With1MiBOutputMs: performance.now() - start,
    note: 'Before: identical Pi resource loader without extension. After: with extension; SDK already loaded. No model requests.',
  }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
