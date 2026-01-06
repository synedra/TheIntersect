import { defineConfig } from "vite"

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [
    {
      name: 'gz-file-handler',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.endsWith('.gz')) {
            res.setHeader('Content-Type', 'application/gzip');
            res.setHeader('Content-Encoding', 'identity');
          }
          next();
        });
      }
    }
  ]
})

