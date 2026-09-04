# 加强版工作区（Plugin Mode）需求与设计方案

> 需求方 2026-09-04 明确转向：**不在 DSH 本体（deepseek-harness）改任何代码，
> 以独立插件替换**。早前的 Host 方案（依赖 DSH 本体的域 v3 / 新 RPC / 新帧）
> 已整体废弃，由「客户端权威目录树 + 既有 Host API 对齐」替代；UI 目标
> （最近使用模块、多层目录树、删除提升、深度上限、拖拽、清账）与交互语义
> 原样保留。仓库形态参照 `DSH-better-sidebar`（dsh.plugin.json +
> cordis.patch.yml + client 双通道 bundle + docs/plans + 挂载冒烟）。

---

## 1. 背景与转向

### 1.1 原方案（已废弃的 Host 路径）

早前设计走 Host 路径：workspace 域升 v3（SQLite `folders` 表）、apiproxy
新增 `workspace.folder.*` RPC 与 `host/workspace-folders-changed` 帧、
`workspace.insertBefore` 增 `folderId`、runtime 投影 folders —— 全部是对
DSH 本体包的修改。插件仓库约束（AGENTS.md §0 与外部插件惯例）明确**禁止
修改 DSH 源码**，需求方确认按此执行，整条路径废弃（原方案文档已删除）。

### 1.2 插件模式的替代设计

| 原能力 | Host 方案 | 插件方案 |
| --- | --- | --- |
| 目录树持久化 | Host SQLite 域 v3 | 插件 store（localStorage，`persist: 'dsh.enhanced-workspace.v1'`） |
| 目录/顺序权威 | Host（多标签一致） | 插件（单标签权威；跨标签 best-effort，见 §7.2） |
| 目录 CRUD 校验 | Host 写链（环/深度/重名/root） | 插件纯函数校验（语义不变：深度 6、删除提升、同级重名、root 保护） |
| 工作区归属/顺序对齐 | Host order = 树 | 插件树为显示权威，Host 平铺顺序经 `workspace.insertBefore` **reconcile**（最小移动集） |
| 最近使用 | 派生 + 客户端触摸（store v6） | 插件 store 触摸点 + 派生合并（语义同 F2.2） |
| 拖拽 | 新 wire 参数 | 纯客户端：`ctx.workspaces.insertBefore`（同目录内）+ 树数据移动（跨目录） |
| 添加工作区 | directory-flow 子槽位 | 插件自持：`ctx.workspaces.pickDirectory()` + `create()`（无子槽位依赖） |
| 错误码 | 新 wire 错误码 | 客户端回显（`console.warn` + 行上非致命提示，同 NFR-5） |

### 1.3 保留的目标（对照原 FR）

- **FR-1 多层目录树**：嵌套（含根）≥6 层、缩进 + 引导线、新建子目录/
  重命名/删除（提升：子目录在前、工作区在后，插被删目录原槽位）/移动、
  同级目录重名校验、拖拽（拖到目录行 = 移入末尾；拖到行间 = 插入锚点前）。
- **FR-2 最近使用模块**：分组模式、无搜索词时顶部展示，上限 **5**；行 =
  工作区行形态（**可展开会话列表**、行菜单、新建会话，`containsCurrent`
  生效），**展开/收起与下方完整工作区列表互不联动**（独立前缀组键
  `recent:<workspaceId>`，各自记忆），**UI 不展示会话计数与相对时间**
  （后台记录已足够，仅用于排序/折叠）；区块**底部 border** 与下方工作区
  列表分隔；排序 = `max(触摸时间, 派生活动时间)` 倒序（派生 = 会话最大
  updatedAt，无会话回退 createdAt）。**触摸点只有「发送新的 query」**：
  观察会话快照中 `updatedAt` 推进（读面无独立 query 事件，此为近似，见下），
  打开会话 / 点击行 / 新建会话 / add 流程**均不 touch**；重启仍在；基线
  清账剔除死 id（前缀键随工作区生死）。注：会话 `updatedAt` 在每次持久化
  变更时推进（以新 query 为主），完成态翻转等次要变更可能同批刷新，属于
  可接受近似。
- **FR-3 持久化（插件形态）**：目录树 + 展开状态 + 触摸点 + 视图字段全部在
  插件 store；基线（`ctx.workspaces.list`）就绪后按存活 id 清账。
- **FR-4 现状兼容**：flat 列表、未分组桶、内容搜索、会话 5 条折叠、
  工作区重命名/删除/归档会话、rail 模式、WorkspacePicker — 不改变。
  `WorkspaceBrowser` 的区头（标题/视图选项/添加/搜索）与对话框由插件复刻。
  UI 精简：目录/工作区行不展示会话计数徽标，会话行不展示相对时间
  （计数与时间戳仍在后台记录，用于排序 / 折叠 / 溢出提示）。
