import { Routes, Route } from 'react-router-dom'
import { OverviewPage } from './pages/Overview'
import { MetricsPage } from './pages/Metrics'
import { BillingPageContainer as BillingPage } from './pages/Billing'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<OverviewPage />} />
      <Route path="/metrics" element={<MetricsPage />} />
      <Route path="/billing" element={<BillingPage />} />
    </Routes>
  )
}
