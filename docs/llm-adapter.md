# 从零理解 `llm/adapter.ts`

本文解读 [`packages/mini-dsh/src/llm/adapter.ts`](../packages/mini-dsh/src/llm/adapter.ts)。阅读前只需知道：项目可能接入不同的模型提供方，例如 Mock 或兼容 OpenAI 协议的服务；它们的请求方式和返回格式可能不同。

## 先看它在做什么

这个文件提供两层接口：

1. **`LlmAdapter`（适配器）**规定每个提供方要实现什么：接收一次请求，逐个产出统一格式的 `StreamChunk`。
2. **`LlmRuntime`（运行时）**管理已注册的适配器，并根据请求中的 `provider` 找到对应适配器。

可以把运行时理解为分发台，把适配器理解为处理某个提供方请求的工作人员。调用关系如下：

```text
Agent 发起请求
    ↓
LlmRuntime.stream(options)
    ↓
llm/stream 中间件（如果注册了）
    ↓
根据 options.provider 选择适配器
    ↓
适配器产出 StreamChunk → 调用方逐个读取
```

例如 [`MockAdapter`](../packages/mini-dsh/src/llm/adapters/mock.ts) 会注册为 `mock`。当 `options.provider` 是 `'mock'` 时，请求便交给它处理。

## 先认识输入和输出

`GenerateOptions` 和 `StreamChunk` 定义在 [`types.ts`](../packages/mini-dsh/src/llm/types.ts)：

- `GenerateOptions` 表示一次模型请求，至少包含 `provider`、`model` 和 `messages`；还可以带工具、温度、取消信号等。
- `StreamChunk` 表示流中的一个片段，例如文本增量 `text-delta`、完整内容块 `block-end`、用量 `usage` 或结束标记 `finish`。

`AsyncIterable<StreamChunk>` 的意思是“可以异步逐个读取这些片段”。调用方使用 `for await...of`，不必等完整回答生成后才开始处理：

```ts
const stream = llm.stream(options)

for await (const chunk of stream) {
  // 每收到一个片段，就处理一次
  console.log(chunk)
}
```

## 按代码顺序阅读

### 1. 给类型系统补充服务和事件

`LlmProviderInfo` 只有 `id` 和 `name`：前者是路由用的提供方标识，后者是供界面显示的名称。

文件里的两个 `declare module` 是 **TypeScript 声明合并**，不会直接创建服务或事件。它们告诉编译器：

- `Context` 的服务表可以有一个名为 `llm` 的 `LlmRuntime`。
- 事件表可以有 `llm/stream` 和 `llm/adapters-updated`。

真正的服务注册发生在 `LlmRuntime` 构造时调用 `super(ctx, 'llm')`；具体机制在 [`Service`](../packages/mini-dsh/src/service.ts) 中。

### 2. `LlmAdapter`：规定适配器的形状

```ts
export abstract class LlmAdapter {
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>

  providerName(provider: string): string {
    return provider
  }
}
```

`abstract stream` 表示子类必须实现 `stream()`。无论底层服务返回什么格式，适配器都要将它转换成项目统一的 `StreamChunk` 流。`providerName()` 可以由子类覆盖；默认直接返回提供方标识。

### 3. `LlmRuntime`：注册和查找适配器

`adapters` 是一个 `Map<string, LlmAdapter>`。键是提供方标识，值是处理它的适配器。

`registerAdapter(providers, adapter)` 做三件事：先检查这些标识有没有被占用；再把每个标识映射到适配器；最后发出 `llm/adapters-updated` 事件。一个适配器可以对应多个提供方标识。重复注册会抛错。

它返回一个注销函数。映射注册完成后，清理动作会交给 `ctx.effect()` 管理：如果注册发生在插件启动期间，插件卸载时会自动注销这些映射；调用返回的函数也可以主动注销。`listProviders()` 则把当前注册的标识和显示名整理成数组。

### 4. `stream()`：先经过中间件，再分发

`stream(options)` 没有直接调用适配器，而是把最终分发函数交给 `ctx.waterfall('llm/stream', options, dispatch)`。

这里的 `waterfall` 是一条**环绕式中间件链**。监听器可以调用 `next()`，让请求继续走向下一个监听器或适配器；也可以自己返回一个 `AsyncIterable<StreamChunk>`，替换本次调用的流。具体的链式调用写在 [`events.ts`](../packages/mini-dsh/src/events.ts) 中。

没有中间件拦截时，`dispatch` 会进入私有方法 `adapterStream(options)`。按 `provider` 选适配器的动作发生在这里。

### 5. `adapterStream()`：处理找不到适配器和迭代异常

如果找不到对应适配器，它会产出一个 `finish`，其中 `reason.kind` 为 `'error'`、错误码为 `NO_ADAPTER`，然后结束流。这里不是直接 `throw`。

如果找到了，就用 `for await...of` 逐个读取适配器的片段，并原样交给上层。如果**迭代过程中抛出异常**，则输出一个结束片段：

- 请求的 `signal` 已取消：`finish` 的 `reason.kind` 为 `'aborted'`。
- 其他异常：`finish` 的 `reason.kind` 为 `'error'`，错误码为 `UNKNOWN`。

因此，调用方通常需要检查 `finish` 的原因，不能只凭 `for await...of` 没有抛错就认定请求成功。

## 把整个过程串起来

假设 Mock 插件已经调用 `registerAdapter(['mock'], new MockAdapter())`：

1. Agent 传入 `{ provider: 'mock', ... }`，调用 `llm.stream(options)`。
2. `llm/stream` 中间件有机会处理这次调用。
3. `adapterStream()` 从 `Map` 找到 `MockAdapter`。
4. `MockAdapter.stream()` 依次产出文本片段、`usage` 和 `finish`。
5. Agent 逐个读取片段，并用 [`BlockAssembler`](../packages/mini-dsh/src/llm/types.ts) 收集最终消息。

这里的分工是：`adapter.ts` 负责**路由和传递流**；各提供方适配器负责**生成统一格式的流**；`BlockAssembler` 负责**收集流中的内容块**。

## 一个需要留意的边界

`StreamChunk` 的协议注释要求 `usage` 出现在 `finish` 之前，并且 `finish` 后不再发送片段。`adapter.ts` **没有逐个校验这些规则**，只是转发适配器产出的片段。正常路径下，Mock 和 OpenAI 兼容适配器按先 `usage`、后 `finish` 的顺序发送；某些结束或异常路径可能只有 `finish`。写新适配器时，需要由适配器自身遵守流协议。