- **状态复刻（内置 parity）**：会话行状态点 = ui-primitives `StateDot`
  （pending 交互 warning / 本会话或子代理 running = ongoing 像素追逐
  loading 动画 / completed = done；空闲与 blank 无点）；**dir 级 loading
  同步** = `expanded && containsCurrent` 的目录 / 工作区行（含最近行，
  各自展开键独立）图标点亮业务蓝 `folderActive`。优先级与判定纯函数在
  `sessionStatusDot` / `dirActive`（model）。

---

## 2. 插件接入面（已验证的机制）

- **遮蔽**：`ctx.slots.register({ name: 'sidebar.workspaces', priority: -1,
  store, inject, locale, registrant }, Component)` — ui-slots 规则「single 槽位
  最低 priority 渲染」，内置浏览器注册在默认 0，插件 -1 顶掉它。同一 cell 同
  priority 重复注册抛错（不同 priority 共存合法）。
- **props**：组件获得 `{ useStore, actions }`（来自**插件自己**声明的 store）、
  `t`（插件自己的 locale ns）、owner share（sidebar shell 的 wide 等）、
  inject 工厂产物（插件自己的 actions + hooks）。
- **子槽位冲突**：`children` 声明与已声明 key 冲突会抛错；内置浏览器条目常驻
  ledger（遮蔽 ≠ 卸载），其 4 个子槽位（directoryFlow / workspaceIcon /
  workspaceMenu / workspaceHoverIcon）**已被其声明** —— 插件不能再声明。
  后果：logo 三槽位与 directory-flow 组合包在遮蔽形态下不可由插件渲染
  （Known Limitation，见 §7.1）。添加流程改由插件自持（`pickDirectory`）。
- **数据与动作**：`ctx.workspaces`（IWorkspaces：list / startSession / create /
  pickDirectory / listDirectory / createDirectory / openPath / rename / setLogo /
  delete / insertBefore / insertSessionBefore / archiveSession）、
  `ctx.sessions`（search / open / fork / binding…）均可由插件直接注入
  （`inject: ['slots', 'sessions', 'workspaces', 'locale', 'connection', 'modules']`）。
- **客户端 bundle**：tsdown 双通道（官方 profile 通道 `client.js` 以包名注册、
  插件注册表通道 `client-registry.js` 以 manifest id 注册），
  `window.__ModuleLoader__.load({ id, factory })` CJS 闭包；externals =
  PLATFORM_MODULES 表（react / ui-slots / ui-primitives / runtime/client …）；
  其他 @deepseek-ai 值导入被 purity gate 拒绝（跨插件协作走 cordis 服务，
  类型导入擦除后不触发）。

---

## 3. 数据模型（插件 store）

```
dsh.enhanced-workspace.v1  (defineStore + persist, localStorage)
{
  folders: {
    root: { folderId: 'root', name: 'Root', parentFolderId: null,
            workspaceIds: [], folderIds: [], createdAt, updatedAt }
    <uuid>: { folderId, name, parentFolderId, workspaceIds, folderIds,
              createdAt, updatedAt }
  },                       // 目录树完整状态（含顺序）；'root' 常量保留
  folderExpansion: Record<FolderId, boolean>,
  recentTouchById: Record<WorkspaceId, number>,   // 新 query 发送时间戳
  groupBy: 'workspace' | 'flat',
  orderBy: 'manual' | 'updated',
  groupExpansion: Record<string, boolean>,        // 会话 5 条折叠（同内置语义）
  sessionOrderByAccount: Record<string, string[]>,
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>,
}
```

- `FolderId` 为字符串品牌（`'root'` 保留）；工作区引用一律用 Host 的
  `workspaceId`（清账以 `ctx.workspaces.list` 基线为准）。
- 根目录记录与内置语义一致：`parentFolderId: null`、不可重命名/删除；
  其子项即顶层；显示顺序 = `folderIds` 依次后跟 `workspaceIds`。
- 深度常量 `MAX_FOLDER_DEPTH = 6`（含根；插入时父深度 ≥6 拒绝）。
- 迁移：v1 无历史数据，无需迁移；`persist` 键版本化（v1...）。

## 4. 纯函数数据面（src/client/model.ts，全部可单测）

- `deriveFolderForest(folders, expansions, workspaces, sessions, archived,
  view)` → 根子项 `(FolderNode | GroupNode)[]`；`FolderNode{folderId, name,
  depth, expanded, children, workspaceGroups, sessionCount, containsCurrent,
  ancestorPath}`；工作区叶子复用内置 `GroupNode` 语义（5 条折叠、会话顺序账号）；
  未分组桶仍然最后；不可达目录（孤儿）不渲染。
- `deriveRecentWorkspaces(workspaces, sessions, touches, view, limit=5)` →
  最近行 = 完整 `WorkspaceLeaf`（可展开会话列表/顺序/`containsCurrent`）+
  `updatedAt`（`max(touchAt, derivedAt)` 倒序，稳定 tie-break 用 key）；
  `observeSessionActivity(seen, byId)` → 会话快照 diff（`updatedAt` 推进 =
  新 query），浏览器据此 touch 所属工作区（一个工作区一次）。
