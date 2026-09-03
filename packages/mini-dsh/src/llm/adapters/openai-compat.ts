/**
 * mini-dsh · OpenAI 兼容适配器（真实模型入口）
 *
 * 用 fetch + SSE 解析对接任意 OpenAI 兼容端点（DeepSeek / OpenAI / 自建网关）。
 * 翻译职责：
 *   统一词汇表 Message/GenerateOptions → chat/completions 请求
 *   SSE 流 → StreamChunk（text / reasoning / tool-calls / usage / finish）
 *
 * 注意 StreamChunk 协议义务：每个打开的块都要以 block-end 收尾，
 * usage 必须先于 finish 发出。
 *
 * 配置走环境变量：
 *   OPENAI_BASE_URL  默认 https://api.deepseek.com
 *   OPENAI_API_KEY   必填
 *   OPENAI_MODEL     默认 deepseek-chat
 */
import type { Context } from '@mini-dsh/context'
import type { FinishReason, GenerateOptions, StreamChunk } from '@mini-dsh/llm/types'
import { LlmAdapter } from '@mini-dsh/llm/adapter'
import type { LlmRuntime } from '@mini-dsh/llm/adapter'

export const name = 'openai-compat-adapter'
export const inject = ['llm'] as string[]

interface SseChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface OpenBlock {
  blockType: 'text' | 'reasoning'
  text: string
}

interface OpenToolCall {
  id: string
  name: string
  args: string
}

export class OpenAICompatAdapter extends LlmAdapter {
  constructor(private baseURL: string, private apiKey: string) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ── 统一词汇表 → wire 请求 ──
    const body = {
      model: options.model,
      messages: [
        ...(options.system ? [{ role: 'system', content: options.system }] : []),
        ...options.messages.map((m) => ({
          role: m.role,
          content: m.content.map((b) => {
            if (b.type === 'text') return { type: 'text', text: b.text }
            if (b.type === 'tool-call') {
              return { type: 'tool_call', id: b.id, function: { name: b.name, arguments: b.arguments } }
            }
            if (b.type === 'tool-result') {
              return {
                type: 'tool_result',
                tool_call_id: b.toolCallId,
                content: JSON.stringify(b.content.map((c) => (c.type === 'text' ? c.text : c.type))),
              }
            }
            return { type: b.type }
          }),
        })),
      ],
      ...(options.tools?.length ? {
        tools: options.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      stream: true,
    }

    const res = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }

    // ── SSE 解析 → StreamChunk ──
    // 块索引：0 = 文本；1+ = 工具调用（按 wire index 偏移）；reasoning 从工具之后顺延
    const textBlock: OpenBlock = { blockType: 'text', text: '' }
    let textStarted = false
    const reasoning = new Map<number, OpenBlock>()
    const toolCalls = new Map<number, OpenToolCall>()
    const toolBlockIdx = new Map<number, number>() // wire index → 块 index
    let nextFreeIndex = 1

    const finishReasonOf = (wire: string | null | undefined): FinishReason | undefined => {
      if (!wire) return undefined
      if (wire === 'tool_calls') return { kind: 'tool-calls' }
      if (wire === 'length') return { kind: 'max-tokens' }
      return { kind: 'stop' }
    }

    const emitBlockEnds = function* (): Generator<StreamChunk> {
      if (textStarted && textBlock.text.length >= 0) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: textBlock.text } }
      }
      for (const [idx, b] of reasoning) {
        yield { type: 'block-end', index: idx, block: { type: 'reasoning', text: b.text } }
      }
      for (const [idx, tc] of toolCalls) {
        yield {
          type: 'block-end', index: toolBlockIdx.get(idx) ?? idx + 1,
          block: { type: 'tool-call', id: tc.id, name: tc.name, arguments: tc.args },
        }
      }
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        options.signal?.throwIfAborted()
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          let json: SseChunk
          try {
            json = JSON.parse(payload)
          } catch {
            continue
          }
          const delta = json.choices?.[0]?.delta ?? {}

          if (delta.content) {
            if (!textStarted) {
              yield { type: 'block-start', index: 0, blockType: 'text' }
              textStarted = true
            }
            textBlock.text += delta.content
            yield { type: 'text-delta', index: 0, text: delta.content }
          }

          if (delta.reasoning_content) {
            const idx = nextFreeIndex++
            reasoning.set(idx, { blockType: 'reasoning', text: delta.reasoning_content })
            yield { type: 'block-start', index: idx, blockType: 'reasoning' }
            yield { type: 'reasoning-delta', index: idx, text: delta.reasoning_content }
          }

          for (const tc of delta.tool_calls ?? []) {
            const wireIdx = tc.index ?? 0
            if (!toolCalls.has(wireIdx)) {
              const idx = nextFreeIndex++
              toolBlockIdx.set(wireIdx, idx)
              toolCalls.set(wireIdx, { id: tc.id ?? `call-${wireIdx}`, name: tc.function?.name ?? '', args: '' })
              yield { type: 'block-start', index: idx, blockType: 'tool-call' }
            }
            const cur = toolCalls.get(wireIdx)!
            if (tc.function?.name) cur.name = tc.function.name
            if (tc.function?.arguments) {
              cur.args += tc.function.arguments
              yield {
                type: 'tool-call-delta', index: toolBlockIdx.get(wireIdx) ?? wireIdx + 1,
                id: cur.id, name: cur.name, argumentsDelta: tc.function.arguments,
              }
            }
          }

          const reason = finishReasonOf(json.choices?.[0]?.finish_reason)
          if (reason) {
            for (const c of emitBlockEnds()) yield c
            yield {
              type: 'usage',
              usage: {
                inputTokens: json.usage?.prompt_tokens ?? 0,
                outputTokens: json.usage?.completion_tokens ?? 0,
              },
            }
            yield { type: 'finish', reason }
            done = true
            return
          }
        }
      }
      // 流自然结束但没收到 finish_reason：兜底收尾
      for (const c of emitBlockEnds()) yield c
      yield { type: 'finish', reason: { kind: 'stop' } }
      done = true
    } catch (err) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
        return
      }
      if (!done) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: err instanceof Error ? err.message : String(err), code: 'UNKNOWN' } } }
      }
    }
  }
}

export function apply(ctx: Context): void {
  const apiKey = process.env.OPENAI_API_KEY
  const baseURL = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com'
  const adapter = new OpenAICompatAdapter(baseURL, apiKey ?? '')
  ctx.get<LlmRuntime>('llm', true)!.registerAdapter(['openai-compat'], adapter)
  console.log(`[openai-compat-adapter] provider "openai-compat" 已注册（baseURL=${baseURL}${apiKey ? '' : '，未配置 OPENAI_API_KEY'}）`)
}
