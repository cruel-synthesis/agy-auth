import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli-bin': 'src/cli-bin.ts',
  },
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: false,
  sourcemap: false,
  minify: false,
  shims: true,
});
