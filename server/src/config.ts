export const config = {
  rayern: {
    syncEndpoint: process.env.RAYERN_SYNC_ENDPOINT ?? process.env.RAYERN_INTERNAL_DASHBOARD_METRICS ?? '',
    monitoringToken: process.env.RAYERN_MONITORING_TOKEN ?? '',
    timeoutMs: Math.max(5000, Number(process.env.RAYERN_SYNC_TIMEOUT_MS ?? '15000')),
    intervalMs: Math.max(10_000, Number(process.env.RAYERN_SYNC_INTERVAL_MS ?? '300000')),
  },
  billing: {
    currency: (process.env.PAYSTACK_CURRENCY ?? 'USD').toUpperCase(),
    gracePeriodDays: Math.max(0, Number(process.env.BILLING_GRACE_PERIOD_DAYS ?? '7')),
  },
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: {
    name: process.env.FROM_EMAIL_NAME ?? 'Rayern',
    address: process.env.FROM_EMAIL ?? 'no-reply@rayern.com.ng',
  },
  emailDryRun: process.env.EMAIL_DRY_RUN === '1',
  registrationTrendDays: Math.max(7, Math.min(365, Number(process.env.REGISTRATION_TREND_DAYS ?? '30'))),
}
