/**
 * mini-dsh · 插件与可逆副作用
 *
 * 复刻 Cordis 的插件形态（函数/对象/类）与 effect 机制：
 *   - 插件声明 inject（依赖的服务名），依赖满足才启动
 *   - apply 期间注册的一切（监听器、服务、定时器）都是 effect
 *   - 卸载时按逆序执行 disposer
 */
import type { Context } from '@mini-dsh/context'

export type Disposable = () => void | Promise<void>

/** 插件配置：任意值（教学版不做 schema 校验，真实 dsh 用标准 schema 协议） */
export type PluginConfig = Record<string, unknown> | undefined

/** 插件三种形态 */
export type Plugin =
  | PluginFunction
  | PluginObject
  | PluginClass

export interface PluginBase {
  name?: string
  /** 依赖的服务名：全部就绪才启动 */
  inject?: string[]
}

export interface PluginFunction extends PluginBase {
  (ctx: Context, config?: PluginConfig): unknown | Promise<unknown>
}

export interface PluginObject extends PluginBase {
  apply(ctx: Context, config?: PluginConfig): unknown | Promise<unknown>
}

export interface PluginClass extends PluginBase {
  new (ctx: Context, config?: PluginConfig): unknown
}

/** 插件实例的运行状态 */
export interface PluginInstance {
  name: string
  inject: string[]
  state: 'pending' | 'starting' | 'active' | 'disposed'
  /** 该实例注册的 disposer（逆序执行） */
  disposers: Disposable[]
  /** 该实例提供的服务名 */
  provides: string[]
  /** 启动 apply（依赖满足时由 Context 调用） */
  start(): Promise<void>
  dispose(): Promise<void>
}

/**
 * 规范化任意插件形态为 PluginInstance。
 * 类的构造即 apply；函数与 { apply } 同理。
 */
export function instantiate(plugin: Plugin, ctx: Context, config?: PluginConfig): PluginInstance {
  const name = plugin.name ?? plugin.constructor?.name ?? 'anonymous'
  const inject = plugin.inject ?? []

  const disposers: Disposable[] = []
  const provides: string[] = []

  const instance: PluginInstance = {
    name,
    inject,
    state: 'pending',
    disposers,
    provides,
    async start() {
      this.state = 'starting' // 先标记，避免 provide 触发的 wakePlugins 重复启动自己
      ctx.activate(this) // 让 effect() 归属到当前实例
      if (typeof plugin === 'function') {
        await (plugin as PluginFunction)(ctx, config)
      } else if ('apply' in plugin) {
        await (plugin as PluginObject).apply(ctx, config)
      } else {
        new (plugin as PluginClass)(ctx, config) // 类：构造即 apply
      }
      ctx.deactivate()
      this.state = 'active'
    },
    async dispose() {
      ctx.deactivate()
      // 逆序执行 disposer（后注册的先拆）
      for (const d of [...disposers].reverse()) {
        await d()
      }
      disposers.length = 0
      this.state = 'disposed'
    },
  }
  return instance
}
