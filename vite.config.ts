import { defineConfig } from 'vite';

export default defineConfig({
  // o painel de música vem de outro pacote: usa um Lit só
  resolve: { dedupe: ['lit', 'lit-html', 'lit-element', '@lit/reactive-element'] },
  build: {
    lib: { entry: 'src/omnium-home-3d.ts', formats: ['es'], fileName: () => 'omnium-home-3d.js' },
    outDir: 'dist',
    emptyOutDir: true,
  },
  // `npm run dev`: demo com HA falso em http://localhost:5181 (e no tablet pela rede)
  server: { host: true, port: 5181, cors: true },
  // `npm run ha`: serve dist/omnium-home-3d.js na rede para o HA carregar direto do Mac
  preview: { host: true, port: 5182, cors: true },
});
