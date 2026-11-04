// User-facing organization only. The server's ConfigSchema remains the source of validation and defaults.
export const sections = [
  { id: 'chat', title: 'Chat', description: 'Set instructions, message handling, and recovery behavior.', keys: ['instructions', 'compaction', 'busyInput', 'autoContinue', 'afterFailedRun', 'maxTurns', 'sessionTalk'] },
  { id: 'models', title: 'Models', description: 'Choose the main model, subagent defaults, and task-specific models.', keys: ['provider', 'model', 'thinkingLevel', 'pinnedModels', 'subagents', 'auxiliary'] },
  { id: 'connections', title: 'Accounts & connections', description: 'Connect provider accounts, external tools, and execution machines.', keys: ['providers', 'mcpServers'] },
  { id: 'tools', title: 'Tools', description: 'Configure web access, browser control, commands, and tool availability.', keys: ['web', 'browser', 'processes', 'codemode', 'extensions', 'disabledTools'] },
  { id: 'memory', title: 'Memory & skills', description: 'Configure reusable knowledge and learning from conversations.', keys: ['skillDirs', 'disabledSkills', 'learn'] },
  { id: 'media', title: 'Media', description: 'Configure image analysis, image generation, and video analysis.', keys: ['vision', 'image_gen', 'video'] },
  { id: 'automation', title: 'Automation', description: 'Set scheduled-run defaults and skill improvement behavior.', keys: ['cron', 'improve'] },
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
  return !['learn.schedule', 'image_gen.openai-codex.model'].includes(path.join('.'))
}
export function assertCatalogCoverage(schema: any) {
  const mapped = sections.flatMap(section => [...section.keys]) as string[]
  const missing = Object.keys(schema.properties || {}).filter(key => !mapped.includes(key))
  const duplicate = mapped.filter((key, index) => mapped.indexOf(key) !== index)
  if (missing.length || duplicate.length) throw new Error(`Settings catalog: missing ${missing.join(', ') || 'none'}; duplicate ${duplicate.join(', ') || 'none'}`)
}

export const fieldTitles: Record<string, string> = {
  compaction: 'Context compaction', sessions: 'Main sessions', backgroundAtTokens: 'Background threshold (tokens)', blockAtTokens: 'Blocking threshold (tokens)', keepRecentTokens: 'Recent context to keep (tokens)',
  codemode: 'Code Mode', memoryLimitBytes: 'Sandbox memory limit (bytes)', inlineBudget: 'Tool declaration budget (tokens)', pinned: 'Always-listed tools',
  busyInput: 'Messages during a response', mode: 'Message handling', acknowledgements: 'Show message acknowledgements',
  sessionTalk: 'Messages between sessions', maxHops: 'Messages per exchange',
  autoContinue: 'Continue after usage limits', maxWaitHours: 'Maximum reset wait (hours)', maxAttempts: 'Consecutive retry limit',
  provider: 'Provider ID', model: 'Model ID', thinkingLevel: 'Thinking level', pinnedModels: 'Pinned models', subagents: 'Subagent defaults',
  auxiliary: 'Task-specific models', side_question: 'Side questions', session_title: 'Session titles', review: 'Session review',
  providers: 'Provider accounts', id: 'ID', name: 'Display name', api: 'API format', baseUrl: 'Base URL', models: 'Models',
  contextWindow: 'Context window (tokens)', maxTokens: 'Maximum output (tokens)', reasoning: 'Supports reasoning',
  maxTurns: 'Tool rounds per run', instructions: 'Default instructions', afterFailedRun: 'Queued messages after a failed response', skillDirs: 'Extra skill directories',
  video: 'Video analysis', blocked_paths: 'Blocked local paths', blocked_hosts: 'Blocked URL hosts', timeout_ms: 'Video timeout (milliseconds)', vision: 'Image analysis', image_mode: 'Image analysis route', history_budget_bytes: 'History image budget (bytes)',
  long_edge: 'Maximum long edge (pixels)', hard_bytes: 'Image size limit (bytes)', max_calls_per_image: 'Main-agent calls per image',
  subagent_max_calls_per_image: 'Subagent calls per image', profiles: 'Vision profiles', tool_result_images: 'Allow tool-result images',
  image_gen: 'Image generation', 'openai-codex': 'OpenAI Codex options', 'chat-completions': 'Chat completions options', quality: 'Image quality', codexHome: 'Codex home directory', codexCommand: 'Codex command',
  web: 'Web search & page extraction', searchProvider: 'Search provider', searchFallbacks: 'Fallback search providers', extractProvider: 'Page extraction provider',
  searxng: 'SearXNG options', freeserp: 'FreeSerp options',
  ddgs: 'DDGS search options', mcpServer: 'MCP connection name', backend: 'Search backend', region: 'Search region', safesearch: 'Safe search',
  browser: 'Browser control', camofox: 'Camofox options', moli: 'Moli options', chromium: 'Chromium options', executablePath: 'Browser executable', headless: 'Headless', processes: 'Background commands', retentionHours: 'Completed output retention (hours)',
  maxOutputBytes: 'Retained output per command (bytes)', mcpServers: 'Saved MCP definitions', extensions: 'Built-in tool groups', disabledTools: 'Disabled tools', disabledSkills: 'Disabled skills',
  transport: 'Transport', enabled: 'Enabled', defer: 'Load tools on demand', timeoutMs: 'Tool timeout (milliseconds)',
  command: 'Command', args: 'Arguments', env: 'Environment variables', url: 'URL', headers: 'Headers',
  cron: 'Scheduled runs', notifyUrl: 'Notification URL', runTimeoutMinutes: 'Run timeout (minutes)',
  learn: 'Learning from conversations', idleMinutes: 'Idle time before a scan (minutes)', schedule: 'Schedule (cron expression)',
  improve: 'Skill improvement', allowCommandBenchmarks: 'Allow command benchmarks',
  dataDir: 'Data directory', cwd: 'Working directory', server: 'HTTP server', host: 'Listen address', port: 'Port', push: 'Android push notifications', serviceAccountFile: 'Firebase service-account key file',
}

