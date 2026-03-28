import * as esbuild from 'esbuild';
import pkg from './package.json' with { type: 'json' };

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/index.ts'],
  define: {
    '__VERSION__': JSON.stringify(pkg.version),
  },
  bundle: true,
  outfile: 'dist/pre-signal.js',
  format: 'iife',
  target: 'es2022',
  minify: !watch,
  mangleProps: watch ? undefined : /^#/,
  sourcemap: watch ? 'inline' : false,
  drop: watch ? [] : ['console'],
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Build complete: dist/pre-signal.js');
}
