/**
 * mini-dsh · 会话日志（append-only 事实源）
 *
 * 复刻 dsh-session 的核心思想：
 *   - 追加式事件序列，只增不改
 *   - "模型可见即已记录"：deriveMessages() 从日志投影模型历史
 *   - fork：截取日志前缀生成子会话
 */
import type { Message } from '@mini-dsh/llm/types'

export interface SessionEvent<T = unknown> {
  /** 单调递增序号（= 追加前日志长度） */
  seq: number
  type: string
  data: T
  at: number
}

export class Session {
  readonly id: string
  readonly parentSession?: string
  private log: SessionEvent[] = []

  constructor(id: string, parentSession?: string) {
    this.id = id
    this.parentSession = parentSession
  }

  get events(): readonly SessionEvent[] {
    return this.log
  }

  get seq(): number {
    return this.log.length
  }

  /** 追加一条事件（append-only） */
  append<T>(type: string, data: T): SessionEvent<T> {
    const event: SessionEvent<T> = { seq: this.log.length, type, data, at: Date.now() }
    this.log.push(event as SessionEvent)
    return event
  }

  /** 从日志投影模型历史（只取模型可见的事件类型） */
  deriveMessages(): Message[] {
    const messages: Message[] = []
    for (const event of this.log) {
      switch (event.type) {
        case 'user/message': {
          const data = event.data as { message: Message }
          messages.push(data.message)
          break
        }
        case 'assistant/message': {
          const data = event.data as { message: Message }
          messages.push(data.message)
          break
        }
        case 'tool/result': {
          // 工具结果以 user-role 消息形式进入模型历史（与真实协议一致）
          const data = event.data as { toolCallId: string; content: Message['content']; isError?: boolean }
          messages.push({
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: data.toolCallId, content: data.content, isError: data.isError }],
          })
          break
        }
        default:
          break // turn/step 等边界事件不进入模型视野
      }
    }
    return messages
  }

  /** 分支：取日志前缀 [0, boundary] 生成子会话（boundary 需落在已完成的事件上） */
  fork(childId: string, boundary = this.log.length): Session {
    const child = new Session(childId, this.id)
    for (const event of this.log.slice(0, boundary)) {
      child.append(event.type, event.data)
    }
    return child
  }
}
