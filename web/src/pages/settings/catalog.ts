// User-facing organization only. The server's ConfigSchema remains the source of validation and defaults.
export const sections = [
  { id: 'general', title: 'Chat', description: 'Choose how Luna handles new messages and usage limits.', keys: ['busyInput', 'autoContinue', 'sessionTalk'] },
  { id: 'models', title: 'Models & accounts', description: 'Connect providers and choose models for each kind of work.', keys: ['provider', 'model', 'thinkingLevel', 'subagents', 'auxiliary', 'providers'] },
  { id: 'context', title: 'Memory & skills', description: 'Manage instructions, conversation context, and reusable knowledge.', keys: ['instructions', 'compaction', 'skillDirs'] },
  { id: 'images', title: 'Images', description: 'Choose how Luna reads and creates images.', keys: ['vision', 'image_gen', 'video'] },
  { id: 'tools', title: 'Tools & connections', description: 'Set up web access, browser control, commands, and external tools.', keys: ['web', 'browser', 'processes', 'mcpServers', 'extensions'] },
  { id: 'automation', title: 'Automation', description: 'Configure scheduled work and review what Luna learns.', keys: ['cron', 'learn', 'improve'] },
  { id: 'system', title: 'System', description: 'Set storage paths and server access. Inspect recorded usage.', keys: ['dataDir', 'cwd', 'server'] },
] as const

export const fieldTitles: Record<string, string> = {
  busyInput: 'Messages during a response', mode: 'Message handling', acknowledgements: 'Show message acknowledgements',
  sessionTalk: 'Messages between sessions', maxHops: 'Messages per exchange',
  autoContinue: 'Continue after usage limits', maxWaitHours: 'Maximum reset wait (hours)', maxAttempts: 'Consecutive retry limit',
  provider: 'Provider ID', model: 'Model ID', thinkingLevel: 'Thinking level', subagents: 'Subagent defaults',
  auxiliary: 'Task-specific models', side_question: 'Side questions', session_title: 'Session titles',
  providers: 'Custom provider definitions', id: 'ID', name: 'Display name', api: 'API format', baseUrl: 'Base URL', models: 'Models',
  contextWindow: 'Context window (tokens)', maxTokens: 'Maximum output (tokens)', reasoning: 'Supports reasoning',
  instructions: 'Default instructions', compaction: 'Automatic context summarization', triggerPercent: 'Context trigger (%)', skillDirs: 'Extra skill directories',
  video: 'Video analysis', vision: 'Image analysis', image_mode: 'Image analysis route', history_budget_bytes: 'History image budget (bytes)',
  long_edge: 'Maximum long edge (pixels)', hard_bytes: 'Image size limit (bytes)', max_calls_per_image: 'Main-agent calls per image',
  subagent_max_calls_per_image: 'Subagent calls per image', profiles: 'Vision profiles', tool_result_images: 'Allow tool-result images',
  image_gen: 'Image generation', 'openai-codex': 'OpenAI Codex options', quality: 'Image quality', codexHome: 'Codex home directory', codexCommand: 'Codex command',
  web: 'Web search & page extraction', searchProvider: 'Search provider', extractProvider: 'Page extraction provider',
  ddgs: 'DDGS search options', mcpServer: 'MCP connection name', backend: 'Search backend', region: 'Search region', safesearch: 'Safe search',
  browser: 'Browser control', camofox: 'Camofox options', processes: 'Background commands', retentionHours: 'Completed output retention (hours)',
  maxOutputBytes: 'Retained output per command (bytes)', mcpServers: 'Saved MCP definitions', extensions: 'Built-in tools',
  transport: 'Transport', enabled: 'Enabled', defer: 'Load tools on demand', timeoutMs: 'Tool timeout (milliseconds)',
  command: 'Command', args: 'Arguments', env: 'Environment variables', url: 'URL', headers: 'Headers',
  cron: 'Scheduled runs', notifyUrl: 'Notification URL', runTimeoutMinutes: 'Run timeout (minutes)',
  learn: 'Learning from conversations', idleMinutes: 'Idle time before a scan (minutes)', schedule: 'Schedule (cron expression)',
  improve: 'Skill improvement', allowCommandBenchmarks: 'Allow command benchmarks',
  dataDir: 'Data directory', cwd: 'Working directory', server: 'HTTP server', host: 'Listen address', port: 'Port',
}

