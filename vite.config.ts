import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Not VITE_-prefixed, so it stays out of the browser bundle.
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.API_PROXY_TARGET || 'http://localhost:8000'

  return {
    plugins: [react()],
    server: {
      // In dev, forward API calls and processed images to Django so the browser sees
      // one origin: no CORS setup needed, and relative image paths just work.
      proxy: {
        // Daniel's science service (science/server.py): spectral maps from the all-sky cube
        '/science': { target: 'http://127.0.0.1:8001', changeOrigin: true, timeout: 300000 },
        '/api': { target: backend, changeOrigin: true },
        '/media': { target: backend, changeOrigin: true },
      },
    },
  }
})
