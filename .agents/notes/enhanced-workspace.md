# dsh-enhanced-workspace —— 仓库 Agent Note

> 给后续开发轮的速查。唯一权威进度记录是 `docs/plan/status.md`（每轮开始先读、
> 结束更新）；设计总述见 `docs/plan/2026-09-04-plugin-mode-design.md`。

## 硬约束（AGENTS.md §0 摘要）

- **零写入 DSH 源码**（`~/.dsh/source/current`、本地 fork 都不碰）；缺能力用
  只读/公开 API（`ctx.workspaces` / `ctx.sessions` / slots 注入）或插件自有
  实现。
- 挂载仅走 `cordis.patch.yml` + profile（`dsh plugin --profile <name> add
  link:…` 或 `file:<tarball>`）；插件是独立包，永不反向侵入 DSH。
- 市场发布门：`dependencies` / `peerDependencies` / `optionalDependencies`
  三字段无 `cordis`；scripts 无 preinstall/install/postinstall/prepare。
- client bundle purity gate：仅平台模块表（react / ui-slots / ui-primitives /
  runtime/client）可 value-import；跨插件协作走 cordis 服务，类型可自由共享。

## 常用命令

```sh
pnpm test          # vitest：纯函数 + jsdom 组件 spec（tests/*.spec.*）
pnpm typecheck     # tsc --noEmit
pnpm build         # tsc 声明 + tsdown 双通道（lib/client.js + client-registry.js）
pnpm pack          # 发布产物（挂载冒烟用 tgz）
pnpm test:mount    # scripts/e2e-mount.sh：真实 DSH 挂载冒烟（需 PATH 有 dsh + Playwright chromium）
```

## 架构备忘

- 遮蔽：`ctx.slots.register('sidebar.workspaces', priority: -1)` 顶掉内置
  浏览器；子槽位（logo 三穴、directory-flow）不可再声明（单声明者冲突）。
- 数据面全在 `src/client/model.ts` 纯函数：目录树 CRUD/守卫、`treeOrder` /
  `orderDeltas`（Host 顺序最小移动集 reconcile）、`deriveRecentWorkspaces`
  （最近 5 个 dir，行 = 完整 WorkspaceLeaf）、`observeSessionActivity`
  （会话 `updatedAt` 推进 diff = "发送新 query" 的近似观测，首见播种）、
  `deriveFolderForest` / `deriveFlat`、`relativeTime`（后台记录用，UI 不再展示）。
- 排序策略：`ForestView.orderBy` —— `'updated'`（默认）组内会话按活动倒序；
  `'manual'` 尊重存储账号顺序（Host sessionIds 即手动顺序）。
- 拖拽：`src/client/drag.ts` 纯函数（rowDropZone/folderDropZone/
  resolveWorkspaceDrop/resolveFolderDrop）；行事件在 FolderRow/LeafRow，
  落点经 store 动作（环/深度/root 守卫抛错 → console.warn 非致命）。
- 状态复刻：会话行 `StateDot`（ongoing = 像素追逐 loading 动画）由
  `sessionStatusDot` 判定（pending→warning / running|子代理→ongoing /
  completed→done / 空闲与 blank 无点）；dir 级同步 = `dirActive`
  （expanded && containsCurrent → 图标 `folderActive` 业务蓝）；最近行
  展开键独立（`recent:<id>`），状态判定按 workspaceId 不受影响。
- store：`dsh.enhanced-workspace.v1`；`recentTouchById` 只由 query 观测写；
  展开键：树行用 workspaceId，最近行用 `recent:<id>` 前缀键（
  `recentGroupKey`）——两区各自记忆展开状态，**互不联动**；前缀键随工作区
  生死清账（`retainLiveKeys` 的 `isLiveKey`）。
- Hover 卡片（内置 ui-workspace 复刻）：`HoverCard` 原语（平台模块表内）
  包 LeafRow/SessionRow 的行；内容组件在 `src/client/HoverCards.tsx`
  （工作区卡 = 标题+路径+创建时间+点击复制；会话卡 = 标题+相对时间+状态行+
  文件域列表/树双模+文件行标记）。纯派生 `recentFileList`/`recentFileTree`
  在 model.ts（卡片文件树的 12px 缩进指南是 `hoverIndentGuides`，与树行的
  8px `guideBackground` 无关）。`now` 由 GroupedView/FlatList 每轮渲染计算
  下传（一行一戳）；打开的行菜单（disabled）抑制卡片；卡片复制测试要 stub
  `navigator.clipboard`，打开卡片用 `pointerover`/`pointerout` 事件
  （React 从它们合成 pointerenter/leave）。

## 测试姿势

- 纯函数在 node 环境直接断言；组件 spec 用 jsdom + 真实 store 引擎实例 +
  fixture 快照（`tests/harness/runtime-client.ts` 桥接真 bundle）。
- 拖拽 spec：原生 Event 模拟 DragEvent（jsdom 无 DataTransfer），
  `stubRect` 控制 drop zone；CSS module 类名是哈希，断言用 `[class*="…"]`
  属性选择器，不要 `classList.contains` 精确匹配。
- e2e（tests/e2e/*.e2e.ts）只经 `pnpm test:mount` 跑，vitest 不收。

## 已知限制

- 遮蔽形态：logo 子槽位、directory-flow 组合包不可渲染。
- 目录树插件本地权威：跨标签页 last-writer-wins；Host reconcile 失败仅 warn。
- 最近使用时间戳是 `updatedAt` 推进近似（读面无独立 query 事件）；
  完成态等次要变更可能同批刷新，属可接受近似。