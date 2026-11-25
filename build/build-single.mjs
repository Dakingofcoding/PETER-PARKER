// Builds dist/peter-parker-study.html: one self-contained file, no Node.js needed to use it.
// Usage: node build/build-single.mjs [--test]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const test = process.argv.includes('--test');
const swap = {
  'server/config.js': 'browser/config.js',
  'server/store.js': 'browser/store.js',
  'server/research/fetcher.js': 'browser/fetcher.js',
  'server/extract/pdf.js': 'browser/pdf.js',
};
const alias = {
  express: 'browser/express.js',
  multer: 'browser/multer.js',
  'node:fs': 'browser/fs.js',
  fs: 'browser/fs.js',
};

const plugin = {
  name: 'pps',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (alias[args.path]) return { path: path.join(root, alias[args.path]) };
      if (args.path === 'node:path' || args.path === 'path') return { path: require.resolve('path-browserify') };
      if (args.path === '/vendor/marked.esm.js') return { path: require.resolve('marked') };
      if (args.path === '/vendor/purify.es.mjs') return { path: path.join(root, 'node_modules/dompurify/dist/purify.es.mjs') };
      if (args.path.startsWith('.') && args.resolveDir) {
        const abs = path.resolve(args.resolveDir, args.path);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (swap[rel] && !args.importer.includes(`${path.sep}browser${path.sep}`)) return { path: path.join(root, swap[rel]) };
      }
      return null;
    });
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(root, 'browser/entry.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: !test,
  write: false,
  plugins: [plugin],
  define: { __PPS_TEST__: test ? 'true' : 'false', 'process.env.TEST_FAKE_AI_MODULE': 'undefined', 'process.env.NODE_ENV': '"test-import"' },
  logLevel: 'warning',
});
let js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
let html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="/css/app.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('<script type="module" src="/js/app.js"></script>', () => `<script type="module">\n${js}\n</script>`);
const out = path.join(root, 'dist', test ? 'peter-parker-study.test.html' : 'peter-parker-study.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1e6).toFixed(2)} MB)`);
