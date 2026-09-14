/*
该部分用于复刻dsh中Cordis Context 的核心职责：
    - 服务注册表：provide(name, impl) / get(name)，插件用 inject 声明依赖
    - 插件加载：依赖未满足 → pending；服务齐了 → start；提供者卸载 → 级联 dispose
    - 可逆副作用：ctx.effect() 把 disposer 记到当前插件的账上
    - 事件总线：ctx.emit / waterfall / parallel / serial / on

与真实dsh中Cordis差异为：
    - 无 Proxy 代理（直接对象属性访问）
    - 无 isolate/intercept 作用域（服务名全局唯一）
    - 无 fiber 状态机与 HMR
*/


import { EventBus, type Events } from '@mini-dsh/events'
import type { Disposable, Plugin, PluginConfig, PluginInstance } from '@mini-dsh/plugin'
import { instantiate } from '@mini-dsh/plugin'

//各服务模块自行声明自己的“服务名 → 服务类型”映射，避免 context.ts 直接导入所有服务，减少循环依赖。
export interface Services {}

declare module '@mini-dsh/events' {
  interface Events {
    /** 服务被提供（监听者只读） */
    'service/provided'(name: string): void
    /** 服务被移除（提供者卸载） */
    'service/removed'(name: string): void
    /** 插件启动/卸载 */
    'plugin/started'(instance: PluginInstance): void
    'plugin/disposed'(instance: PluginInstance): void
  }
}

export class Context {
  readonly events = new EventBus() //属性初始化后，不能再被重新赋值
  private services = new Map<string, unknown>()
  private plugins = new Map<string, PluginInstance>()
  private pluginCounter = 0
  /** 当前正在启动的插件实例（effect 归属） */
  private current: PluginInstance | null = null

  // ── 服务注册表 ─────

  /** 提供（注册）一个服务；返回 disposer */
  provide<T = unknown>(name: string, impl: T): Disposable {
    if (this.services.has(name)) {
      throw new Error(`service "${name}" 已经被注册（每个服务只有一个提供者）`)
    }
    this.services.set(name, impl)
    this.events.emit('service/provided', name)
    this.wakePlugins()
    return () => {
      this.services.delete(name)
      this.events.emit('service/removed', name)
      this.unloadDependents(name)
    }
  }

  //判断该服务是否存在
  has(name: string): boolean {
    return this.services.has(name)
  }

  /** 读取服务（未提供时返回 undefined；严格模式抛错） */
  get<T = unknown>(name: string, strict = false): T | undefined {
    const impl = this.services.get(name)
    if (impl === undefined && strict) {
      throw new Error(`service "${name}" 尚未提供`)
    }
    return impl as T | undefined
  }

  // ── 插件加载 ────────────────────────────────────────────────────

  /** 挂载一个插件：依赖满足立即启动，否则 pending 等待 */
  plugin(plugin: Plugin, config?: PluginConfig): PluginInstance {
    const instance = instantiate(plugin, this, config)
    const id = `${instance.name}#${++this.pluginCounter}`//++ 写在变量前面，表示先+1再使用增加后的值
    this.plugins.set(id, instance)
    if (instance.inject.every((dep) => this.services.has(dep))) {
      void instance.start().then(() => this.events.emit('plugin/started', instance))
    } else {
      // pending：等服务就绪后由 wakePlugins 启动
    }
    return instance
  }

  /** 服务变化时，唤醒依赖已满足的 pending 插件 */
  private wakePlugins(): void {
    for (const instance of this.plugins.values()) {
      if (instance.state === 'pending' && instance.inject.every((dep) => this.services.has(dep))) {
        void instance.start().then(() => this.events.emit('plugin/started', instance))
      }
    }
  }

  /** 提供者卸载：级联卸载依赖它的插件 */
  private unloadDependents(serviceName: string): void {
    for (const instance of this.plugins.values()) {
      if (instance.state === 'active' && instance.inject.includes(serviceName)) {
        void instance.dispose().then(() => {
          this.events.emit('plugin/disposed', instance)
          instance.state = 'pending' // 等待新的提供者
        })
      }
    }
  }

  /** 卸载一个插件（按 id 或实例） */
  async unload(instance: PluginInstance): Promise<void> {
    for (const [id, inst] of this.plugins) {
      if (inst === instance) {
        await inst.dispose()
        this.plugins.delete(id)
        this.events.emit('plugin/disposed', inst)
        return
      }
    }
  }

  /** 卸载全部插件（进程退出时调用） */
  async dispose(): Promise<void> {
    for (const instance of [...this.plugins.values()].reverse()) {
      if (instance.state === 'active') await instance.dispose()
    }
    this.plugins.clear()
  }

  // ── 可逆副作用 ──────────────────────────────────────────────────

  /**
   * 注册一个 effect：body 返回 disposer。
   * 若在插件启动过程中调用，disposer 记到该插件的账上，随插件卸载执行。
   */
  effect(body: () => Disposable | void): Disposable {
    const disposer = body() ?? (() => {})
    if (this.current) {
      this.current.disposers.push(disposer)
    }
    return disposer
  }

  /** 事件监听（自动随当前插件卸载移除——见 effect） */
  on<K extends keyof Events>(name: K, listener: Events[K], options?: { prepend?: boolean }): () => void {
    const off = this.events.on(name, listener, options)
    if (this.current) {
      this.current.disposers.push(off)
    }
    return off
  }

  /** 标记当前正在启动的插件（由 PluginInstance.start 调用） */
  activate(instance: PluginInstance): void {
    this.current = instance
  }

  //取消标记
  deactivate(): void {
    this.current = null
  }
  //在执行插件期间，把当前插件实例记录到 Context.current，这样插件调用 ctx.effect()、ctx.on() 时，Context 才知道清理函数应该归属于哪个插件

  // ── 事件便捷方法 ────────────────────────────────────────────────

  emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void {
    this.events.emit(name, ...args)
  }

  parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void> {
    return this.events.parallel(name, ...args)
  }

  serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<unknown> {
    return this.events.serial(name, ...args)
  }

  waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]> {
    return this.events.waterfall(name, ...args)
  }
}
