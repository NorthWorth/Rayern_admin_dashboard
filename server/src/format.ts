export function formatCurrency(valueInCurrency: number, currency?: string): string {\n  const sym = currency || 'USD'\n  return `${sym}${valueInCurrency.toFixed(0)}`\n}

export function formatNumber(value: number): string {\n  return new Intl.NumberFormat('en-US').format(value)\n}

export function formatPeriod(period: string): string {\n  return period\n}

export function formatPct(value: number, decimals = 2): string {\n  return `${(value * 100).toFixed(decimals)}%`\n}

export function formatDate(iso: string): string {\n  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })\n}

export function formatDateTime(iso: string): string {\n  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })\n}
