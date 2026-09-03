/**
 * mini-dsh · Agent 与 turn/step 循环
 *
 * 复刻 dsh-agent-loop 的核心状态机：
 *   - turn = 一次唤醒；step = 一次模型请求 + 它发起的工具执行
 *   - 全部边界落盘（会话日志），全部决策点是事件（可拦截）
 *   - "模型可见即已记录"：请求历史 = session.deriveMessages()
 */
import type { Context } from '@mini-dsh/context'
import type { LlmCallConfig, Message } from '@mini-dsh/llm/types'
import { BlockAssembler } from '@mini-dsh/llm/types'
import { Session } from '@mini-dsh/agent/session'
import type { SystemPrompt } from '@mini-dsh/agent/system-prompt'
import type { ToolRegistry } from '@mini-dsh/agent/tools'
import type { LlmRuntime } from '@mini-dsh/llm/adapter'
import { Service } from '@mini-dsh/service'

declare module '@mini-dsh/context' {
  interface Services {
    agents: AgentRegistry
  }
}

declare module '@mini-dsh/events' {
  interface Events {
    /** 生命周期通知 */
    'agent/status'(agent: Agent, status: AgentStatus): void
    'session/event'(session: Session, event: { seq: number; type: string; data: unknown }): void
    /** 每步入口：reject 或 enter(messages)；不调 next() 即否决 */
    'agent/pre-step'(agent: Agent, messages: Message[], turn: number, step: number, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
    /** 每次请求的配置；返回替换值即生效 */
    'agent/request'(agent: Agent, turn: number, step: number, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /** turn 关闭前的最终检查点（serial） */
    'agent/turn-stopping'(agent: Agent, turn: number): void | Promise<void>
  }
}

export type AgentStatus = 'idle' | 'running'

export type PreStepDecision =
  | { kind: 'reject'; reason?: string }
  | { kind: 'enter'; messages: Message[] }

export interface AgentOptions {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  /** 系统提示词变量（{{var}} 插值） */
  persona?: string
  cwd?: string
}

export class Agent {
  readonly id: string
  readonly session: Session
  readonly options: AgentOptions
  status: AgentStatus = 'idle'

  private inbox: Message[] = []
  private turn = 0
  private running = false
  private abort: AbortController | null = null

  constructor(
    private ctx: Context,
    id: string,
    options: AgentOptions,
    parentSession?: string,
  ) {
    this.id = id
    this.options = options
    this.session = new Session(id, parentSession)
  }

  /** 排队一条用户消息并唤醒 */
  followup(message: Message): Promise<void> {
    this.inbox.push(message)
    return this.wake()
  }

  /** 注入模型可见上下文（下一条消息之后进入视野，不唤醒） */
  inject(message: Message): void {
    this.inbox.push(message)
  }

  /** 取消当前 turn */
  cancel(reason: string): void {
    this.abort?.abort(new Error(reason))
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return
    this.status = status
    this.ctx.emit('agent/status', this, status)
  }

  /** 驱动：清空 inbox 里的所有排队消息（每一条开启一个新 turn） */
  private async wake(): Promise<void> {
    if (this.running) {
      // 正在跑：消息已在 inbox，当前 turn 结束后会继续消费
      return new Promise<void>((resolve) => {
        const check = () => {
          if (!this.running && this.inbox.length === 0) {
            this.ctx.events.off('agent/status', check)
            resolve()
          }
        }
        this.ctx.on('agent/status', check)
      })
    }
    this.running = true
    this.setStatus('running')
    try {
      while (this.inbox.length > 0) {
        const message = this.inbox.shift()!
        await this.runTurn(message)
      }
    } finally {
      this.running = false
      this.setStatus('idle')
    }
  }

  /** 一次完整 turn */
  private async runTurn(message: Message): Promise<void> {
    this.turn += 1
    const turn = this.turn
    this.abort = new AbortController()
    this.session.append('turn/start', { turn })
    this.emitSession('turn/start', { turn })

    let step = 0
    let turnEndReason: string = 'completed'
    // 待进入下一步的消息：null 表示 turn 结束；
    // 工具循环后置空数组（工具结果已在日志里，无需新用户消息）
    let pending: Message[] | null = [message]

    try {
      while (pending !== null) {
        step += 1
        this.abort.signal.throwIfAborted()

        // ── agent/pre-step 瀑布：可 reject 或替换消息 ──
        const decision = await this.ctx.waterfall(
          'agent/pre-step', this, pending, turn, step,
          async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: pending! }),
        ) as PreStepDecision

        if (decision.kind === 'reject') {
          turnEndReason = `blocked: ${decision.reason ?? 'pre-step 拒绝'}`
          break
        }

        const entered = decision.messages
        pending = null

        this.session.append('step/start', { turn, step })
        this.emitSession('step/start', { turn, step })

        for (const m of entered) {
          this.session.append('user/message', { message: m })
          this.emitSession('user/message', { message: m })
        }

        const stepEnd = await this.runStep(turn, step)
        this.session.append('step/end', { turn, step })
        this.emitSession('step/end', { turn, step })

        if (stepEnd === 'tool-loop') {
          pending = [] // 有工具调用：再来一个 step（工具结果已在日志里）
          continue
        }
        if (stepEnd === 'max-tokens') turnEndReason = 'max-tokens'
        break
      }