const additions: Record<string, string> = { providers: 'provider', models: 'model', mcpServers: 'MCP server', skillDirs: 'skill directory', args: 'argument', tools: 'tool' }
export function labelFor(path: (string | number)[]): string {
  const key = path.at(-1)!
  const full = path.join('.')
  if (typeof key === 'number') return `${additions[String(path.at(-2))] || 'Item'} ${key + 1}`
  if (full === 'compaction.subagents') return 'Subagent sessions'
  if (full === 'subagents.profiles') return 'Child role profiles'
  if (full.startsWith('subagents.profiles.') && path.length === 3) return String(key)
  if (full.startsWith('subagents.profiles.') && key === 'tools') return 'Allowed tools'
  if (full.startsWith('subagents.profiles.') && key === 'context') return 'Starting context'
  if (full === 'thinkingLevel') return 'Main thinking level'
  if (full === 'subagents.thinkingLevel') return 'Subagent thinking level'
  if (full === 'providers' || /providers\.\d+\.models\.\d+\.vision$/.test(full)) return full === 'providers' ? fieldTitles.providers! : 'Supports images'
  if (full === 'auxiliary.video') return 'Video analysis model'
  if (full === 'auxiliary.video.model') return 'Video analysis model ID'
  if (full === 'auxiliary.video.provider') return 'Video analysis provider ID'
  if (full === 'auxiliary.vision') return 'Auxiliary image analysis'
  if (full === 'web.providers' || full === 'browser.providers') return 'Provider options'
  if (full === 'browser.provider') return 'Browser provider'
  if (full === 'image_gen.provider') return 'Image generation provider ID'
  if (full === 'processes.enabled') return 'Enable background command starts'
  if (full === 'autoContinue.enabled') return 'Continue automatically when a usage limit resets'
  if (full === 'sessionTalk.enabled') return 'Allow sessions to message each other'
  if (full.startsWith('vision.profiles.') && path.length === 3) return String(key)
  return fieldTitles[String(key)] || String(key).replace(/[_-]/g, ' ')
}

