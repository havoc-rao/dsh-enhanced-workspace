# 加强版工作区（dsh-enhanced-workspace）— 开发状态跟踪

> 本文件是开发进度的唯一权威记录（每轮工作开始先读这里，结束更新这里）。
> 设计与需求定稿见 `docs/plan/2026-09-04-plugin-mode-design.md`。
> （原 Host 方案文档 `enhanced-workspace-plan.md` 已废弃删除，设计文档 §1 保留
> 其转向背景一句话。）

## 大目标

以**独立插件**（不修改 DSH 本体）替换内置 `WorkspaceBrowser`：遮蔽
`sidebar.workspaces`（priority -1），提供 ① 目录树（嵌套 ≤6 层、删除提升、
同级重名、拖拽、深度/环守卫）② 最近使用模块（仅保留最近 **5** 个 dir，
行 = 工作区行形态可展开会话列表但不显示计数、底部 border 分隔，时间戳
**只在发送新 query 时更新**，展开状态与树行**互不联动**）③ 持久化（插件
store 信封经宿主半 `/enhanced-workspace` RPC 通道落盘
`~/.dsh/storages/dsh-enhanced-workspace.json`，localStorage 仅作同源兜底；
另含 Host 平铺顺序最小移动集 reconcile）。仓库形态与门禁参照 DSH-better-sidebar（双通道 client bundle、
purity gate、挂载冒烟、jsdom 组件 spec）。

## 当前进度（2026-09-04）

### 已完成（里程碑摘要）

- **P1 脚手架 + 接入**：双通道 bundle（`lib/client.js` + `client-registry.js`）、
  slots 遮蔽注册（priority -1，自持 store/inject/locale/registrant）、
  发布清单市场合规（三字段无 cordis、无生命周期脚本）、挂载手测通过
  （`dsh plugin add link:…` → bundle 协调 + `--dump-config` 可见 insert 行）。
- **P2 数据面**：`model.ts` 纯函数全集（树 CRUD/守卫/提升、`treeOrder` /
  `orderDeltas` reconcile、森林/flat/最近派生、`retainLiveKeys` 清账、
  `restoredState` / `isPersistedViewState` 信封恢复、`relativeTime` 后台记录）；
  动作全部走 model 校验；`tests/harness/runtime-client.ts` 桥接真实 store
  引擎。
- **P2.5 持久化（宿主落盘）**：发现桌面端 webserver 每次启动端口随机
  （`port: 0`），Chromium 按 origin（含端口）分桶 localStorage —— 旧
  persist 方案重启即丢树（leveldb 佐证：55281/59136/59216 三个 origin 各
  一份数据）。改为宿主半 `src/host/storage.ts` 严格校验（双向账目、深度
  ≤6、环守卫、1 MiB 上限）+ 原子写（tmp+rename）入 `<dsh-home>/storages/`，
  `/enhanced-workspace` 通道（loopback 权威）两端共享字面量
  （`src/shared/persistence.ts`）防漂移；浏览器挂载时一次性 restore
  （仅当树仍为初始态，且以 restore 时刻为准——会话已建目录则跳过），
  300ms 防抖写回；localStorage 降级为兜底。
