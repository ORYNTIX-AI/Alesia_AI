import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { GlobalErrorBoundary } from './components/GlobalErrorBoundary.jsx'
import { registerSW } from 'virtual:pwa-register'

if (typeof window !== 'undefined' && 'caches' in window) {
  const staleAssetCaches = ['assets-cache']
  Promise.resolve().then(async () => {
    try {
      const cacheNames = await caches.keys()
      await Promise.all(
        cacheNames
          .filter((name) => staleAssetCaches.includes(name))
          .map((name) => caches.delete(name).catch(() => false))
      )
    } catch {
      // Cache cleanup failure should never block app startup.
    }
  })
}

registerSW({
  immediate: true,
  onNeedRefresh() {
    // Do not force-reload the page during an active voice session.
    // The new service worker will take effect on a later navigation.
  },
})

createRoot(document.getElementById('root')).render(
  <GlobalErrorBoundary>
    <App />
  </GlobalErrorBoundary>
)
