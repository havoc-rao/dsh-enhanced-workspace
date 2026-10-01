# 未分类会话桶：默认工作区 + 新增会话 设计

> 2026-09-28。状态：已定稿（用户拍板 3 个决策，见 §7），待实现。

## 1. 目标

1. 插件树尾部的未分类会话桶（今天硬编码 `Ungrouped`）改名为本地化文案：zh
   `未分类会话`、en `Uncategorized`。
2. 未分类桶行新增「新建会话」＋ 按钮，效果 = 把会话放进 DSH 默认工作区
   （`<Documents>/deepseek-harness/default-workspace`）：首次点击即按官方
   机制自动创建（注册）该工作区，树中出现「默认工作区」行；会话带着真实
   cwd 落盘进默认目录。任务需要落盘时天然有真实工作区目录承接。
3. 顺带修复显示缺口：真实工作区行的 label 走 `workspaceDisplayTitle` 语义
   ——存储标题仍为 `default-workspace` 的工作区在插件所有展示面显示本地化
   默认名，而不是英文 `default-workspace`。

## 2. 官方机制参照（事实核查）

DSH ui-workspace 的默认 path 机制（只读参照，插件零写入）：

- 固定目录名 `DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'`，挂在
  `<Documents>/deepseek-harness/` 下；语言无关，切换语言磁盘路径与存储标题
  都不变。
- 注册表 `initializeDefault` 门槛：仅注册表空 + 无任何会话（含无 cwd 的）
  时首建；首建后幂等复用；**显式删除后永久禁用自动创建**。
- 客户端公开 API：`ctx.workspaces.initializeDefault(signal?: AbortSignal)`
  → `WorkspaceView | undefined`（`undefined` = 不符合创建条件；失败抛
  `WorkspaceCreateError`）。插件可直接调用，零新增依赖。
- 显示层：官方各展示面用 `workspaceDisplayTitle(title, localizedDefault)`
  把存储标题 `default-workspace` 渲染为本地化默认名；重命名对话框预填屏幕
  标签、确认即钉死（此后不再跟随语言）。该函数是纯 fold（一行比较），插件
  内联同款实现即可，不触发 client 纯度门禁。

补充事实：

- Host 侧没有「落盘时自动建 workspace」的拦截机制；无 workspace/cwd 的会话
  创建时 cwd 兜底为 Host `process.cwd()`。唯一"自动 create workspace"先例
  是 webhook 包在会话创建时 `ctx.workspaceRegistry.create(path)`（Host 侧）。
  因此「落盘即建」落到本设计的时机 = 点 ＋ 时按官方机制首建工作区。
- `sessions.create({ workspaceId })`（经由 `ctx.uiWorkspace.startSession`）
  产生 cwd = 工作区 path 的会话，归属该工作区——点 ＋ 后会话归入「默认
  工作区」行，不再滞留未分类桶（用户已拍板）。

## 3. 插件现状（改动点盘点）

| 现状 | 位置 |
|---|---|
| 未分类桶 label 硬编码 `UNGROUPED_LABEL = 'Ungrouped'`；locale 键 `ungrouped`（zh `未分组`）是死键 | `src/client/model.ts:1142,1554`；`src/client/locales.ts:46,157` |
| `LeafRow` 操作区（菜单＋加号）仅 `hasAccount`（真实工作区）渲染，未分类桶无 ＋ | `src/client/Browser.tsx:1977-2235`（`hasAccount` 即 `leaf.workspaceId !== undefined`） |
| 真实工作区 label = `workspace.title` 原样，无默认名本地化 | `src/client/model.ts:1381`（`buildLeaf`） |
| `initializeDefault` 返回的（新）工作区不在插件 folder tree 内 → 不可见，需 `adoptWorkspace`（幂等、置顶 root children） | `src/client/model.ts:584`（`adoptWorkspaceIn`） |
| 区域添加入口（hole / 原生 picker → create → adopt）可复用为回退 | `src/client/Browser.tsx:716-761`（`addWorkspace` / `openAddEntry`） |
| 注入面 `EnhancedWorkspaceInjected` 尚无 `initializeDefault` 动作 | `src/client/contract.ts` / `src/client/index.tsx:243-309` |

## 4. 设计

### 4.1 未分类桶更名（本地化）

- `locales.ts`：`ungrouped` 键 zh `未分类会话`、en `Uncategorized`（替换
  现有死键文案）。
