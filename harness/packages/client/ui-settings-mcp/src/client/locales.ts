/** `settings.mcp` namespace dictionaries (the MCP server card's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  title: 'MCP 服务器',
  description: '接入 Model Context Protocol 服务器，它们的工具会以 mcp__<名称>__<工具> 的形式提供给智能体。改动立即生效，不必重启。',
  empty: '还没有配置服务器。',
  add: '添加服务器',
  remove: '删除',
  enabledLabel: '启用',
  name: '名称',
  namePlaceholder: '例如 files',
  transport: '连接方式',
  stdio: '本地进程',
  http: 'HTTP',
  command: '命令',
  commandPlaceholder: '例如 npx',
  url: '地址',
  urlPlaceholder: 'https://…/mcp',
  args: '参数',
  argsPlaceholder: '空格分隔',
  nameHint: '名称会成为工具名的一部分，只能用字母、数字、下划线和连字符；改名等于换一台服务器。',
  advancedHint: '环境变量与请求头等更细的设置写在配置文件里。',
  duplicate: '名称重复，只有第一台会被挂载。',
  readOnly: '当前部署不允许修改设置。',
} satisfies Record<string, string>

/** The settings.mcp namespace key union. */
export type McpKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  title: 'MCP servers',
  description: 'Attach Model Context Protocol servers. Their tools reach the agent as mcp__<name>__<tool>. Changes apply immediately — no restart.',
  empty: 'No servers configured yet.',
  add: 'Add server',
  remove: 'Remove',
  enabledLabel: 'Enabled',
  name: 'Name',
  namePlaceholder: 'e.g. files',
  transport: 'Transport',
  stdio: 'Local process',
  http: 'HTTP',
  command: 'Command',
  commandPlaceholder: 'e.g. npx',
  url: 'URL',
  urlPlaceholder: 'https://…/mcp',
  args: 'Arguments',
  argsPlaceholder: 'space separated',
  nameHint: 'The name becomes part of every tool name; letters, digits, underscore and hyphen only. Renaming reads as a different server.',
  advancedHint: 'Environment variables and request headers live in the settings document.',
  duplicate: 'Duplicate name — only the first server is mounted.',
  readOnly: 'This deployment does not allow settings changes.',
} satisfies Record<McpKey, string>
