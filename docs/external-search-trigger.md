# 外部触发搜索契约（dsh-enhanced-workspace → 外部插件）

> 面向外部快捷键 / 命令插件（当前消费者：dsh-hotkey）。目标：让外部插件
> **驱动真实的搜索状态**（聚焦搜索框、写入/清空 query、拿到真实 input），
> 而不是猜 DOM 或模拟按键。
>
> 实现位置：`src/client/contract.ts`（契约与句柄）、`src/client/index.tsx`
> （slot 注册）、`src/client/Browser.tsx`（组件接入与镜像）。
> 本文与代码同级维护；改契约先改这里。

## 0. TL;DR

| 路径 | 发现方式 | 取得的东西 | 适用 |
| --- | --- | --- | --- |
| **① slot inject 句柄（首选）** | `ctx.slots.inject('enhanced-workspace.workspace.search', cb)` | `focus()` / `setQuery(query)` / `input()` / `available` | 有 React 的插件 / 常驻集成 |
| **② window 镜像** | `window.__DSH_ENHANCED_WORKSPACE__` | `focusSearch()` / `setSearchQuery(q)` / `searchInput()` / `searchAvailable()` / `querySelector` / `railButtonSelector` | 热键 action 的 `run`（无 React 访问） |
| **③ DOM 兜底** | `[data-dsh-enhanced-workspace="search"]`（输入框）、`[data-dsh-enhanced-workspace="search-button"]`（折叠态 rail 按钮） | 原生 DOM 事件 | 极端兜底 / slot 未声明前 |

推荐姿势与 dsh-hotkey 现有 action 一致：**①/② 优先，③ 兜底**。
三条路径指向同一份 React 状态：`focus()` 与 rail 搜索按钮跑**同一段手势**
（`searchOnExpand` + `expandSidebar()`），折叠态下会自动先展开再落焦。

## 1. Slot 契约

```ts
// src/client/contract.ts 导出
export const SEARCH_SLOT = 'enhanced-workspace.workspace.search' as const
```

- **kind / scope**：`single` / `root`（单占用者；根作用域，无 session 绑定）。
- **owner props**：`EnhancedSearchOwnerProps` —— 空对象（该 slot 不发 owner
  会话，只发 inject 能力；contrast `DIRECTORY_FLOW_SLOT` 的 open/onPicked 会话）。
- **公共 inject face**（每个注册进该 slot 的条目都会收到，即注册方组件 props）：

```ts
export interface EnhancedSearchHandle {
  /** 聚焦搜索框；折叠态自动先展开（内置 rail 手势），展开后落焦。 */
  focus: () => void
  /** 直接替换 query（'' 清空过滤）；折叠态写入的值在展开后保留。 */
  setQuery: (query: string) => void
  /** 当前真实 input 元素；折叠/未挂载时为 null。 */
  input: () => HTMLInputElement | null
  /** 浏览器区域已挂载（句柄是活的）时为 true。 */
  readonly available: boolean
}
```

外部插件注册示例（React 组件；`focus`/`setQuery` 直接来自 props）：

```tsx
export const inject = ['slots']

export function apply(ctx) {
  ctx.slots.inject(SEARCH_SLOT, () => ctx.slots.register(
    { name: SEARCH_SLOT, priority: 0, registrant: 'my-plugin' },
    function MySearchOccupant(props: { focus: () => void; setQuery: (q: string) => void }) {
      // 常驻捕获句柄：没有 UI 需求时返回 null 也是合法占用者。
      handleRef.current = props
      return null
    },
  ))
}
```

> 注意：`single` slot 的**同 priority 二次注册会抛错**（占位冲突），
> 占用者要么只注册一个，要么显式给不同 `priority`（低者渲染）。如果外部
> 插件只想**拿句柄、不想渲染**，`return null` 即可，不会干扰搜索框布局。

## 2. 全局镜像（热键 action 的 `run` 用这条）

`Browser.tsx` 在挂载期间把同一句柄镜像到：

```ts
window.__DSH_ENHANCED_WORKSPACE__ = {
  focusSearch(): void
  setSearchQuery(query: string): void
  searchInput(): HTMLInputElement | null
  searchAvailable(): boolean
  querySelector: '[data-dsh-enhanced-workspace="search"]'
  railButtonSelector: '[data-dsh-enhanced-workspace="search-button"]'
}
```

- 区域挂载时安装、卸载时**自动撤回**（StrictMode 重放安全；不会留下死句柄）。
- 常量：`SEARCH_GLOBAL_KEY = '__DSH_ENHANCED_WORKSPACE__'`、
  `SEARCH_INPUT_SELECTOR`、`SEARCH_RAIL_BUTTON_SELECTOR`、`SEARCH_ATTR` 等
  均在 `contract.ts` 导出，外部包同步字面量即可（跨 bundle 无共享类型）。

### dsh-hotkey action 示例（伪代码）

