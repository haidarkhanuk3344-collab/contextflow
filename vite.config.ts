import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 5194, strictPort: true, proxy: { '/api/v1': { target: 'http://127.0.0.1:5196' } } } });