- **P3 交互面**：
  - 区头（视图切换/添加/搜索）+ 目录/工作区行菜单 + 对话框（新建/重命名/
    删除提升/移动到…）；
  - 最近使用需求定稿：上限 5、工作区行形态（可展开/行菜单/新建会话）、
    时间戳仅新 query 更新（`observeSessionActivity` 观测 `updatedAt` 推进，
    点击/打开不再 touch）、UI 不展示计数与相对时间、独立展开键
    `recent:<id>`（前缀键随工作区清账）；
  - 会话排序策略：`orderBy` updated（活动倒序，默认）/ manual（账号顺序）；
  - 拖拽状态机（`drag.ts` 纯函数 + HTML5 DnD 接线：目录行 = 移入末尾、
    行间 = 锚点插入、自拖 noop、环/深度守卫非致命）；
  - 圆角同步：行的 current-session wash 与拖拽指示器（dropBefore/After/On）
    统一读取行级 `--dsw-row-radius`（全树统一 8px，folder 行同步为
    workspace·session 常规 hover 的圆角），任何状态不改变行的 fillet
    （Browser.module.css）；
  - 状态复刻（内置 parity）：会话行 `StateDot`（running 像素追逐 loading
    动画 / pending warning / completed done / 空闲与 blank 无点）、dir 级
    loading 同步（`containsCurrent` 的目录/工作区/最近行图标点亮业务蓝，
    无论展开与否——会话被收起时 father dir 链逐层保留标记）。
  - **当前会话高光修复**：`dirActive` 去掉 `expanded` 门——工作区/目录行
    只要含当前会话即带 wash + 点亮图标，收起整条链时标记逐层不熄灭
    （`dirActive` 单参；组件 spec 补「收起链逐层标记」用例）。
  - **Hover 卡片（内置 ui-workspace 复刻）**：复用 `HoverCard` 原语（右侧
    定位/驻留延迟/复制反馈，平台模块表内，purity gate 放行）。工作区行卡片
    = 标题 + 完整路径 + 绝对创建时间 + 点击卡片复制路径（复制标签走字典）；
    会话行卡片 = 标题 + 相对时间 + 实时状态行（pending 明细/子代理计数/
    running/completed/idle）+ 文件域（输入源/输出源，列表 `name | path`
    与目录树双模切换、「其余 {n} 个文件」展开、文件行点击标记观察）。
    纯派生 `recentFileList` / `recentFileTree` 从内置 tree.ts 移植入
    model.ts（8 例单测）；内容组件入 `src/client/HoverCards.tsx`；
    行菜单打开时 disabled 抑制卡片（内置 parity）。组件 spec 4 例 +
    e2e hover 断言（顺手修了 e2e：新版首启欢迎是 Modal mask，老
    onboardingOverlay 选择器已删不掉）。已知差异（README Known
    Limitations 已记）：卡片宽度用原语默认 244px（内置会话卡片 300px 依赖
    ui-primitives 0.1.2 未发布的 `width` prop）；无 host-description 注入，
    路径不做 `~` 缩写。
- **P4 收尾**：组件 spec（jsdom + 真实 store 引擎 + fixture 快照）、
  `scripts/e2e-mount.sh` + `playwright.config.ts` + `tests/e2e/mount.e2e.ts`
  （scratch DSH_HOME + 官方 CLI 挂载 + 无头渲染断言，需本机 `dsh` +
  chromium）、`.agents/notes/enhanced-workspace.md`、README/设计文档同步。
- **交互补充：Cmd/Ctrl+N 新建会话快捷键**：与工作区行内 + 按钮同效——
  命中键（meta/ctrl + N、无修饰键、非自动重复）时，取当前会话所在工作区
  （无则最近工作区，再无可回退内置 New Session 视图），展开该会话组并
  `startSession(workspaceId)`。监听器挂浏览器根组件（`window` keydown，
  ref 持最新闭包、mount 一次注册/卸载清理）；作用域即浏览器区挂载期
  （侧边栏收成 rail 时由 shell 的 rail 新建按钮兜底）。组件 spec 1 例
  覆盖：命中三态目标（当前会话工作区 → 最近工作区 → 无参），噪声键
  （裸 n / Cmd+Shift+N / Cmd+Alt+N / Cmd+J / repeat）不触发。
- **交互补充：浏览器区头「收起全部」**：区头右侧动作组新增 chevron-up
  收起按钮（`collapseEverything` 动作 = `collapseAll` 与 `collapseRecents`
  的并集）——一键折叠下方**两个模块**的全部展开行（最近使用行 + 目录树/
  未分组会话组），两组「显示其余 n 个」溢出随之一并复位；分节各自的收起
  按钮保持原语义。store 单测 1 例 + 组件 spec 1 例。
- **质量门**：`pnpm typecheck` 全绿；`pnpm test` 152/152（model 68 + drag 10 +
  store 10 + browser 38 + host-storage 19 + persistence 7）；`pnpm build`
  双通道通过（purity gate）；`pnpm test:mount` 实测通过（scratch DSH_HOME +
  官方 CLI 挂载 + 无头渲染，含 hover 卡片断言）。

### Git Worktree 模式（M1–M2 已完成，2026-09-10）

设计与交互定稿见 `docs/plan/2026-09-10-git-worktree-mode-design.md`（v3：
**树归属 = 会话级**）+ 交互概念稿 `docs/git-worktree-ui-concept.html`。

- **M1 检测面**（`9fa3efd`）：`src/host/git.ts`（`.git` 上行 walk：
  main 目录 / `gitdir:` 文件 → linked / `modules/` → submodule；commondir、
  HEAD（分支/`@短sha` detached）、worktrees 枚举；mtime 签名 + 5s TTL 缓存；
  `parseWorktreePorcelain` exec 兜底）、`src/shared/git.ts`（wire 形状 +
  严格校验）、宿主 `git/probe` RPC（loopback，失败软降级）、
  `src/client/git-model.ts`（会话 cwd → 树绑定、聚合 pill 规则、subworkspace
  分组、未注册树集合、repo 分组派生）。
