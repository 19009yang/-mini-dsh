/**
 * mini-dsh · LLM 统一词汇表
 *
 * 复刻 dsh-llm 的核心类型：提供方无关的消息与流式协议。
 * 适配器只负责"翻译"：把各家 wire 协议翻译成这套词汇表。
 */

/** 内容块：带 type 标签的可扩展联合 */
export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ToolCallBlock {
  type: 'tool-call'
  /** 工具调用 id：与 ToolResultBlock 配对 */
  id: string
  name: string
  /** 原始 JSON 字符串（模型产出的原样，不解析不重序列化） */
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock

/** 会话消息：角色 + 内容块数组 */
export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
}

/** 结束原因（可扩展） */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

/** 提供方无关的失败事实 */
export interface LlmFailure {
  message: string
  code: string
  status?: number
}

/** 用量 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * 流式增量协议（块级）。
 * 义务：块按首次出现分配 index；usage 必须在 finish 之前；
 * finish 之后不能再发任何 chunk；取消 → finish { kind: 'aborted' }。
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlock['type'] }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** 模型可见的工具 schema（JSON Schema） */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 一次完全装配好的模型请求 */
export interface GenerateOptions {
  provider: string
  model: string
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** 请求配置（agent/request 瀑布的替换单位） */
export interface LlmCallConfig {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
}

/** 增量组装器：把 StreamChunk 组装回消息（dsh 里叫 BlockAssembler） */
export class BlockAssembler {
  private blocks: ContentBlock[] = []
  private texts = new Map<number, string>()
  private toolArgs = new Map<number, { id: string; name: string; args: string }>()
  usage: TokenUsage | undefined
  finish: FinishReason | undefined

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start':
        this.texts.set(chunk.index, '')
        break
      case 'text-delta':
        this.texts.set(chunk.index, (this.texts.get(chunk.index) ?? '') + chunk.text)
        break
      case 'reasoning-delta':
        this.texts.set(chunk.index, (this.texts.get(chunk.index) ?? '') + chunk.text)
        break
      case 'tool-call-delta': {
        const cur = this.toolArgs.get(chunk.index) ?? { id: chunk.id, name: chunk.name ?? '', args: '' }
        cur.args += chunk.argumentsDelta
        if (chunk.name) cur.name = chunk.name
        this.toolArgs.set(chunk.index, cur)
        break
      }
      case 'block-end':
        this.blocks.push(chunk.block)
        break
      case 'usage':
        this.usage = chunk.usage
        break
      case 'finish':
        this.finish = chunk.reason
        break
    }
  }

  /** 组装后的消息（工具调用块由 block-end 提供，其余由 delta 拼出） */
  message(): Message {
    return { role: 'assistant', content: this.blocks }
  }

  /** 工具调用块列表（block-end 提供的 tool-call 块） */
  toolCalls(): ToolCallBlock[] {
    return this.blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call')
  }

  /** 纯文本输出（供 headless 模式打印） */
  text(): string {
    return this.blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }
}

/** 工具函数：把任意消息内容拍平成文本（日志与调试用） */
export function textOf(content: ContentBlock[] | string): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
}
