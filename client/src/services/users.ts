import { apiRequest, buildQuery, makePaged, USE_DEMO_DATA } from '../lib/api'
import type { AdminUserFilters, AdminUsersPage, Paged, User, UserFilters, UserStats } from '../lib/types'
import { buildUserStats, buildUsers } from './demoData'
import { campaignsService } from './campaigns'

const demoUsers = buildUsers()

function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function filterUsers(users: User[], filters: UserFilters): User[] {
  const search = filters.search?.trim().toLowerCase()
  return users.filter((u) => {
    if (filters.verification && filters.verification !== 'all' && u.verification !== filters.verification) return false
    if (filters.status && filters.status !== 'all' && u.status !== filters.status) return false
    if (search) {
      const haystack = `${u.name} ${u.email}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

function paginate<T>(items: T[], page = 1, pageSize = 25): Paged<T> {
  const start = (page - 1) * pageSize
  return makePaged(items.slice(start, start + pageSize), items.length, page, pageSize)
}

/**
 * Users domain service. Demo implementation below; real backend calls mirror
 * the same signatures so the UI never changes when the backend lands.
 */
export const usersService = {
  /**
   * The real account directory, read from Rayern's admin-users API through the
   * dashboard proxy. `campaignsService` already owns the single implementation
   * of that contract call, so this delegates instead of duplicating it.
   *
   * The local `accounts` table is NOT a user directory: nothing populates it in
   * production, which is why the previous list was always empty while the KPI
   * totals were correct.
   */
  directory(filters: AdminUserFilters = {}): Promise<AdminUsersPage> {
    return campaignsService.listUsers(filters)
  },

  /**
   * Local-table list — retained only for the Overview "recent registrations"
   * panel, which still reads the dashboard database. The Users page uses
   * `directory()` above.
   */
  list(filters: UserFilters & { page?: number; pageSize?: number }): Promise<Paged<User>> {
    if (USE_DEMO_DATA) {
      const filtered = filterUsers(demoUsers, filters)
      return delay(paginate(filtered, filters.page, filters.pageSize))
    }
    return apiRequest<Paged<User>>(`/users${buildQuery({ ...filters })}`)
  },

  stats(): Promise<UserStats> {
    if (USE_DEMO_DATA) return delay(buildUserStats(demoUsers))
    return apiRequest<UserStats>('/users/stats')
  },
}
