/**
 * mini-dsh · 事件总线
 *
 * 复刻 Cordis 事件系统的四种分发模式（emit / parallel / serial / waterfall）。
 * 事件签名通过 `declare module` 声明合并扩展——与真实 dsh 的做法一致。
 *
 * 设计要点：
 *   - 监听器是"注册"：注册返回 disposer，卸载时自动移除
 *   - waterfall 是环绕式中间件：不调 next() 即短路（否决）
 *   - serial 按序询问，非空返回值即"拍板"（bail）
 */

// 全局事件签名表：包内各处用 declare module 追加
export interface Events {}

/*定义一个Listener类型，用来给“事件监听函数”统一规定类型：
  - 它是一个函数；
  - 可以接收任意数量的参数：...args
  - 每个参数都可以是任意类型：any[]
  - 返回值也可以是任意类型：any
*/
type Listener = (...args: any[]) => any


//定义带监听函数和"是否要插到队列前面"的判断值Hook
  // prepend: true  → 放到监听器列表最前面，优先执行
  // prepend: false → 放到末尾，按正常顺序执行
export interface Hook {
  listener: Listener
  prepend: boolean
}

export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'waterfall'

/** 把一个事件类型对应的监听器函数类型提取出来
  - K：一个泛型参数，代表事件名。
  - K extends keyof Events：限制 K 必须是 Events 中存在的键，也就是只能是实际存在的事件名。
  - Events[K]：通过键 K 取出 Events 中对应属性的类型。*/
export type EventListener<K extends keyof Events> = Events[K]


export class EventBus {
  // private类型只能在类内访问
  private hooks = new Map<string, Hook[]>()
  
  /** 注册监听器（返回 disposer） */
  //此处返回无参函数体() => this.off(name, listener)，实现在调用  const unsubscribe = emitter.on("data", handler)时只注册
  //再调用unsubscribe()时调用emitter.off("data", handler)
  on<K extends keyof Events>(name: K, listener: Events[K], options?: { prepend?: boolean }): () => void {
    const list = this.hooks.get(name as string) ?? []
    const hook: Hook = { listener: listener as Listener, prepend: options?.prepend ?? false }
    if (hook.prepend){list.unshift(hook)}
    else {list.push(hook)}
    this.hooks.set(name as string, list)
    return () => this.off(name, listener)
  }

  once<K extends keyof Events>(name: K, listener: Events[K]): () => void {
    const off = this.on(name, ((...args: any[]) => {
      off()
      return (listener as Listener)(...args)
    }) as Events[K])
    return off
  }

  off<K extends keyof Events>(name: K, listener: Events[K]): void {
    const list = this.hooks.get(name as string)
    if (!list) return
    this.hooks.set(name as string, list.filter((h) => h.listener !== listener))//移除事件name的指定监听器
  }

  private resolve(name: string): Hook[] {
    return this.hooks.get(name) ?? []
  }

  /** 同步广播：按注册顺序执行，不等待异步，忽略返回值 */
  emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void {
    for (const hook of this.resolve(name as string)) {
      hook.listener(...args)
    }
  }

  /** 并发执行并等待全部；任一失败聚合成 AggregateError */
  async parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void> {
    const results = await Promise.allSettled(
      this.resolve(name as string).map((h) => h.listener(...args)),
    )
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (errors.length > 0) throw new AggregateError(errors.map((e) => e.reason))
  }

  /** 顺序执行，await 每个监听器，非 null/undefined/false 的返回值即拍板 */
  async serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<unknown> {
    for (const hook of this.resolve(name as string)) {
      const result = await hook.listener(...args)
      if (result !== null && result !== undefined && result !== false) return result
    }
    return undefined
  }

  /**
   * 环绕式中间件链。
   * 事件的监听器签名已包含最后的 next 参数（与真实 dsh 的声明方式一致），
   * 派发时把内置行为作为最后一个参数传入。
   */
  waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]> {
    const hooks = [...this.resolve(name as string)]
    const inner = args.pop() as () => any
    const next = (): any => {
      const hook = hooks.shift()
      if (hook) return hook.listener(...args, next)
      return inner()
    }
    return next() as ReturnType<Events[K]>
  }
}
