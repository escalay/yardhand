/**
 * Dev: `pnpm dev` serves the app on :5190 and proxies the API to a gateway (GATEWAY_ORIGIN, default the local one on
 * :4400). Sign in on the app's sign-in page with an owner key, as on a deployment without Access. Build: static files
 * the gateway serves at /app (and `landing.html` at /).
 */
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const target = process.env.GATEWAY_ORIGIN ?? 'http://localhost:4400'
const proxy = { target, changeOrigin: true }

/** In dev, `/` is the front page and everything under /app the app, as the gateway serves them. */
const frontPage = {
  name: 'front-page',
  configureServer: (server: {
    middlewares: { use: (handler: (req: { url?: string }, res: unknown, next: () => void) => void) => void }
  }) => {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url?.startsWith('/?')) req.url = `/landing.html${req.url.slice(1)}`
      next()
    })
  },
}

export default defineConfig({
  plugins: [frontPage, tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        landing: fileURLToPath(new URL('./landing.html', import.meta.url)),
      },
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5190,
    proxy: {
      '/api': proxy,
      '/mcp': proxy,
      '/openapi.json': proxy,
      '/llms.txt': proxy,
      '/docs': proxy,
      '/app/connect': proxy,
    },
  },
})
