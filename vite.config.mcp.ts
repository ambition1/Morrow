import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  // MCP 无界面，不复制 Web 预览引擎的公共资源。
  publicDir: false,
  build: {
    target: 'node20',
    ssr: true,
    outDir: 'dist-mcp',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, 'src/mcp/index.ts'),
      output: {
        entryFileNames: 'index.js',
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
