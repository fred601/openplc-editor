type DebugVariableRow = { index: number; name: string; type: string }

/**
 * xml2st --generate-debug writes VARIABLES.csv from variable_declaration.csv.j2:
 * `{index};VAR;{name};{name};{type};`
 */
const parseVariablesCsv = (content: string): DebugVariableRow[] => {
  const rows: DebugVariableRow[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(';')
    const index = Number(parts[0])
    if (!Number.isInteger(index)) continue
    const name = (parts[3] || parts[2] || '').trim()
    const type = (parts[4] || '').trim()
    if (!name) continue
    rows.push({ index, name, type })
  }
  return rows
}

export { parseVariablesCsv }
export type { DebugVariableRow }
