import { sections, labelFor, helpFor, timing, managers, searchKeywords, settingRoute, isVisibleSetting } from './catalog'

export interface SettingsResult {
  id: string
  title: string
  breadcrumb: string
  route: string
  keywords: string
  summary: string
  timing: string
  panel?: string
}
export function settingsIndex(schema: any, config: any): SettingsResult[] {
  const results: SettingsResult[] = []
  for (const section of sections) {
    for (const key of section.keys) {
      const walk = (node: any, path: (string | number)[]) => {
        if (!node || !isVisibleSetting(path)) return
        const title = labelFor(path)
        const value = path.reduce<any>((value, name) => value?.[name], config)
        // Index names and schema metadata, not credentials, paths, instruction bodies, or array contents.
        const summary = typeof value === 'boolean' ? (value ? 'Enabled' : 'Disabled') : Array.isArray(value) ? `${value.length} configured` : node.enum?.includes(value) ? String(value) : value == null ? 'Use default' : 'Configured'
        results.push({ id: path.join('.'), title, breadcrumb: [section.title, ...path.slice(0, -1).map((_, index) => labelFor(path.slice(0, index + 1)))].join(' → '), route: settingRoute(path), summary, timing: timing[key] || (section.id === 'connections' ? 'Actions apply immediately' : 'Applies live'), keywords: `${path.join('.')} ${path.map((_, index) => labelFor(path.slice(0, index + 1))).join(' ')} ${helpFor(path)} ${searchKeywords[key] || ''}` })
        // Providers and MCP use dedicated managers, not a second schema editor.
        if (section.id !== 'connections' && node.properties) for (const [name, child] of Object.entries(node.properties)) walk(child, [...path, name])
      }
      walk(schema?.properties?.[key], [key])
    }
    for (const item of managers[section.id] || []) results.push({ id: 'panel:' + item.id, title: item.title, breadcrumb: section.title, route: section.id, panel: item.id, summary: 'Open manager', timing: 'Actions apply immediately', keywords: item.description })
  }
  return results
}
export function matchSettings(index: SettingsResult[], query: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return index.filter(item => terms.every(term => `${item.title} ${item.breadcrumb} ${item.keywords}`.toLocaleLowerCase().includes(term)))
}
export function fieldLocation(path: string[]) {
  const section = sections.find(s => (s.keys as readonly string[]).includes(path[0]!))
  return section ? `${section.title} → ${labelFor([path[0]!])}` : ''
}