const fieldHelp: Record<string, string> = {
  'codemode.timeoutMs': 'Maximum script duration, including tool calls. Scripts can request a shorter deadline. Requires a restart.',
  'codemode.memoryLimitBytes': 'Maximum QuickJS memory per script. Does not limit memory used by tools. Requires a restart.',
  'codemode.inlineBudget': 'Token budget for tool declarations in the Code Mode prompt section. Requires a restart.',
  'codemode.pinned': 'Tools the Code Mode prompt section always lists first. Their cost counts against the budget. Requires a restart.',
  'busyInput.mode': 'Interrupt redirects the response after tools finish safely. Queue sends a separate turn. Steer adds information at the next safe boundary.',
  'busyInput.acknowledgements': 'Show confirmation when a message is queued or used to steer a response.',
  'autoContinue.enabled': 'Wait for a usage reset, then continue the stopped turn. A new message cancels the wait. Authentication, billing, and context errors do not retry.',
  'autoContinue.maxWaitHours': 'Maximum individual wait and total recovery time from the first failure. Longer waits remain paused.',
  'sessionTalk.enabled': 'Sessions can send messages to other sessions with session_send. A message waits for a busy session and never interrupts it.',
  'sessionTalk.maxHops': 'Messages two sessions can exchange before session_send refuses. A new message from you starts a new exchange.',
  'autoContinue.maxAttempts': 'Maximum automatic continuations per recovery. Restarts do not reset this budget. Delivery receipt checks do not count.',
  'provider': 'Provider ID from the catalog or a custom definition in Accounts & connections.',
  'model': 'Exact model ID. Keep any slashes that are part of the ID. New defaults must be available in the catalog or defined in Accounts & connections.',
  'thinkingLevel': 'Applies to new sessions. The selected model can restrict the supported levels.',
  'subagents.cwd': 'Leave blank to use the parent conversation’s working directory.',
  'subagents.profiles': 'Named child roles with exact tool allowlists, context defaults, and optional model overrides. Changes affect new children only. Supplying a map replaces the built-ins.',
  'auxiliary.side_question': 'Override the model used for /btw side questions. Leave unset to use the normal default.',
  'auxiliary.review': 'Model used by /review. Required: /review does not fall back to the session model. It reads code and cannot run tests.',
  'auxiliary.session_title': 'Override the model used to name new conversations.',
  'auxiliary.vision': 'Image-capable model for auxiliary analysis. Select the analysis route in Media.',
  'maxTurns': 'Stops a run after this many tool rounds. The round that reaches the limit finishes its tools, then the run ends as limit reached. Leave blank for no limit. This is not a time, token, or cost limit.',
  'subagents.maxTurns': 'Tool-round limit for new subagents. Leave blank to inherit the parent session limit.',
  'instructions': 'Default instructions for new conversations. This does not rewrite instructions in existing conversations.',
  'disabledTools': 'Hidden from the model and refused if called. Changes apply on the next model request after saving.',
  'disabledSkills': 'Hidden from the skills catalog and skill_view immediately after saving.',
  'skillDirs': 'Extra directories scanned after the skills folder inside your data directory.',
  'vision.image_mode': 'Native sends images to the active model. Auxiliary asks the image-analysis model configured in Models and returns text.',
  'vision.history_budget_bytes': 'Target byte budget for an image retained in conversation history. Smaller images reduce later request sizes.',
  'vision.long_edge': 'Resize larger images to this long-edge limit before sending them to a model.',
  'vision.hard_bytes': 'Hard byte limit for prepared image output.',
  'vision.max_calls_per_image': 'Maximum analysis calls for the same image in one turn. Zero means unlimited.',
  'vision.subagent_max_calls_per_image': 'Maximum analysis calls per image in a subagent turn. Zero means unlimited.',
  'vision.profiles': 'Use a provider ID or provider/model ID as the profile key. Model profiles take precedence over provider profiles.',
  'image_gen.provider': 'Set openai-codex to use the installed Codex image provider, or chat-completions to use an image model from a configured provider. Leave blank to keep image generation unselected.',
  'image_gen.chat-completions.provider': 'Provider ID of a configured OpenAI-compatible provider, for example cli-proxy-api or openrouter.',
  'image_gen.chat-completions.model': 'Image-output model ID from that provider, for example gemini-3.1-flash-image.',
  'image_gen.openai-codex.model': 'This provider currently uses gpt-image-2.',
  'image_gen.openai-codex.quality': 'Higher quality can take longer and use more provider resources.',
  'image_gen.openai-codex.codexHome': 'Optional Codex configuration and credential directory. Leave blank to use the normal location.',
  'image_gen.openai-codex.codexCommand': 'Optional Codex executable. Leave blank to use the normal command.',
  'web.providers.ddgs.mcpServer': 'Name of a configured MCP connection that provides DDGS search and extraction tools.',
  'web.providers.ddgs.backend': 'Search backend accepted by your DDGS server. Use auto for automatic selection.',
  'web.providers.ddgs.region': 'Search region code, for example us-en or uk-en.',
  'web.searchFallbacks': 'Tried in order when the search provider fails or returns no results.',
  'web.providers.searxng.url': 'Base URL of a SearXNG instance with the json format enabled.',
  'web.providers.searxng.timeoutMs': 'Time limit for one search request.',
  'web.providers.freeserp.url': 'Base URL of the FreeSerp API. No key is needed.',
  'web.providers.freeserp.timeoutMs': 'Time limit for one search request.',
  'browser.providers.chromium.executablePath': 'Path to a Chromium-based browser, such as Helium, on the machine that runs the browser.',
  'browser.providers.chromium.headless': 'Run the browser without a visible window.',
  'browser.providers.moli.executablePath': 'Path to the Moli binary. Luna starts it on a private loopback port.',
  'browser.providers.moli.profileDir': 'Optional directory where Moli keeps cookies and storage between runs.',
  'browser.providers.camofox.mcpServer': 'Name of the MCP connection that provides Camofox browser tools.',
  'processes.enabled': 'Background commands have the same host access as bash. Completion resumes the owning chat. Normal shutdown stops commands.',
  'processes.retentionHours': 'How long completed command output remains available.',
  'processes.maxOutputBytes': 'Maximum retained output for each command. Extra output is truncated.',
  'mcpServers': 'Saving connects, reconnects or disconnects changed servers. Secret markers preserve existing credentials.',
  'push.serviceAccountFile': 'Path to a Firebase Cloud Messaging service-account JSON key. Push stays off until you set it.',
  'cron.notifyUrl': 'Optional notification endpoint for completed scheduled runs, for example an ntfy topic URL.',
  'cron.runTimeoutMinutes': 'Optional time limit for a scheduled run. Decimal minutes are allowed.',
  'learn.idleMinutes': 'Scan a conversation for lesson signals after this many idle minutes.',
  'learn.schedule': 'Legacy compatibility field. Does not schedule or enable model review.',
  'learn.captureEnabled': 'Capture source pointers from idle sessions without model calls.',
  'learn.files': 'Explicitly enrolled project files: absolute path and non-global domain. Writes still need approval.',
  'improve.schedule': 'Optional five-field cron expression. Requires the cron and improve built-in tools.',
  'improve.allowCommandBenchmarks': 'Allow skill benchmarks to run shell commands on this host. Enable only for trusted benchmarks.',
  'dataDir': 'Stores Luna databases and managed skills. Relative paths use the configuration file’s directory.',
  'cwd': 'Default working directory for tools. Projects and conversations can override it.',
  'server.host': '127.0.0.1 accepts local connections only. 0.0.0.0 listens on all IPv4 interfaces. Protect network access with a server token.',
  'server.port': 'HTTP port used after restarting Luna.',
}
export function helpFor(path: (string | number)[]): string {
  const full = path.join('.')
  if (fieldHelp[full]) return fieldHelp[full]!
  const last = String(path.at(-1))
  if (last === 'defer') return 'Load tool definitions through tool_search instead of adding every tool to each prompt.'
  if (last === 'timeoutMs') return 'Maximum duration for an MCP tool call, in milliseconds.'
  if (last === 'contextWindow') return 'Use the model’s actual context capacity. An oversized value can delay context summarization.'
  if (last === 'maxTokens') return 'Maximum generated tokens per response. Leave blank to use the provider default.'
  if (last === 'tool_result_images') return 'Allow native images from tools for this profile. This cannot add image support to a text-only model.'
  if (last === 'headers' || last === 'env') return 'Saved values stay hidden. Leave secret markers unchanged to keep existing values.'
  return ''
}

