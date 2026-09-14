/**
 * mini-dsh · 入口
 *
 * 教学版 Agent Harness：复刻 DeepSeek Harness 的核心机制——
 * "一切皆插件"：上下文 + 事件总线 + 可逆副作用 + LLM 接缝 +
 * Agent 循环 + 工具管线 + 追加式会话日志。
 */
export { Context } from '@mini-dsh/context'
export { Service } from '@mini-dsh/service'
export { EventBus } from '@mini-dsh/events'
export type { Events, EventListener, DispatchMode } from '@mini-dsh/events'
export type { Plugin, PluginConfig, PluginInstance, Disposable } from '@mini-dsh/plugin'

export type {
  Message, ContentBlock, TextBlock, ReasoningBlock, ToolCallBlock, ToolResultBlock,
  StreamChunk, GenerateOptions, ToolSchema, LlmCallConfig, TokenUsage, FinishReason, LlmFailure,
} from './llm/types.js'
export { BlockAssembler, textOf } from './llm/types.js'
export { LlmAdapter, LlmRuntime } from './llm/adapter.js'
export { MockAdapter, apply as mockAdapterPlugin } from './llm/adapters/mock.js'
export { OpenAICompatAdapter, apply as openaiCompatAdapterPlugin } from './llm/adapters/openai-compat.js'

export { Session } from './agent/session.js'
export type { SessionEvent } from './agent/session.js'
export {
  ToolRegistry,
} from './agent/tools.js'
export type {
  ToolDefinition, ToolExecution, ToolExecutionResult,
  PreToolDecision, PostToolDecision,
} from './agent/tools.js'
export { SystemPrompt } from './agent/system-prompt.js'
export type { PromptSection, PromptAssembly } from './agent/system-prompt.js'
export { Agent, AgentRegistry } from './agent/agent.js'
export type { AgentOptions, AgentStatus, PreStepDecision } from './agent/agent.js'
