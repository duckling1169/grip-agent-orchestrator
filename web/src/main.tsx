import { render } from 'preact'

import { App } from './App'
import './styles.css'

render(<App />, document.getElementById('app')!)

// Cache no authenticated data or chat content. The worker only supplies a disconnected page.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
