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
} from './llm/types'
export { BlockAssembler, textOf } from './llm/types'
export { LlmAdapter, LlmRuntime } from './llm/adapter'
export { MockAdapter, apply as mockAdapterPlugin } from './llm/adapters/mock'
export { OpenAICompatAdapter, apply as openaiCompatAdapterPlugin } from './llm/adapters/openai-compat'

export { Session } from './agent/session'
export type { SessionEvent } from './agent/session'
export {
  ToolRegistry,
} from './agent/tools'
export type {
  ToolDefinition, ToolExecution, ToolExecutionResult,
  PreToolDecision, PostToolDecision,
} from './agent/tools'
export { SystemPrompt } from './agent/system-prompt'
export type { PromptSection, PromptAssembly } from './agent/system-prompt'
export { Agent, AgentRegistry } from './agent/agent'
export type { AgentOptions, AgentStatus, PreStepDecision } from './agent/agent'
