import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {import.meta.env?.VITE_DEMO === 'true' && <div className="demo-badge">交互演示 · 无真实 AI 生成</div>}
    <App />
  </StrictMode>,
)
