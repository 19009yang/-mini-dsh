/**
 * mini-dsh · 系统提示词装配
 *
 * 复刻 dsh-system-prompt 的核心：
 *   - section 注册有序片段（order 升序拼接）
 *   - 支持 {{variable}} 插值
 *   - assemble() 同时收集工具 schema（来自 tools 服务）
 */
import type { Context } from '@mini-dsh/context'
import { Service } from '@mini-dsh/service'
import type { ToolRegistry } from '@mini-dsh/agent/tools'

declare module '@mini-dsh/context' {
  interface Services {
    systemPrompt: SystemPrompt
  }
}

declare module '@mini-dsh/events' {
  interface Events {
    /** 装配提示词（waterfall：监听器可增删片段） */
    'system-prompt/assemble'(assembly: PromptAssembly, next: () => PromptAssembly): PromptAssembly
  }
}

export interface PromptSection {
  name: string
  /** 升序拼接。约定：-100 身份、0 persona、100–199 工具引导 */
  order: number
  text: string
}

export interface PromptAssembly {
  sections: PromptSection[]
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}

export class SystemPrompt extends Service {
  private sections: PromptSection[] = []

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  section(section: PromptSection): () => void {
    this.sections.push(section)
    this.sections.sort((a, b) => a.order - b.order)
    return this.ctx.effect(() => () => {
      const i = this.sections.indexOf(section)
      if (i >= 0) this.sections.splice(i, 1)
    })
  }

  /** 组装：收集片段 + 工具 schema，经 system-prompt/assemble 瀑布 */
  assemble(): PromptAssembly {
    const tools = this.ctx.get<ToolRegistry>('tools')?.schemas() ?? []
    const base: PromptAssembly = { sections: [...this.sections], tools }
    return this.ctx.waterfall('system-prompt/assemble', base, () => base) as PromptAssembly
  }

  /** 渲染成最终 system 文本（{{var}} 插值 + 空行连接） */
  render(assembly: PromptAssembly, variables: Record<string, string> = {}): string {
    const parts: string[] = []
    for (const section of assembly.sections) {
      const text = section.text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`)
      const trimmed = text.trim()
      if (trimmed) parts.push(trimmed)
    }
    return parts.join('\n\n')
  }
}