```js
// dsh-hotkey 侧（本仓库不改 dsh-hotkey，仅示例其 run 的写法）
const SEARCH_GLOBAL_KEY = "__DSH_ENHANCED_WORKSPACE__";
const SEARCH_INPUT = '[data-dsh-enhanced-workspace="search"]';
const SEARCH_RAIL_BUTTON = '[data-dsh-enhanced-workspace="search-button"]';

function actFocusEnhancedSearch() {
  // 1) 服务/句柄优先：window 镜像。
  const api = window[SEARCH_GLOBAL_KEY];
  if (api && typeof api.focusSearch === "function" && api.searchAvailable()) {
    api.focusSearch();          // 折叠态自动先展开，展开后落焦
    return true;
  }
  // 2) DOM 兜底：折叠态没有 input → 点 rail 搜索按钮（它跑同一手势），
  //    然后有界重试等待折叠动画结束、input 出现后聚焦。
  if (!document.querySelector(SEARCH_INPUT)) {
    const rail = document.querySelector(SEARCH_RAIL_BUTTON);
    if (rail instanceof HTMLElement) rail.click();
  }
  return waitForSearchInputAndFocus(); // 例如 100ms × 6 次的有界重试
}

function waitForSearchInputAndFocus() { /* ... */ }

// 可选：带预填查询版本
function actSearchEnhancedWorkspace(query) {
  const api = window[SEARCH_GLOBAL_KEY];
  if (api && api.searchAvailable()) { api.setSearchQuery(query); api.focusSearch(); return true; }
  if (!api && !document.querySelector(SEARCH_INPUT)) {
    document.querySelector(SEARCH_RAIL_BUTTON)?.click();
  }
  // DOM 提交：原型 value setter + input 事件（React 受控输入标准写法），
  // contract.ts 的 commitSearchQueryFromDom() 就是这段的参考实现。
  return waitForSearchInput().then((input) => {
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    return true;
  });
}

// action 表条目
{ id: "focus.workspaceSearch", def: "ctrl+shift+f", group: "core",
  zh: "聚焦工作区搜索", en: "Focus workspace search", run: actFocusEnhancedSearch }
```

## 3. DOM 兜底契约

| 元素 | 属性 | 说明 |
| --- | --- | --- |
| 宽态搜索输入框 | `data-dsh-enhanced-workspace="search"` + `aria-label={t('searchAria')}`（zh「搜索会话」/ en「Search sessions」） | `type="search"`；`aria-label` 随 locale 变，DOM 选择器用它之外的 data 属性 |
| 折叠态 rail 搜索按钮 | `data-dsh-enhanced-workspace="search-button"` + `aria-label={t('searchAria')}` | 点击 = 展开 + 落焦（与外部句柄同一手势） |

`type="search"` 不等于 `.searchInput`（CSS Modules 类名按构建哈希，**不可依赖**）。

## 4. 语义与不变量（外部可依赖）

- `focus()` / `focusSearch()`：折叠态 → 先 `expandSidebar()`，等滑入动画
  （`EXPAND_SLIDE_MS = 300ms`）后落焦；宽态 → 同样走该手势（`expandSidebar`
  对已展开是 no-op，300ms 后落焦——与 rail 按钮完全一致）。**没有**第二条
  聚焦路径，句柄与 rail 按钮不会漂移。
- `setQuery(q)`：只改 query（受控 state），聚焦与否由调用方决定；折叠态
  写入的值在展开后仍在。传 `''` 清空过滤。
- 未挂载 / 折叠：`available === false`，`input() === null`，
  `focus()` / `setQuery()` 是 **no-op**（不抛错）。
- 幂等 & 安全：句柄可跨折叠/展开持有；StrictMode 重放、区域重挂载后仍指向
  当前实例。
- 既有行为不回归：`DIRECTORY_FLOW_SLOT` 目录 flow、`searchOnExpand` 折叠手势、
  搜索过滤/空态、rail 两按钮行为均保持原样（组件 spec 覆盖）。

## 5. 验证

自动化（jsdom，`pnpm test`）：

- `tests/search-slot.spec.ts`（契约层，5 例）：key / DOM 常量字面量；用真实
  `SlotCore` 按 `index.tsx` 的写法声明两个孩子，断言 SEARCH_SLOT 可声明、其
  声明的 `inject === searchHandle`、外部插件注册进该 slot 合法；未挂载句柄
  惰性（no-op / null / `available=false`）；DOM 兜底提交路径。
- `tests/browser.client.spec.tsx` → `describe('external search trigger surface
  (slot handle + global mirror + DOM fallback)')`（组件层，6 例）：宽态句柄
  seed+focus 落到真实 input 与过滤；全局镜像与选择器常量；折叠态句柄触发
  expandSidebar + 折叠后落焦；DOM 提交 + rail 按钮展开；占用者渲染；卸载撤回
  句柄 / 镜像并变惰性。

手动（真实 DSH）：

1. `pnpm build && pnpm pack`，按仓库方式挂载进 profile，打开 web GUI。
2. DevTools Console 执行：
   - `window.__DSH_ENHANCED_WORKSPACE__.focusSearch()` → 折叠态应先展开并聚焦输入框；
   - `window.__DSH_ENHANCED_WORKSPACE__.setSearchQuery('绘画')` → 树即时过滤；
   - `document.querySelector('[data-dsh-enhanced-workspace="search"]')` → 命中输入框。
3. 折叠态执行 `focusSearch()`，观察 rail → 宽态滑入 + 落焦。
