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

let applySwUpdate = () => {}
applySwUpdate = registerSW({
  immediate: true,
  onNeedRefresh() {
    const shouldReload = window.confirm('Доступно обновление приложения. Перезагрузить сейчас?')
    if (!shouldReload) {
      return
    }

    applySwUpdate(true)
    window.setTimeout(() => {
      window.location.reload()
    }, 200)
  },
})

createRoot(document.getElementById('root')).render(
  <GlobalErrorBoundary>
    <App />
  </GlobalErrorBoundary>
)
