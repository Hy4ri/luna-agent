import { defineAsyncComponent, type Component } from "vue";

const TITLES: Record<string, string> = {
  projects: "Projects",
  board: "Project board",
  session: "Session",
  agents: "Subagents",
  cron: "Cron",
  memory: "Memory",
  skills: "Skills",
  providers: "Model providers",
  mcp: "MCP servers",
  lessons: "Lessons",
};

const DESCRIPTIONS: Record<string, string> = {
  projects: "Named working directories for new conversations.",
  board: "Cards shared by you and the sessions in the selected project.",
  session: "Instructions, context, and tools for this conversation.",
  agents: "Delegated work in this conversation.",
  cron: "Reports that need checking, scheduled prompt jobs, and report history.",
  memory: "Search, save, and remove persistent facts.",
  skills: "Browse the instructions available to Luna.",
  providers: "Connect accounts and manage custom provider definitions.",
  mcp: "Connect external tools and manage their access.",
  lessons: "Review what Luna learned from past sessions before it changes skills or memory.",
};

export const PANELS: Record<string, { title: string; desc: string; component: Component }> = {
  workers: {
    title: "Execution machines",
    desc: "Register machines for file and command execution.",
    component: defineAsyncComponent(() => import("./WorkersPanel.vue")),
  },
  projects: {
    title: TITLES.projects,
    desc: DESCRIPTIONS.projects,
    component: defineAsyncComponent(() => import("./ProjectsPanel.vue")),
  },
  board: {
    title: TITLES.board,
    desc: DESCRIPTIONS.board,
    component: defineAsyncComponent(() => import("./BoardPanel.vue")),
  },
  session: {
    title: TITLES.session,
    desc: DESCRIPTIONS.session,
    component: defineAsyncComponent(() => import("./SessionPanel.vue")),
  },
  agents: {
    title: TITLES.agents,
    desc: DESCRIPTIONS.agents,
    component: defineAsyncComponent(() => import("./AgentsPanel.vue")),
  },
  cron: {
    title: TITLES.cron,
    desc: DESCRIPTIONS.cron,
    component: defineAsyncComponent(() => import("./CronPanel.vue")),
  },
  memory: {
    title: TITLES.memory,
    desc: DESCRIPTIONS.memory,
    component: defineAsyncComponent(() => import("./MemoryPanel.vue")),
  },
  skills: {
    title: TITLES.skills,
    desc: DESCRIPTIONS.skills,
    component: defineAsyncComponent(() => import("./SkillsPanel.vue")),
  },
  providers: {
    title: TITLES.providers,
    desc: DESCRIPTIONS.providers,
    component: defineAsyncComponent(() => import("./ProvidersPanel.vue")),
  },
  mcp: {
    title: TITLES.mcp,
    desc: DESCRIPTIONS.mcp,
    component: defineAsyncComponent(() => import("./McpPanel.vue")),
  },
  webhooks: {
    title: "Webhooks",
    desc: "Receive events from other services and send Luna events out.",
    component: defineAsyncComponent(() => import("./WebhooksPanel.vue")),
  },
  lessons: {
    title: TITLES.lessons,
    desc: DESCRIPTIONS.lessons,
    component: defineAsyncComponent(() => import("./LessonsPanel.vue")),
  },
};
