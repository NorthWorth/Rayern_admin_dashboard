export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  throw new Error('database not configured for tests')
}
