/**
 * mini-dsh · 工具注册表与守卫式执行管线
 *
 * 复刻 dsh-tools 的核心：
 *   - register(def)：注册是 effect，schema 自动进入提示词装配
 *   - 执行管线：tools/pre-execute（waterfall 审批）→ execute → tools/post-execute（waterfall）
 *   - 双层输出：规范值（进模型）+ 渲染块（进日志）
 */
import type { Context } from '@mini-dsh/context'
import { Service } from '@mini-dsh/service'
import type { ContentBlock } from '@mini-dsh/llm/types'

declare module '@mini-dsh/context' {
  interface Services {
    tools: ToolRegistry
  }
}

declare module '@mini-dsh/events' {
  interface Events {
    /** 执行前审批：allow / deny / ask（不调 next() 即否决） */
    'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    /** 环绕执行：可换 signal、加超时 */
    'tools/execute'(exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /** 执行后：accept / block（可替换规范值） */
    'tools/post-execute'(exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
    /** 结果落盘通知（只读） */
    'tools/result'(exec: ToolExecution, result: ToolExecutionResult): void
  }
}

export interface ToolDefinition {
  name: string
  description: string
  /** 参数 JSON Schema（模型面 + 执行前校验） */
  parameters: Record<string, unknown>
  /** 执行函数：返回规范 JSON 值 */
  execute(args: unknown, exec: ToolExecution): Promise<unknown>
  /** 规范值 → 渲染块（日志与 UI 展示） */
  render(args: unknown, value: unknown): ContentBlock[]
}

/** 工具执行上下文：不可变身份 + 取消信号 */
export interface ToolExecution {
  callId: string
  name: string
  arguments: unknown
  signal?: AbortSignal
}

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export type PostToolDecision =
  | { kind: 'accept'; value?: unknown; content?: ContentBlock[] }
  | { kind: 'block'; feedback: ContentBlock[] }

export type ToolExecutionResult =
  | { isError: false; value: unknown; content: ContentBlock[]; error?: never }
  | { isError: true; error: { name: string; message: string }; content: ContentBlock[] }

export class ToolRegistry extends Service {
  private tools = new Map<string, ToolDefinition>()
  /** 单调守卫：任何插件都能最终拒绝（返回字符串 = 拒绝原因） */
  private guards: Array<(exec: ToolExecution) => string | undefined> = []

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(def: ToolDefinition): () => void {
    if (this.tools.has(def.name)) {
      throw new Error(`工具 "${def.name}" 已注册`)
    }
    this.tools.set(def.name, def)
    // 注册是 effect：宿主插件卸载 → 工具消失
    return this.ctx.effect(() => () => {
      this.tools.delete(def.name)
    })
  }

  guard(guard: (exec: ToolExecution) => string | undefined): () => void {
    this.guards.push(guard)
    return this.ctx.effect(() => () => {
      const i = this.guards.indexOf(guard)
      if (i >= 0) this.guards.splice(i, 1)
    })
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** 模型可见的 schema 列表（提示词装配用） */
  schemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  }

  /** 完整执行管线入口 */
  async execute(exec: ToolExecution): Promise<ToolExecutionResult> {
    const def = this.tools.get(exec.name)
    if (!def) {
      return { isError: true, error: { name: 'ToolNotFoundError', message: `未知工具 ${exec.name}` }, content: [] }
    }

    // ① 单调守卫（不可放松的最终拒绝）
    for (const guard of this.guards) {
      const reason = guard(exec)
      if (reason) {
        return this.denied(exec, reason)
      }
    }

    // ② pre-execute 审批瀑布
    const decision = await this.ctx.waterfall('tools/pre-execute', exec, async (): Promise<PreToolDecision> => ({ kind: 'allow' })) as PreToolDecision
    if (decision.kind === 'deny') {
      return this.denied(exec, decision.reason)
    }
    if (decision.kind === 'ask') {
      // 教学版无交互审批面：ask 降级为 deny（真实 dsh 由 user-approval 插件接管）
      return this.denied(exec, `需要用户审批（教学版无审批面）：${decision.reason ?? ''}`)
    }

    // ③ execute 瀑布（可换 signal / 加超时）
    const result = await this.ctx.waterfall('tools/execute', exec, async (): Promise<ToolExecutionResult> => {
      try {
        const value = await def.execute(exec.arguments, exec)
        return { isError: false, value, content: def.render(exec.arguments, value) }
      } catch (err) {
        return {
          isError: true,
          error: { name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) },
          content: [],
        }
      }
    }) as ToolExecutionResult

    // ④ post-execute 瀑布（可替换 / 阻断）
    const post = await this.ctx.waterfall('tools/post-execute', exec, result, async (): Promise<PostToolDecision> => ({ kind: 'accept' })) as PostToolDecision
    let final = result
    if (post.kind === 'accept' && post.value !== undefined) {
      final = { isError: false, value: post.value, content: post.content ?? def.render(exec.arguments, post.value) }
    }
    if (post.kind === 'block') {
      final = { isError: true, error: { name: 'Blocked', message: '工具结果被阻断' }, content: post.feedback }
    }

    // ⑤ result 只读通知
    this.ctx.emit('tools/result', exec, final)
    return final
  }

  private denied(exec: ToolExecution, reason: string): ToolExecutionResult {
    const result: ToolExecutionResult = {
      isError: true,
      error: { name: 'Denied', message: reason },
      content: [{ type: 'text', text: `拒绝执行：${reason}` }],
    }
    this.ctx.emit('tools/result', exec, result)
    return result
  }
}
