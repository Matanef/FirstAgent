import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // This creates a alias so /pollinations-api/ leads to the external site
      '/pollinations-api': {
        target: 'https://gen.pollinations.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pollinations-api/, ''),
      },
    },
  },
})