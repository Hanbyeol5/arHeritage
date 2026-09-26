import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages 프로젝트 사이트는 /<저장소명>/ 경로에서 서비스되므로 배포 시 BASE_PATH 를 지정한다.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '역사담 歷史談',
        short_name: '역사담',
        description: '유적지 현장에서 역사 속 인물을 만나 대화하는 웹앱',
        lang: 'ko',
        theme_color: '#f4ead9',
        background_color: '#f4ead9',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}', 'data/index.json', 'data/figures.json', 'figures/*'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/data/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'heritage-data', expiration: { maxEntries: 500 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'www.khs.go.kr',
            handler: 'CacheFirst',
            options: {
              cacheName: 'heritage-images',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
