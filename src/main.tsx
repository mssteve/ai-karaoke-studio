import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

window.addEventListener('error', (event) => {
  void window.karaoke?.reportRendererError(event.message, event.error?.stack)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.stack : String(event.reason)
  void window.karaoke?.reportRendererError('Unhandled renderer rejection', reason)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
