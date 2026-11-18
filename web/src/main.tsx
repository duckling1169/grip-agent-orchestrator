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

// Cache no authenticated data or chat content. The worker only supplies a disconnected page.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
