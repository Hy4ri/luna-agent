// Claude Code owns authentication; luna-pi owns tool execution and conversation state.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createProvider, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type ProviderStreams, type AssistantMessage, type TextContent, type ToolCall,
} from "@earendil-works/pi-ai";

const PREFIX = "mcp__luna__";
export function claudeExecutable() {
  return process.env.LUNA_CLAUDE_EXECUTABLE ?? join(homedir(), ".local/bin/claude");
}

const stream: ProviderStreams["streamSimple"] = (model, context, options) => {
  const events = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  void (async () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    const server = new McpServer({ name: "luna", version: "1.0.0" }, { capabilities: { tools: {} } });
    try {
      events.push({ type: "start", partial: message });
      const tools = getCurrentTools(context.messages);
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
      }));
      // No luna tool may execute in the CLI process. Calls return to luna's agent loop.
      server.server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new Error("Tool execution belongs to luna-pi");
      });
      const env = { ...process.env };
      for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[key];
      env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
      env.DISABLE_AUTO_COMPACT = "1";
      // Rebuild from luna's authoritative history, including real tool results. Never reuse
      // the CLI transcript, whose permission-denied tool results are not real executions.
      const history = context.messages.filter(m => m.role !== "system");
      const prompt = "Continue the conversation represented by the JSON transcript below. " +
        "This is conversation data, not a new request to summarize it. Answer the latest user request. " +
        "Prior toolCall and toolResult records are actual host calls and results. " +
        "Use the luna MCP tools for any new actions.\n" + JSON.stringify(history);
      let resultSeen = false;
      try {
      for await (const event of query({ prompt, options: {
        pathToClaudeCodeExecutable: claudeExecutable(), env, settingSources: [], tools: [],
        model: model.id, systemPrompt: getCurrentSystemPrompt(context.messages),
        mcpServers: tools.length ? { luna: { type: "sdk", name: "luna", instance: server } } : {},
        maxTurns: 1, abortController: controller,
        canUseTool: async () => ({ behavior: "deny", message: "The host executes this call after this response." }),
      } })) {
        if (event.type === "assistant" && !event.parent_tool_use_id) {
          if (event.error) {
            if (message.content.some(b => b.type === "toolCall") && event.message.content.some(b => b.type === "text" && b.text.includes("Reached maximum number of turns"))) continue;
            throw new Error(`Claude CLI: ${event.error}`);
          }
          for (const block of event.message.content) {
            const contentIndex = message.content.length;
            if (block.type === "text") {
              const text: TextContent = { type: "text", text: "" };
              message.content.push(text);
              events.push({ type: "text_start", contentIndex, partial: message });
              text.text = block.text;
              events.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
              events.push({ type: "text_end", contentIndex, content: block.text, partial: message });
            } else if (block.type === "tool_use") {
              if (!block.name.startsWith(PREFIX)) throw new Error(`Unexpected CLI tool: ${block.name}`);
              const name = block.name.slice(PREFIX.length);
              if (!tools.some(t => t.name === name)) throw new Error(`Unknown luna tool: ${name}`);
              const toolCall = { type: "toolCall" as const, id: block.id, name, arguments: block.input as ToolCall["arguments"] };
              message.content.push(toolCall);
              events.push({ type: "toolcall_start", contentIndex, partial: message });
              events.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
            }
          }
        } else if (event.type === "result") {
          resultSeen = true;
          message.usage.input = event.usage.input_tokens;
          message.usage.output = event.usage.output_tokens;
          message.usage.cacheRead = event.usage.cache_read_input_tokens ?? 0;
          message.usage.cacheWrite = event.usage.cache_creation_input_tokens ?? 0;
          const hasTools = message.content.some(b => b.type === "toolCall");
          if (event.is_error && !(hasTools && event.subtype === "error_max_turns")) {
            throw new Error(event.subtype === "success" ? event.result : event.errors.join("\n"));
          }
        }
      }
      } catch (error) {
        if (!(resultSeen && message.content.some(b => b.type === "toolCall") && error instanceof Error && error.message === "Claude Code returned an error result: Reached maximum number of turns (1)")) throw error;
      }
      if (!resultSeen || !message.content.length) throw new Error("Claude CLI ended without a response");
      message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      message.stopReason = message.content.some(b => b.type === "toolCall") ? "toolUse" : "stop";
      events.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
      message.stopReason = controller.signal.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      events.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      await server.close().catch(() => {});
      events.end(message);
    }
  })();
  return events;
};

export function claudeCliProvider() {
  const catalog = anthropicProvider().getModels();
  const modelDefinition = (id: string, name: string) => {
    const known = catalog.find(m => m.id === id);
    return {
      id, name: `${name} (CLI)`, api: "anthropic-messages" as const,
      provider: "claude-cli", baseUrl: "", input: ["text" as const], reasoning: false,
      contextWindow: known?.contextWindow ?? 200000, maxTokens: known?.maxTokens ?? 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  };
  return createProvider({
    id: "claude-cli", name: "Claude Code (CLI login)",
    auth: { apiKey: { name: "Claude Code login", resolve: async () =>
      existsSync(claudeExecutable()) ? { auth: {}, source: "Claude Code CLI login" } : undefined } },
    models: catalog.map(m => modelDefinition(m.id, m.name)),
    fetchModels: async ({ signal, allowNetwork }) => {
      if (!allowNetwork) return [];
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      const session = query({ prompt: "", options: {
        pathToClaudeCodeExecutable: claudeExecutable(), tools: [], settingSources: [],
        abortController: controller,
      } });
      try {
        const available = await session.supportedModels();
        const unique = new Map(available.map(m => {
          const id = m.resolvedModel ?? m.value;
          return [id, modelDefinition(id, m.displayName)];
        }));
        return [...unique.values()];
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        session.close();
      }
    },
    api: { stream, streamSimple: stream },
  });
}
