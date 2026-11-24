import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  build: {
    target: 'node20',
    ssr: true,
    outDir: 'dist-mcp',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'src/mcp/index.ts'),
        web: path.resolve(import.meta.dirname, 'src/mcp/web.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
        banner: '#!/usr/bin/env node\n',
      },
      external: [/^node:.*/],
    },
  },
  ssr: {
    noExternal: true,
  },
});
