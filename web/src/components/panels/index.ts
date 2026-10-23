import type { Component } from "vue";
import WorkersPanel from "./WorkersPanel.vue";
import ProjectsPanel from "./ProjectsPanel.vue";
import BoardPanel from "./BoardPanel.vue";
import SessionPanel from "./SessionPanel.vue";
import AgentsPanel from "./AgentsPanel.vue";
import MemoryPanel from "./MemoryPanel.vue";
import SkillsPanel from "./SkillsPanel.vue";
import ProvidersPanel from "./ProvidersPanel.vue";
import McpPanel from "./McpPanel.vue";
import LessonsPanel from "./LessonsPanel.vue";
import CronPanel from "./CronPanel.vue";

export const TITLES: Record<string, string> = {
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

export const DESCRIPTIONS: Record<string, string> = {
  projects: "Named working directories for new conversations.",
  board: "Cards shared by you and the sessions in the selected project.",
  session: "Instructions, context, and tools for this conversation.",
  agents: "Delegated work in this conversation.",
  cron: "Reports that need checking, scheduled prompt jobs, and report history.",
  memory: "Search, save, and remove persistent facts.",
  skills: "Browse the instructions available to Luna.",
  providers: "Connect accounts and choose your default model.",
  mcp: "Connect external tools and manage their access.",
  lessons: "Review what Luna learned from past sessions before it changes skills or memory.",
};

export const PANELS: Record<string, { title: string; desc: string; component: Component }> = {
  workers: { title: "Execution machines", desc: "Register machines for file and command execution.", component: WorkersPanel },
  projects: {
    title: TITLES.projects,
    desc: DESCRIPTIONS.projects,
    component: ProjectsPanel,
  },
  board: {
    title: TITLES.board,
    desc: DESCRIPTIONS.board,
    component: BoardPanel,
  },
  session: {
    title: TITLES.session,
    desc: DESCRIPTIONS.session,
    component: SessionPanel,
  },
  agents: {
    title: TITLES.agents,
    desc: DESCRIPTIONS.agents,
    component: AgentsPanel,
  },
  cron: {
    title: TITLES.cron,
    desc: DESCRIPTIONS.cron,
    component: CronPanel,
  },
  memory: {
    title: TITLES.memory,
    desc: DESCRIPTIONS.memory,
    component: MemoryPanel,
  },
  skills: {
    title: TITLES.skills,
    desc: DESCRIPTIONS.skills,
    component: SkillsPanel,
  },
  providers: {
    title: TITLES.providers,
    desc: DESCRIPTIONS.providers,
    component: ProvidersPanel,
  },
  mcp: {
    title: TITLES.mcp,
    desc: DESCRIPTIONS.mcp,
    component: McpPanel,
  },
  lessons: {
    title: TITLES.lessons,
    desc: DESCRIPTIONS.lessons,
    component: LessonsPanel,
  },
};