- **M2 视图层**（`033c42a` / `0531b98` / `2c71f49`）：`groupBy` 扩
  `'workspace' | 'repo' | 'flat'`（双端信封校验同步）；注入面 `probeGit`
  （通道调用）+ `continueInWorkspace`（= `ctx.workspaces.startSession`）；
  Browser 的 gitProbe 派生缓存（挂载 + focus 防抖刷新）；行内聚合 pill
  （单树分支 / 跨树「n 棵」/ 无 git 无 pill）；subworkspace 分组
  （按会话 cwd 树分组，单组自动平铺，`tw:` 键空间）；「按仓库分组」视图
  （repo 组行 + 无 git 工作区平铺 + 未注册工作树组一键注册）；
  工作区 hover 卡片 git 区（分支/角色/同仓库树）；行菜单「在目标树继续…」。
- **验证**：`pnpm typecheck` 0 错误；`pnpm test` **195/195**（新增
  host-git 12 + git-model 9 + git-browser 6）；`pnpm build:dev` 双通道 +
  纯度门通过。
- **M3 剩余 → 远程镜像 git 标记已实装**（2026-09-10，本任务）：镜像工作区
  （`~/.dsh/remote-workspaces/…`，本地无 `.git`）的行 pill / hover 卡片改为
  联动 dsh-remote 同源端点 `GET /dsh-remote/git-workspace?local=<path>`
  —— 浏览器侧 `createRemoteGitSource`（按路径 memo + 5s TTL +
  `?refresh=1` 硬刷新，500/501 无凭据离线 / marker:null 非镜像 /
  isRepo:false / 畸形体 / 网络错全部静默无标记）；纯函数
  `overlayRemoteMarkers` 把 marker 合成本地 probe 之上的**虚拟 remote 树**
  （`role:'remote'`、root 按属主机器命名空间隔离），镜像根与镜内会话 cwd
  绑定之——行聚合 / subworkspace 分组 / 按仓库分组 / 未注册树 / 搜索全部
  零改动复用；行 pill `⎇ branch ·N`（蓝色 accent，悬停标题含 staged 与
  ↑↓ 同步）、hover 卡片远端 git 段（分支 / 暂存 / 同步 / 远端机器 / 远端
  路径）。与 dsh-remote 契约逐字段对齐（核实 lib/index.js 路由 + git-parse.js
  buildWorkspaceMarker）。本地非镜像工作区行为不变。改动：shared/git.ts、
  client/remote-git.ts（新）、contract/index、Browser/HoverCards/locales/CSS、
  tests remote-git 16 + remote-git-source 10 + git-browser 组件 4 例。
  验证：`pnpm typecheck` 0 错误、`pnpm test` **225/225**、`pnpm build`
  双通道 + 纯度门通过。
- **M3 剩余**：`pnpm test:mount` 挂载冒烟复核（git 层）；README 已补 git 双
  条目（工作树层 + 远程镜像标记），en 版双语补全仍挂起；「整理到文件夹…」
  占位实装（M4 采纳动作）。

### 后续任务目标

- **P3 剩余**：会话拖拽（手动顺序编辑入口，`setSessionOrder` /
  `insertSessionBefore` 已就绪未接线）；rail 模式（窄宽度）两图标 +
  expandSidebar 请求。
- **P4 剩余**：逐文件覆盖率门；README 双语补全（en 版目前缺 Hover 卡片条目）。
- **发布准备**：`pnpm pack` + 挂载到现有 profile 手测（遮蔽生效、最近模块
  与目录树交互、拖拽、状态点、Host 顺序 reconcile、搜索/添加流程）。

## 关键约束备忘

- 不修改 DSH 本体（fork 零写入）；client bundle 不 value-import
  平台表之外的 @deepseek-ai 包（purity gate 硬挡）。
- 遮蔽形态限制（设计文档 §7）：logo 三槽位与 directory-flow 子槽位不可
  渲染（子槽位声明冲突）；目录树跨标签页 last-writer-wins（宿主文件
  同为 last-writer-wins）。
- 每次目录/视图变更后跑 Host 顺序 reconcile（失败仅 console.warn，
  插件树仍是显示权威）。
- 测试姿势：纯函数 node 直接断言；组件 spec 用 jsdom + 真实 store 引擎 +
  fixture 快照 + `[class*="…"]` 选择器（CSS module 哈希类名）；e2e 只经
  `pnpm test:mount` 跑（vitest 不收 `tests/e2e/**`）。