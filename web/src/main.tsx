import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'

const theme = matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => {
  document.documentElement.classList.toggle('dark', theme.matches)
  document.documentElement.style.colorScheme = theme.matches ? 'dark' : 'light'
}
applyTheme()
theme.addEventListener('change', applyTheme)
createRoot(document.getElementById('app')!).render(<App />)

// The worker caches the app shell only, never API data or chat content (see public/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
