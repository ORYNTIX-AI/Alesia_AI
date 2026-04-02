import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { GlobalErrorBoundary } from './components/GlobalErrorBoundary.jsx'
import { registerSW } from 'virtual:pwa-register'

async function cleanupStaleAssetCaches() {
  if (typeof window === 'undefined' || !('caches' in window)) {
    return
  }

  try {
    const cacheNames = await caches.keys()
    await Promise.all(
      cacheNames
        .filter((name) => (
          name === 'assets-cache'
          || name === 'assets-cache-v2'
          || name.startsWith('workbox-precache')
        ))
        .map((name) => caches.delete(name).catch(() => false))
    )
  } catch {
    // Cache cleanup failure should never block app startup.
  }
}

let applySwUpdate = () => {}
applySwUpdate = registerSW({
  immediate: true,
  onNeedRefresh() {
    Promise.resolve()
      .then(() => cleanupStaleAssetCaches())
      .finally(() => {
        applySwUpdate(true)
        window.setTimeout(() => {
          window.location.reload()
        }, 150)
      })
  },
  onRegisteredSW(_swUrl, registration) {
    registration?.update?.().catch?.(() => {})
  },
})

Promise.resolve()
  .then(() => cleanupStaleAssetCaches())
  .finally(() => {
    createRoot(document.getElementById('root')).render(
      <GlobalErrorBoundary>
        <App />
      </GlobalErrorBoundary>
    )
  })