export const timing: Record<string, string> = {
  provider: 'New conversations and scheduled runs', model: 'New conversations and scheduled runs', thinkingLevel: 'New conversations', disabledTools: 'Next model request', disabledSkills: 'Applies live', video: 'Next video call', busyInput: 'Applies live', autoContinue: 'Applies live', afterFailedRun: 'Applies live', maxTurns: 'New conversations', sessionTalk: 'Applies live',
  codemode: 'Restart required', dataDir: 'Restart required', cwd: 'Restart required', extensions: 'Disable live; enable may need restart', skillDirs: 'Restart required', processes: 'Restart required', server: 'Restart required', push: 'Restart required',
  instructions: 'New conversations', subagents: 'New subagents', auxiliary: 'Next task', vision: 'Next image call', image_gen: 'Next image call',
}
export const summaries: Record<string, string> = {
  compaction: 'Set separate context summarization thresholds for main sessions and subagents. Model-capacity safety limits still apply.',
  busyInput: 'Control what happens when you send another message while Luna is working.',
  autoContinue: 'Resume a turn after a rate or usage limit, within the limits you set.',
  sessionTalk: 'Let a session send messages to other sessions. Mention a session with @ in the chat box.',
  instructions: 'Set the instructions shared by new conversations.',
  subagents: 'Delegated workers inherit the parent model and thinking level unless you set an override.',
  auxiliary: 'Use a different model for a specific task without changing the main chat model.',
  providers: 'Define custom APIs and their model capabilities. Account credentials are managed separately.',
  vision: 'Control the analysis route, image size, and per-turn call limits.',
  image_gen: 'Choose a generation provider and its image options. No image is generated by saving these settings.',
  web: 'Search and extraction use independent providers. Search can fall back to other providers in order.',
  browser: 'Connect browser tools to a Camofox MCP server, a local Moli engine, or a local Chromium-based browser.',
  codemode: 'Run JavaScript workflows through existing Luna tools, with bounded memory and execution time.',
  processes: 'Allow long-running shell commands and choose how much output to retain.',
  mcpServers: 'Edit saved external-tool connections, including commands and protected credentials.',
  extensions: 'Disabling applies on the next call. Enabling a group that did not start at boot needs a restart.',
  disabledTools: 'Choose individual tools that Luna must not use.', disabledSkills: 'Choose skills to hide from Luna.',
  skillDirs: 'Add local sources of reusable instructions.',
  cron: 'Set the limits and notifications used by scheduled prompts.',
  learn: 'Collect lesson signals from idle conversations. Review proposed changes and their evidence before applying them.',
  improve: 'Schedule skill checks and control access to command benchmarks.',
  dataDir: 'Choose where Luna stores its persistent data.', cwd: 'Choose the default directory for tool commands.', server: 'Choose where the HTTP server listens.',
  push: 'Send Android notifications through Firebase Cloud Messaging.',
}

