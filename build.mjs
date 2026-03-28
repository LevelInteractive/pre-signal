import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/index.ts'],
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