- 组内会话排序按视图 `orderBy`：`'updated'`（默认）= 活动倒序；
  `'manual'` = 存储账号顺序（新会话按账号序尾随）。
- 拖拽数据面（`src/client/drag.ts` 纯函数）：`rowDropZone` / `folderDropZone`
  （指针 → before/on/after）、`resolveWorkspaceDrop`（目录行 = 移入末尾，
  工作区行 = 锚点插入；自身 = noop）、`resolveFolderDrop`（on = 移入，
  before/after = 父级内重排）；守卫由 store 动作执行，失败 warn 非致命。
- 目录操作（校验 + 结果计算，写回 store 一个动作）：
  `createFolder(parentId, name)`（深度/同级重名）、`renameFolder(id, name)`
  （同级重名/root）、`deleteFolder(id)`（提升：`folderIds` 与 `workspaceIds`
  各自在 `at` 槽插入被删目录的子项，子目录在前工作区在后）、
  `moveFolder(id, beforeId?, parentId?)`（环 = 目标是自身或后代；超深拒绝；
  换父 + 同级定位）、`moveWorkspace(id, beforeId?, targetFolderId?)`。
- `orderDeltas(currentHostOrder, desiredOrder)` → 最小 `insertBefore` 移动集
  （Host 平铺顺序 reconcile；每次树变更后跑，失败 console.warn 非致命）。
- `retainLiveKeys(state, liveWorkspaceIds, liveFolderIds)`：修剪目录树中死
  工作区 id、展开/触摸中死 id；目录本身不因空而删（用户删除才是删除）。

## 5. 组件与文件规划

```
src/client/
  index.tsx        // inject 声明 + apply：locale 注册 + slots.register 遮蔽
  store.ts         // defineStore('dsh.enhanced-workspace.v1') + 全部 actions
  model.ts         // 树/最近/目录操作/顺序 reconcile 纯函数
  Browser.tsx      // 区头（标题/视图/添加/搜索）+ 最近模块 + 递归树/flat + 对话框
  RecentRow.tsx / FolderRow.tsx / WorkspaceRow.tsx
  Dialogs.tsx      // 新建子目录 / 重命名 / 删除（提升文案）/ 添加（pickDirectory）
  drag.ts          // 拖拽状态机（拖到目录行 / 行间锚点 / 跨目录）
  locales.ts       // zh/en（NS: 'enhancedWorkspace'）
  browser.module.css
tests/
  model.spec.ts        // 纯函数全量（树/最近/CRUD 语义/深度/环/reconcile/清账）
  store.spec.ts        // 持久化动作、清账、触摸去重
  browser.client.spec.tsx  // 组件（真实 props + fixture 运行时驱动）
```

- flat 模式与搜索：复刻内置行为（`sanitizeSearchQuery`、防抖、结果行），
  搜索走 `ctx.sessions.search`。
- 会话行/未分组桶/折叠：复用内置行交互语义（文件内重实现，样式独立）。

## 6. 里程碑

- **P1 脚手架 + 接入**：仓库骨架、双通道 build、slots 遮蔽注册、空浏览器
  壳（区头 + 平铺列表等值替换，验证遮蔽生效）；挂载冒烟先行打通。
- **P2 数据面**：store + model 纯函数 + 全量单测（含 reconcile/清账）。
- **P3 交互面**：最近模块、目录树渲染与行、对话框、添加流程、搜索/flat、
  拖拽（先「拖到目录头 = 移入」，再行间跨目录）、触摸上报。
- **P4 收尾**：locales 双语、CSS、组件 spec、README/AGENTS.md/Agent Note、
  挂载冒烟（真实 DSH profile）+ 覆盖率门（逐文件 100%）。

## 7. 已知限制与开放问题

- **logo 子槽位在遮蔽下不可用**：`sidebar.workspaces.workspaceIcon/Menu/
  HoverIcon` 由内置浏览器条目声明，插件再声明即冲突（ui-slots 单声明者）。
  遮蔽形态下 workspace-logo 插件的行内 logo 不渲染（目录图标回退不变）。
  若后续需要，可行路径：Host 侧支持「条目可接管已声明子槽位」后再说。
- **跨标签页一致性 best-effort**：目录树是插件本地权威；两标签页并发改树
  为 last-writer-wins，不做冲突合并（Host 顺序 reconcile 双向可能打架，
  失败仅 console.warn）。文档化：同 profile 建议单标签页整理目录。
- **Host 顺序的语义**：其他表面（picker/rail/flat 主列表）读 Host 顺序；
  插件每次树变更后 reconcile 会让它们跟随树的 DFS 顺序 —— 这是特性
  （一致性），不是回归；reconcile 失败时插件树仍是显示权威。
- **删除目录的持久化窗口**：树变更 + Host reconcile 非原子；主流程
  （先树后 Host，失败 warn）已够用，不做 pending 恢复（客户端无跨刷新
  事务承诺）。