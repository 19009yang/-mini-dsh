/**
 * mini-dsh · LLM 接缝：适配器抽象 + 注册表
 *
 * 复刻 dsh-llm 的 LlmRuntime：
 *   - registerAdapter(providers, adapter)：一个路由一个适配器，注册是 effect
 *   - stream(options)：按 options.provider 选适配器，经 llm/stream 瀑布派发
 *   - 适配器异常归一化为 finish { kind: 'error' }
 */
import type { Context } from '@mini-dsh/context'
import { Service } from '@mini-dsh/service'
import type { GenerateOptions, LlmFailure, StreamChunk } from './types.js'

export interface LlmProviderInfo {
  id: string
  name: string
}

declare module '@mini-dsh/context' {
  interface Services {
    llm: LlmRuntime
  }
}

declare module '@mini-dsh/events' {
  interface Events {
    /** 环绕每一次流式调用；不调 next() 即用自定义流短路（测试/统计利器） */
    'llm/stream'(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
    /** 提供方拓扑变化 */
    'llm/adapters-updated'(): void
  }
}

/** 提供方适配器：只负责把一次请求翻译成 chunk 流 */
export abstract class LlmAdapter {
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>

  /** 可选：提供方显示名 */
  providerName(provider: string): string {
    return provider
  }
}

export class LlmRuntime extends Service {
  private adapters = new Map<string, LlmAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /** 注册适配器（一个路由一个适配器，重复注册抛错） */
  registerAdapter(providers: string[], adapter: LlmAdapter): () => void {
    for (const p of providers) {
      if (this.adapters.has(p)) {
        throw new Error(`LLM 错误 [DUPLICATE_ADAPTER]：provider "${p}" 已有适配器`)
      }
    }
    for (const p of providers) this.adapters.set(p, adapter)
    this.ctx.emit('llm/adapters-updated')
    // 注册是 effect：随宿主插件卸载自动注销
    return this.ctx.effect(() => () => {
      for (const p of providers) this.adapters.delete(p)
      this.ctx.emit('llm/adapters-updated')
    })
  }

  listProviders(): LlmProviderInfo[] {
    return [...this.adapters.keys()].map((id) => ({ id, name: this.adapters.get(id)!.providerName(id) }))
  }

  /** 流式调用：provider 选适配器，经 llm/stream 瀑布 */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const dispatch = (): AsyncIterable<StreamChunk> => this.adapterStream(options)
    return this.ctx.waterfall('llm/stream', options, dispatch) as AsyncIterable<StreamChunk>
  }

  /** 最终适配器边界：选择、派发、迭代失败都归一化为终止 finish */
  private async *adapterStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const adapter = this.adapters.get(options.provider)
    if (!adapter) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `没有 provider "${options.provider}" 的适配器`, code: 'NO_ADAPTER' } } }
      return
    }
    try {
      for await (const chunk of adapter.stream(options)) {
        yield chunk
      }
    } catch (err) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
        return
      }
      const failure: LlmFailure = {
        message: err instanceof Error ? err.message : String(err),
        code: 'UNKNOWN',
      }
      yield { type: 'finish', reason: { kind: 'error', failure } }
    }
  }
}
