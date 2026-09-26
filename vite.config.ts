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
        name: 'AR 유적지 탐방',
        short_name: 'AR유적',
        description: '내 주변 유적지를 지도와 AR 카메라로 찾아보는 웹앱',
        lang: 'ko',
        theme_color: '#7a2e1d',
        background_color: '#f6f1e7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}', 'data/index.json'],
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