      // ── 最终检查点（serial）──
      await this.ctx.serial('agent/turn-stopping', this, turn)
    } catch (err) {
      if (this.abort.signal.aborted) {
        turnEndReason = 'aborted'
      } else {
        turnEndReason = `error: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[agent ${this.id}] turn ${turn} 失败：`, err)
      }
    } finally {
      this.session.append('turn/end', { turn, reason: turnEndReason })
      this.emitSession('turn/end', { turn, reason: turnEndReason })
    }
  }

  /** 一次 step：请求模型 + 执行工具；返回 'tool-loop' 表示还有工具结果待消费 */
  private async runStep(turn: number, step: number): Promise<'done' | 'tool-loop' | 'max-tokens'> {
    // ── agent/request 瀑布：请求配置 ──
    const defaultConfig: LlmCallConfig = {
      provider: this.options.provider,
      model: this.options.model,
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
    }
    const config = await this.ctx.waterfall('agent/request', this, turn, step, async () => defaultConfig) as LlmCallConfig

    // ── 提示词装配 ──
    const assembly = this.ctx.get<SystemPrompt>('systemPrompt', true)!.assemble()
    const system = this.ctx.get<SystemPrompt>('systemPrompt', true)!.render(assembly, {
      model: config.model,
      cwd: this.options.cwd ?? process.cwd(),
    })

    this.session.append('request/header', { turn, step, config, system })
    this.emitSession('request/header', { turn, step, config, system })

    // ── 请求（历史从日志投影，模型可见即已记录）──
    const llm = this.ctx.get<LlmRuntime>('llm', true)!
    const stream = llm.stream({
      ...config,
      messages: this.session.deriveMessages(),
      system,
      tools: assembly.tools,
      signal: this.abort!.signal,
    })

    const assembler = new BlockAssembler()
    for await (const chunk of stream) {
      this.abort!.signal.throwIfAborted()
      this.session.append('assistant/chunk', { turn, step, chunk })
      this.emitSession('assistant/chunk', { turn, step, chunk })
      assembler.push(chunk)
    }

    const message = assembler.message()
    this.session.append('assistant/message', { turn, step, message, usage: assembler.usage })
    this.emitSession('assistant/message', { turn, step, message, usage: assembler.usage })

    if (assembler.finish?.kind === 'max-tokens') {
      return 'max-tokens'
    }
    if (assembler.finish?.kind === 'error' || assembler.finish?.kind === 'aborted') {
      const failure = assembler.finish.failure
      throw new Error(`模型请求失败 [${failure.code}] ${failure.message}`)
    }

    // ── 工具循环 ──
    const toolCalls = assembler.toolCalls()
    if (toolCalls.length === 0) return 'done'

    for (const call of toolCalls) {
      this.session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
      this.emitSession('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })

      let args: unknown
      try {
        args = JSON.parse(call.arguments)
      } catch {
        args = call.arguments
      }

      const exec = { callId: call.id, name: call.name, arguments: args, signal: this.abort!.signal }
      const result = await this.ctx.get<ToolRegistry>('tools', true)!.execute(exec)

      this.session.append('tool/result', {
        turn, step,
        toolCallId: call.id,
        content: result.content,
        isError: result.isError,
        error: result.isError ? result.error : undefined,
      })
      this.emitSession('tool/result', {
        turn, step,
        toolCallId: call.id,
        content: result.content,
        isError: result.isError,
        error: result.isError ? result.error : undefined,
      })
    }
    return 'tool-loop'
  }

  private emitSession(type: string, data: unknown): void {
    this.ctx.emit('session/event', this.session, { seq: this.session.seq - 1, type, data })
  }
}

/** 活跃 agent 注册表 */
export class AgentRegistry extends Service {
  private agents = new Map<string, Agent>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  create(id: string, options: AgentOptions, parentSession?: string): Agent {
    if (this.agents.has(id)) throw new Error(`agent "${id}" 已存在`)
    const agent = new Agent(this.ctx, id, options, parentSession)
    this.agents.set(id, agent)
    this.ctx.effect(() => () => {
      this.agents.delete(id)
    })
    return agent
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  list(): Agent[] {
    return [...this.agents.values()]
  }
}
