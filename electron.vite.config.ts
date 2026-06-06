import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@brand': resolve(__dirname, 'build'),
        // Keep transformers.js on its WASM (web) backend in the renderer: stub the
        // native Node addons it lists so the bundler never pulls their `.node`
        // binaries into the renderer/worker build. See src/.../dictation/empty.ts.
        'onnxruntime-node': resolve(__dirname, 'src/renderer/src/lib/dictation/empty.ts'),
        sharp: resolve(__dirname, 'src/renderer/src/lib/dictation/empty.ts')
      }
    }
  }
});
