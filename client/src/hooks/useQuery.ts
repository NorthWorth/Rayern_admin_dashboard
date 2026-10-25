export function useQuery<T>(fetcher: () => Promise<T>, deps?: unknown[]): {
  data: T | null
  loading: boolean
  error: unknown | null
  refetch: () => Promise<T | null>
} {
  return {
    data: null,
    loading: true,
    error: null,
    refetch: async () => null,
  }
}
