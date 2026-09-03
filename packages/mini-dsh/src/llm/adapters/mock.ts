/**
 * mini-dsh · Mock 适配器
 *
 * 不发网络请求的"假模型"，教学与测试的基石：
 *   - 普通对话：回显用户输入
 *   - 请求带 echo 工具且任务含 "echo" 时：第一步发起工具调用，
 *     第二步基于工具结果作答（演示完整工具循环）
 */
import type { Context } from '@mini-dsh/context'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@mini-dsh/llm/types'
import { LlmAdapter, type LlmRuntime } from '@mini-dsh/llm/adapter'
import { textOf } from '@mini-dsh/llm/types'

export const name = 'mock-adapter'
export const inject = ['llm'] as string[]

function firstUserText(messages: GenerateOptions['messages']): string {
  // 取最后一条用户消息 = 当前任务（历史里有更早的用户消息）
  const user = [...messages].reverse().find((m) => m.role === 'user')
  return user ? textOf(user.content) : ''
}

function findToolResult(messages: GenerateOptions['messages']): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const block = m.content.find((b): b is Extract<ContentBlock, { type: 'tool-result' }> => b.type === 'tool-result')
    if (block) return textOf(block.content)
  }
  return ''
}

export class MockAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const echo = options.tools?.find((t) => t.name === 'echo')
    const task = firstUserText(options.messages)
    const toolResult = findToolResult(options.messages)

    const shouldCallEcho = Boolean(echo) && !toolResult && task.includes('echo')

    let text: string
    if (shouldCallEcho) {
      text = '我来调用 echo 工具验证一下。'
    } else if (toolResult) {
      text = `echo 工具返回了：「${toolResult}」。任务完成。`
    } else {
      text = `（Mock 模型，无网络无 Key）收到你的消息："${task.slice(0, 80)}"。`
    }

    try {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const piece of chunk3(text)) {
        options.signal?.throwIfAborted()
        await sleep(20) // 模拟流式节奏
        yield { type: 'text-delta', index: 0, text: piece }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }

      if (shouldCallEcho) {
        const args = JSON.stringify({ text: '来自 Mock 模型的问候' })
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id: 'call-echo-1', name: 'echo', argumentsDelta: args }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-echo-1', name: 'echo', arguments: args } }
      }

      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
      yield { type: 'finish', reason: shouldCallEcho ? { kind: 'tool-calls' } : { kind: 'stop' } }
    } catch (err) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
        return
      }
      throw err
    }
  }
}

function chunk3(text: string): string[] {
  return text.match(/[\s\S]{1,3}/g) ?? [text]
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 插件入口：把 Mock 适配器注册到 ctx.llm */
export function apply(ctx: Context): void {
  ctx.get<LlmRuntime>('llm', true)!.registerAdapter(['mock'], new MockAdapter())
  console.log('[mock-adapter] provider "mock" 已注册')
}
