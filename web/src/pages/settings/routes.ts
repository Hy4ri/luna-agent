// Settings navigation only. Small and eager: the app store resolves routes before the settings page loads.
// The full catalog (titles, help, summaries) is in catalog.ts and loads with the settings page or palette.
export const sections = [
  { id: 'chat', title: 'Chat', description: 'Set instructions, message handling, and recovery behavior.', keys: ['instructions', 'compaction', 'busyInput', 'autoContinue', 'afterFailedRun', 'maxTurns', 'sessionTalk', 'boardAuto'] },
  { id: 'models', title: 'Models', description: 'Choose the main model, subagent defaults, and task-specific models.', keys: ['provider', 'model', 'thinkingLevel', 'modelThinkingLevels', 'pinnedModels', 'subagents', 'auxiliary'] },
  { id: 'connections', title: 'Accounts & connections', description: 'Connect provider accounts, external tools, and execution machines.', keys: ['providers', 'mcpServers'] },
  { id: 'tools', title: 'Tools', description: 'Configure web access, browser control, commands, and tool availability.', keys: ['web', 'browser', 'processes', 'terminal', 'codemode', 'extensions', 'disabledTools'] },
  { id: 'memory', title: 'Memory & skills', description: 'Configure reusable knowledge.', keys: ['skillDirs', 'disabledSkills'] },
  { id: 'media', title: 'Media', description: 'Configure image analysis, image generation, and video analysis.', keys: ['vision', 'image_gen', 'video'] },
  { id: 'automation', title: 'Automation', description: 'Set scheduled-run defaults and skill benchmark access.', keys: ['cron', 'improve', 'wife'] },
  { id: 'system', title: 'System', description: 'Set LAN and Tailscale addresses, storage paths, and server access.', keys: ['dataDir', 'cwd', 'server', 'push'] },
] as const

const aliases: Record<string, string> = { general: 'chat', context: 'memory', images: 'media', workspace: 'memory' }
export function resolveSettingsRoute(route = 'chat') {
  const [raw = 'chat', ...rest] = route.split('/').filter(Boolean)
  const candidate = aliases[raw] || raw
  const category = sections.some(s => s.id === candidate) ? candidate : 'chat'
  return { category, target: category === candidate ? rest.map(part => { try { return decodeURIComponent(part) } catch { return part } }).join('.') : '' }
}
const groupIds: Record<string, string> = { provider: 'main-model', model: 'main-model', thinkingLevel: 'main-model', subagents: 'subagents', auxiliary: 'task-models', providers: 'providers', mcpServers: 'mcp', autoContinue: 'usage-limits', disabledTools: 'disabled-tools', disabledSkills: 'disabled-skills' }
export function groupFor(key: string) { return groupIds[key] || key }
export function settingRoute(path: (string | number)[]): string {
  const key = String(path[0])
  const section = sections.find(s => (s.keys as readonly string[]).includes(key))
  return [section?.id || 'chat', groupFor(key), ...(['provider', 'model', 'thinkingLevel'].includes(key) ? [key] : path.slice(1))].map(part => encodeURIComponent(String(part))).join('/')
}
export function isVisibleSetting(path: (string | number)[]) {
  return !['image_gen.openai-codex.model'].includes(path.join('.'))
}