export interface RelatedDestination { id: string; title: string; description: string }
export const managers: Record<string, RelatedDestination[]> = {
  models: [{ id: 'agents', title: 'Current subagents', description: 'Inspect delegated work in this conversation.' }],
  connections: [{ id: 'workers', title: 'Execution machines', description: 'Register machines for file and command execution.' }],
  memory: [
    { id: 'memory', title: 'Saved memory', description: 'Search, save, and remove facts and notes.' },
    { id: 'skills', title: 'Skill library', description: 'Browse skills and read their instructions.' },
    { id: 'lessons', title: 'Review lessons', description: 'Review proposed changes and their evidence.' },
  ],
  automation: [{ id: 'cron', title: 'Cron jobs & reports', description: 'Manage scheduled work and read reports.' }],
}
export const searchKeywords: Record<string, string> = {
  instructions: 'prompt system instructions default chat', autoContinue: 'rate limit quota retry recovery resume',
  providers: 'API key OAuth login account custom provider endpoint subscription', mcpServers: 'MCP external server connection',
  skillDirs: 'skill folder directory source', disabledTools: 'tool availability permissions disable enable',
  disabledSkills: 'skill availability disable enable', auxiliary: 'task specific model',
  cron: 'scheduled job notification timeout reports', image_gen: 'image generation codex pictures',
}
