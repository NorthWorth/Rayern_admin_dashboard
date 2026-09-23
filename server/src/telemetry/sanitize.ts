/**
 * Redaction helpers for telemetry.
 *
 * Every value that reaches a span, a log line, or a telemetry table passes
 * through here first. Guarantees (enforced by telemetryTest.ts):
 *  - SQL parameters and inlined literals are never recorded
 *  - emails, UUIDs/identifiers and quoted values are stripped from messages
 *  - query strings / request bodies / headers are never read at all
 */

const MAX_SQL_LENGTH = 400
const MAX_MESSAGE_LENGTH = 300

/**
 * Reduces a SQL statement to a safe operation template:
 * single-quoted literals → `?`, comments removed, whitespace collapsed.
 * Parameter placeholders ($1) are kept — they carry no values.
 */
export function sanitizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SQL_LENGTH)
}

/** First SQL verb (SELECT, INSERT, …) upper-cased; 'QUERY' when unparseable. */
export function sqlOperation(sql: string): string {
  const m = /^\s*\(?\s*([a-z]+)/i.exec(sql)
  return m ? m[1].toUpperCase() : 'QUERY'
}

/** First table touched by `FROM`/`INTO`/`UPDATE`, when directly parseable. */
export function sqlTable(sql: string): string | null {
  const m = /\b(?:from|into|update)\s+([a-z_][a-z0-9_]*)/i.exec(sql)
  return m ? m[1] : null
}

/**
 * Makes an error message safe for spans/logs/tables:
 * emails → <email>, UUIDs → <id>, quoted literals → ?, then truncated.
 * Used for DB driver errors (whose messages can embed query values) and any
 * internal error text that telemetry records.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, '<email>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/"[^"]*"/g, '"?"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
}