const additions: Record<string, string> = { providers: 'provider', models: 'model', mcpServers: 'MCP server', skillDirs: 'skill directory', args: 'argument' }
export function labelFor(path: (string | number)[]): string {
  const key = path.at(-1)!
  const full = path.join('.')
  if (typeof key === 'number') return `${additions[String(path.at(-2))] || 'Item'} ${key + 1}`
  if (full === 'thinkingLevel') return 'Main thinking level'
  if (full === 'subagents.thinkingLevel') return 'Subagent thinking level'
  if (full === 'providers' || /providers\.\d+\.models\.\d+\.vision$/.test(full)) return full === 'providers' ? fieldTitles.providers! : 'Supports images'
  if (full === 'auxiliary.vision') return 'Auxiliary image analysis'
  if (full === 'web.providers' || full === 'browser.providers') return 'Provider options'
  if (full === 'browser.provider') return 'Browser provider'
  if (full === 'image_gen.provider') return 'Image generation provider ID'
  if (full === 'processes.enabled') return 'Enable background command starts'
  if (full === 'compaction.enabled') return 'Enable automatic compaction'
  if (full === 'autoContinue.enabled') return 'Continue automatically when a usage limit resets'
  if (full === 'sessionTalk.enabled') return 'Allow sessions to message each other'
  if (full.startsWith('vision.profiles.') && path.length === 3) return String(key)
  return fieldTitles[String(key)] || String(key).replace(/[_-]/g, ' ')
}

const fieldHelp: Record<string, string> = {
  'busyInput.mode': 'Interrupt redirects the response after tools finish safely. Queue sends a separate turn. Steer adds information at the next safe boundary.',
  'busyInput.acknowledgements': 'Show confirmation when a message is queued or used to steer a response.',
  'autoContinue.enabled': 'Wait for a usage reset, then continue the stopped turn. A new message cancels the wait. Authentication, billing, and context errors do not retry.',
  'autoContinue.maxWaitHours': 'Do not schedule a continuation when the reset is farther away than this limit.',
  'sessionTalk.enabled': 'Sessions can send messages to other sessions with session_send. A message waits for a busy session and never interrupts it.',
  'sessionTalk.maxHops': 'Messages two sessions can exchange before session_send refuses. A new message from you starts a new exchange.',
  'autoContinue.maxAttempts': 'Stop after this many consecutive continuations hit another usage limit.',
  'provider': 'Provider ID from the catalog or a custom definition below.',
  'model': 'Exact model ID. Keep any slashes that are part of the ID. New defaults must be available in the catalog or defined below.',
  'thinkingLevel': 'Applies to new sessions. The selected model can restrict the supported levels.',
  'subagents.cwd': 'Leave blank to use the parent conversation’s working directory.',
  'auxiliary.side_question': 'Override the model used for /btw side questions. Leave unset to use the normal default.',
  'auxiliary.session_title': 'Override the model used to name new conversations.',
  'auxiliary.vision': 'Image-capable model for auxiliary analysis. Select the analysis route in Images.',
  'instructions': 'Default instructions for new conversations. This does not rewrite instructions in existing conversations.',
  'compaction.triggerPercent': 'Summarize older context when estimated use reaches this percentage. Running tools finish first. Emergency overflow recovery stays enabled.',
  'skillDirs': 'Extra directories scanned after the skills folder inside your data directory.',
  'vision.image_mode': 'Native sends images to the active model. Auxiliary asks the image-analysis model configured in Models & accounts and returns text.',
  'vision.history_budget_bytes': 'Target byte budget for an image retained in conversation history. Smaller images reduce later request sizes.',
  'vision.long_edge': 'Resize larger images to this long-edge limit before sending them to a model.',
  'vision.hard_bytes': 'Hard byte limit for prepared image output.',
  'vision.max_calls_per_image': 'Maximum analysis calls for the same image in one turn. Zero means unlimited.',
  'vision.subagent_max_calls_per_image': 'Maximum analysis calls per image in a subagent turn. Zero means unlimited.',
  'vision.profiles': 'Use a provider ID or provider/model ID as the profile key. Model profiles take precedence over provider profiles.',
  'image_gen.provider': 'Set openai-codex to use the installed Codex image provider. Leave blank to keep image generation unselected.',
  'image_gen.openai-codex.model': 'This provider currently uses gpt-image-2.',
  'image_gen.openai-codex.quality': 'Higher quality can take longer and use more provider resources.',
  'image_gen.openai-codex.codexHome': 'Optional Codex configuration and credential directory. Leave blank to use the normal location.',
  'image_gen.openai-codex.codexCommand': 'Optional Codex executable. Leave blank to use the normal command.',
  'web.providers.ddgs.mcpServer': 'Name of a configured MCP connection that provides DDGS search and extraction tools.',
  'web.providers.ddgs.backend': 'Search backend accepted by your DDGS server. Use auto for automatic selection.',
  'web.providers.ddgs.region': 'Search region code, for example us-en or uk-en.',
  'browser.providers.camofox.mcpServer': 'Name of the MCP connection that provides Camofox browser tools.',
  'processes.enabled': 'Background commands have the same host access as bash. Completion resumes the owning chat. Normal shutdown stops commands.',
  'processes.retentionHours': 'How long completed command output remains available.',
  'processes.maxOutputBytes': 'Maximum retained output for each command. Extra output is truncated.',
  'mcpServers': 'Saved definitions need a restart. Use the connection manager for live connection changes. Secret markers preserve existing credentials.',
  'cron.notifyUrl': 'Optional notification endpoint for completed scheduled runs, for example an ntfy topic URL.',
  'cron.runTimeoutMinutes': 'Optional time limit for a scheduled run. Decimal minutes are allowed.',
  'learn.idleMinutes': 'Scan a conversation for lesson signals after this many idle minutes.',
  'learn.schedule': 'Five fields: minute, hour, day of month, month, day of week. The daily pass uses the host’s local time.',
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
  busyInput: 'Applies live', autoContinue: 'Applies live', sessionTalk: 'Applies live', compaction: 'Applies live',
  instructions: 'New conversations', subagents: 'New subagents', auxiliary: 'Next task', vision: 'Next image call', image_gen: 'Next image call',
}
export const summaries: Record<string, string> = {
  busyInput: 'Control what happens when you send another message while Luna is working.',
  autoContinue: 'Resume a turn after a rate or usage limit, within the limits you set.',
  sessionTalk: 'Let a session send messages to other sessions. Mention a session with @ in the chat box.',
  instructions: 'Set the instructions shared by new conversations.',
  compaction: 'Keep long conversations inside the model’s context window.',
  subagents: 'Delegated workers inherit the parent model and thinking level unless you set an override.',
  auxiliary: 'Use a different model for a specific task without changing the main chat model.',
  providers: 'Define custom APIs and their model capabilities. Account credentials are managed separately.',
  vision: 'Control the analysis route, image size, and per-turn call limits.',
  image_gen: 'Choose a generation provider and its image options. No image is generated by saving these settings.',
  web: 'Search and extraction use independent routes through a named MCP connection.',
  browser: 'Connect browser tools to a named Camofox MCP server.',
  processes: 'Allow long-running shell commands and choose how much output to retain.',
  mcpServers: 'Edit saved external-tool connections, including commands and protected credentials.',
  extensions: 'Choose the built-in capabilities available after Luna restarts.',
  skillDirs: 'Add local sources of reusable instructions.',
  cron: 'Set the limits and notifications used by scheduled prompts.',
  learn: 'Collect lesson signals from idle conversations. The daily pass applies routine fixes and holds critical ones for you.',
  improve: 'Schedule skill checks and control access to command benchmarks.',
  dataDir: 'Choose where Luna stores its persistent data.', cwd: 'Choose the default directory for tool commands.', server: 'Choose where the HTTP server listens.',
}

