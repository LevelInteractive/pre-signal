import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/pre-signal.js',
  format: 'iife',
  target: 'es2022',
  minify: true,
  mangleProps: /^#/,
  sourcemap: false,
});

console.log('Build complete: dist/pre-signal.js');
