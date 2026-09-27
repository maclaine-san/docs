import * as esbuild from 'esbuild';
import fs from 'node:fs';

const tests = process.argv.includes('--tests');
const common = { bundle: true, sourcemap: true, logLevel: 'warning' };
const node = { ...common, platform: 'node', target: 'node20', format: 'cjs' };

if (tests) {
  const entries = fs.readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
  await esbuild.build({ ...node, entryPoints: entries, outdir: 'dist-test' });
} else {
  fs.mkdirSync('dist', { recursive: true });
  await Promise.all([
    esbuild.build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', external: ['electron'] }),
    esbuild.build({ ...node, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js', external: ['electron'] }),
    esbuild.build({ ...node, entryPoints: ['src/e2e.ts'], outfile: 'dist/e2e.js' }),
    esbuild.build({
      ...common,
      platform: 'browser',
      target: 'chrome120',
      format: 'iife',
      jsx: 'automatic',
      entryPoints: ['src/renderer/app.tsx'],
      outfile: 'dist/renderer.js',
    }),
  ]);
  fs.copyFileSync('src/renderer/index.html', 'dist/index.html');
  fs.copyFileSync('src/renderer/styles.css', 'dist/styles.css');
}