- `model.ts`：`deriveFolderForest` 增加 `ungroupedLabel: string` 参数
  （纯函数保持纯），未分类叶子 label 用之；删除 `UNGROUPED_LABEL` 常量。
- `Browser.tsx`：组 `ForestView` 处传 `t('ungrouped')`。
- 所有读 `leaf.label` 的面（行渲染、搜索匹配、aria、hover）自动跟随。

### 4.2 默认工作区显示名（前置修复）

- 新增内联纯函数 `workspaceDisplayTitle(title, localizedDefault)`（复制官方
  语义：`title === 'default-workspace' ? localizedDefault : title`）。
- `ForestView` 增加 `defaultWorkspaceLabel?: string`；`buildLeaf` 的 label 走
  `workspaceDisplayTitle(workspace.title, defaultWorkspaceLabel)`。
- `Browser.tsx` 传 `t('defaultWorkspaceName')`；新 locale：zh `默认工作区`、
  en `Default workspace`。
- 覆盖面：树行 label、hover 卡片（读 leaf.label 侧）、搜索匹配、重命名
  对话框预填——与官方「自动标题显示本地化、用户钉死后原样」一致。

### 4.3 未分类桶 ＋ 新建会话

- `LeafRow`：`!hasAccount` 时操作区渲染**仅** ＋ 按钮（无菜单、无拖拽）；
  aria 复用 `newSessionAria`（`在「未分类会话」中新建会话`，无需新键）。
- 注入面：`EnhancedWorkspaceInjected` 新增
  `initializeDefault: (signal?) => Promise<WorkspaceView | undefined>`
  （`index.tsx` 绑 `ctx.workspaces.initializeDefault`）。
- `RowCallbacks` 新增 `onStartSessionInDefault`，Browser 实现：

  ```
  startSessionInDefault():
    1. busy 防重（本地 state）
    2. initializeDefault(signal)
       - 返回 workspace →
         actions.adoptWorkspace(ws.workspaceId)   // 幂等，置顶
         actions.setGroupExpanded(ws.workspaceId, true)  // 行加号同款：先展开
         startSession(ws.workspaceId)             // Host 建会话，cwd = 默认目录
       - 返回 undefined（默认被删过 / 注册表非空且从未建默认）→
         openAddEntry()                           // hole / 原生 picker → create → adopt
       - reject（Documents 解析失败、目录被同名文件占位）→
         console.warn + 轻提示（复用现有 toast 通道或静默，实现时定）
  ```

- 会话落点：归入「默认工作区」行（用户已拍板）；未分类桶只保留真正的游离
  会话。

### 4.4 边界与一致性

- 不重复推导默认目录路径、不碰 Host 注册表——只消费 `initializeDefault`
  返回值（符合 AGENTS.md「只用 DSH 现成公开 API」）。
- 回退不调用无参 `startSession()`（官方语义 = 清空选择、不建会话，对用户是
  死按钮）。
- Cmd/Ctrl+N 快捷键链不动（已有自己的 fallback）。
- 目录被同名文件占位等冲突 → official 机制下 `initializeDefault` 失败 →
  回退 picker，与官方「启动目录冲突 → 通知 + folder picker 恢复」同构。

## 5. 测试

- model 单测：`workspaceDisplayTitle` 内联实现；`ungroupedLabel` 注入（含
  搜索/过滤路径）；`adoptWorkspaceIn` 幂等；默认 label 注入后 `buildLeaf`
  行为。
- 组件 spec：未分类桶行 ＋ 渲染（aria、无菜单）；点击主路径（stub
  `initializeDefault` → 断言 adopt + 展开 + `startSession`）；回退路径
  （stub 返回 undefined → 断言打开添加入口）。
- `pnpm typecheck && pnpm test && pnpm build`（生产，防 DEV 泄漏）+ 挂载冒烟。

## 6. 不做的事

- 不加宿主半新 RPC（"留在桶里 + cwd 指向默认目录"的变体被用户否决：链路
  长，且"落盘时自动建 workspace"没有宿主钩子可挂）。
- 不拦截/监测任务落盘行为。
- 不改官方源码、不复制 host 侧路径推导。

## 7. 用户拍板的决策

1. 会话落点：归入「默认工作区」行（主设计，非"留在桶里"变体）。
2. 回退行为：`initializeDefault` 返回 undefined 时打开目录选择器/hole。
3. en 文案：`Uncategorized`。