export const managers: Record<string, { id: string; title: string; description: string }[]> = {
  models: [
    { id: 'providers', title: 'Provider accounts', description: 'Sign in, save API keys, disconnect accounts, or add a live custom provider.' },
    { id: 'agents', title: 'Current subagents', description: 'Inspect delegated work in this conversation. Open or stop a child session.' },
  ],
  context: [
    { id: 'memory', title: 'Saved memory', description: 'Search facts and notes, save a memory, or forget an existing item.' },
    { id: 'skills', title: 'Skill library', description: 'Browse skills, read their instructions, and inspect linked files.' },
  ],
  tools: [{ id: 'mcp', title: 'Live MCP connections', description: 'Connect external tools, inspect status, enable, disable, or remove a managed server.' }, { id: 'workers', title: 'Execution machines', description: 'Connect machines for file and command execution.' }],
  automation: [
    { id: 'lessons', title: 'Review lessons', description: 'Decide on fixes Luna held as critical, inspect evidence, and roll back skill changes.' },
    { id: 'cron', title: 'Cron jobs & reports', description: 'Manage scheduled prompts and inspect their reports and run history.' },
  ],
  system: [{ id: 'analytics', title: 'Usage analytics', description: 'Filter model usage, compare tokens and recorded costs, and inspect reported tool usage.' }],
}
