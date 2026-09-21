import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts'
import { formatCompact } from '../lib/utils'

const AXIS = { stroke: '#9aa2ae', fontSize: 11 }
const GRID = '#eef0f2'

const tooltipStyle = {
  borderRadius: 8,
  border: '1px solid #dee1e6',
  boxShadow: '0 4px 16px rgba(17,20,24,0.08)',
  fontSize: 12,
  padding: '8px 10px',
}

export function VolumeBarChart({ data, xKey, series }: { data: Array<Record<string, unknown>>; xKey: string; series: Array<{ key: string; name: string; color: string }> }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: '#dee1e6' }} minTickGap={30} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v)} />
        <Tooltip contentStyle={tooltipStyle} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={22} />
        ))}
        <Legend />
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * Time-series line chart. Accepts either date-only values ("2026-09-20")
 * or full ISO timestamps; labels are formatted accordingly.
 */
export function TrendLineChart({ data, dataKey, name, color = '#1f6f54', unit = '%' }: { data: Array<Record<string, unknown>>; dataKey: string; name: string; color?: string; unit?: string }) {
  const formatTick = (t: string): string => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t.slice(5) // date-only → MM-DD
    const d = new Date(t)
    return Number.isNaN(d.getTime()) ? t : `${d.getHours()}:00`
  }
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="time" tick={AXIS} tickLine={false} axisLine={{ stroke: '#dee1e6' }} tickFormatter={formatTick} minTickGap={40} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}${unit}`} />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => (String(t).length === 10 ? String(t) : new Date(String(t)).toLocaleString())} />
        <Line type="monotone" dataKey={dataKey} name={name} stroke={color} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
