import { defineConfig } from 'vite';

export default defineConfig({
  // o painel de música vem de outro pacote: usa um Lit só
  resolve: { dedupe: ['lit', 'lit-html', 'lit-element', '@lit/reactive-element'] },
  build: {
    lib: { entry: 'src/hadash-card.ts', formats: ['es'], fileName: () => 'hadash-card.js' },
    outDir: 'dist',
    emptyOutDir: true,
  },
  // `npm run dev`: demo com HA falso em http://localhost:5181 (e no tablet pela rede)
  server: { host: true, port: 5181, cors: true },
  // `npm run ha`: serve dist/hadash-card.js na rede para o HA carregar direto do Mac
  preview: { host: true, port: 5182, cors: true },
});
