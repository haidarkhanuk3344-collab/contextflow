import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig(({ mode }) => ({ base: './', plugins: [react(), ...(mode === 'demo' ? [viteSingleFile()] : [])], server: { host: '127.0.0.1', port: 5194, strictPort: true, proxy: { '/api/v1': { target: 'http://127.0.0.1:5196' } } } }));
