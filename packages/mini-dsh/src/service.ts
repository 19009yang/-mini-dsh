/**
 * mini-dsh · Service 基类
 *
 * 复刻 Cordis 的 Service：构造即注册（super(ctx, name)），
 * 服务随宿主插件卸载自动消失（provide 返回的 disposer 挂在当前插件的 effect 上）。
 */
import type { Context } from '@mini-dsh/context'

export abstract class Service {
  protected ctx: Context
  /** 服务名（注册到 ctx 的键） */
  readonly name: string

  constructor(ctx: Context, name: string) {
    this.ctx = ctx
    this.name = name
    // 注册是 effect：宿主插件卸载 → 服务自动注销
    ctx.effect(() => ctx.provide(name, this))
  }
}
