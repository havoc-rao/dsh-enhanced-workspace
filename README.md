# dsh-enhanced-workspace

加强版工作区（Workspace Browser v2）—— DSH 的外部插件，**不修改 DeepSeek
Harness 本体**：以 `priority: -1` 遮蔽 `sidebar.workspaces` 槽位，替换内置
`WorkspaceBrowser`，提供：

- **最近使用工作区模块**（浏览区顶部，仅保留最近 **5** 个 dir：工作区行形态
  —— 可展开会话列表 / 行菜单 / 新建会话；UI 不展示会话计数与相对时间，时间戳
  **只在发送新的 query 时更新**，打开/点击不刷新；区块底部 border 分隔）
- **保持内置工作区行为**：工作区行「收揽会话」（点击展开/收起其下的会话列表、
  行内按钮新建会话、行菜单重命名 / 删除 / 归档会话、每工作区 5 条折叠 + 显示更多）
- **多层目录树**（嵌套 ≤6 层含根；新建目录 / 新建子目录 / 重命名 /
  删除提升子项到父级 / 移动到…（目录或工作区均可移动，含跨目录）；同级目录
  重名校验；行菜单操作 + 「移动到…」目录选择器）。每层是**一个统一的子条目
  账户**（`children`）——目录与工作区同层自由穿插排列（目录在前不再被固定）；
  旧版双账户信封自动迁移，迁移后顺序不变
- **拖拽**：工作区拖到目录行正中 = 移入该目录末尾，拖到目录行上/下边 =
  在**该目录行自己的位置**插入（子目录与工作区互为锚点，同层可穿插）；
  拖到工作区行间 = 锚点插入（含跨目录）；目录同样可以拖到工作区行前/后进行
  同层重排；目录拖到目录行 = 移入 / 行间重排（环 / 深度守卫，失败非致命）；
  会话组内排序策略：按活动（默认）或手动顺序
- **多选 + 共同拖拽（⌘/Ctrl+点击）**：⌘（macOS）/ Ctrl（Windows/Linux）
  点击任意工作区行或目录行即可切换选中（行列蓝色调选中态 + aria-selected；该
  手势**不会**触发展开/收起），可跨目录、跨最近使用区块多选；**拖任一所选行**
  = 整组共同拖动，松手后按屏幕显示顺序整体落位——拖到目录行正中 = 整组移入
  该目录（按显示序追加），拖到行间 = 整组锚点插入（行前/行后，组内相对顺序
  不变）；组内逐项解析，目录拖进自身/后代或超深目录等违规项（环 / 深度/
  根守卫）**单独跳过**，其余成员照常移动，不会整组作废；拖未选中的行 =
  仅拖该行并把选中态转移给它；目录收起 / 折叠全部后，被隐藏行的选中项自动
  修剪（选中态是瞬态视图状态，不持久化）。组解析为纯函数
  （`resolveGroupDrop` / `orderedDragSources`，drag.spec 全量覆盖）
- **工作区 / 会话拖动引用**：行拖动保留 version 1 的
  `application/x-dsh-reference+json`（kind/id/label/mention）和规范 `text/plain`。
  工作区使用 workspace-chain 的 `@workspace-ref/<base64url(JSON({id,label}))>`
  编码，仅定位工作区 / 指定任务目标，**不会自动选择当前或最近会话**；空工作区
  同样可定位。会话行保留 DSH canonical session mention，显式引用该会话的历史。
  对话输入的结构化 drop / chip 插入由 **workspace-chain** 统一负责，并以 live
  kind/id 验证目标；本插件只提供拖动源，不监听窗口级对话 drop，不直接写 composer。
  侧栏树内移动、排序和整组拖动保持原行为。
- **内置状态复刻**：会话行状态点（running = 像素追逐 loading 动画 /
  等待处理 / 已完成），所在目录与工作区行（含最近使用行）同步点亮图标；
  **目录行聚合状态点**：收起时有会话在工作/等待/完成的目录行（含逐层
  father dir 链）在行尾显示整棵子树的最高优先级状态点（等待 > 工作中 >
  已完成，tooltip「n 个会话…」），子工作区的工作状态逐层同步到父目录
- **Hover 卡片（内置 ui-workspace 复刻）**：悬停真实工作区行 → 右侧弹出
  卡片（标题 + 完整目录路径 + 绝对创建时间，点击卡片复制路径）；悬停会话行
  → 卡片（标题 + 相对时间 + 实时状态 + 读写文件域，列表 <-> 目录树切换，
  文件行点击标记观察）。复用 `dsh-client-ui-primitives` 的 `HoverCard`
  原语（右侧定位 / 悬停驻留 / 复制反馈），内容与纯派生函数从内置 rows /
  tree 复刻。
- **Git 工作树层**：宿主 `git/probe`（`.git` 上行 walk + worktree 枚举，
  RPC 通道）派生——工作区行不展示分支 tag（用户反馈：太占位置；分支信息
  收敛到 hover 卡片），跨树会话数用「n 棵」小标、展开工作区的 subworkspace
  分组（本工作区 / linked 树 / 其他）、「按仓库分组」视图（repo 组 + 无
  git 工作区平铺 + 未注册工作树一键注册）、工作区 hover 卡片 git 区（分支 /
  角色 / 同仓库树）、行菜单「在目标树继续…」。
- **远程镜像 git 标记（联动 dsh-remote）**：镜像工作区
  （`~/.dsh/remote-workspaces/…`，本地目录无 `.git`，本地 probe 恒报无 git）
  的 hover 卡片改为直接消费 dsh-remote 宿主半的同源端点
  `GET /dsh-remote/git-workspace?local=<镜像路径>`——卡片远端 git 段
  `⎇ branch`（与 dsh-remote 自身 chip 一致，不显示脏/暂存计数——用户反馈）
  加 同步 / 远端机器 / 远端路径，行上不再渲染分支 tag；端点失败（离线 / 无
  凭据 / 非镜像 / 非仓库）一律静默降级为无标记，本地非镜像工作区行为不变。
- **Cmd/Ctrl+N 新建会话快捷键**：与工作区行内 `+` 按钮同效——命中
  Cmd/Ctrl+N（无 Shift/Alt 修饰、忽略自动重复）时**在当前工作区新建会话**：
  目标优先取**当前会话所在工作区**、其次**最近使用工作区**（与内置
  `startSession` 的回退链一致）；命中即展开该工作区的会话组并显式定向
  `startSession(workspaceId)`（组件 spec 覆盖三态目标与噪声键不触发）；
  没有任何工作区时退化为无参 `startSession()`（内置 New Session 视图）。
  监听器挂在浏览器区根组件（mount 一次注册 / 卸载清理），因此仅在侧边栏
  展开（浏览器区挂载）期间生效；收成 rail 时由 shell 的 rail 新建按钮兜底。
- **跟随 shell 侧边栏收起（rail）**：dsh 本体把侧边栏收成 56px rail 时，
  浏览器区同步折叠——宽幅内容（标题头 / 搜索框 / 目录树）随折叠淡出卸载，
  只保留搜索与添加工作区两个 36×36 rail 控件（图标 18px、主墨色、12px 节奏，
  与 shell rail 规范一致）；rail 搜索点击展开侧边栏并在滑入后自动聚焦搜索框
  （内置手势），进行中的搜索词跨折叠保留。
- **持久化**：目录树 / 展开状态 / 最近触摸 / 视图字段全部在插件 store
  （localStorage `dsh.enhanced-workspace.v1`）；Host 平铺顺序经
  `ctx.workspaces.insertBefore` 最小移动集 reconcile

设计文档：`docs/plan/2026-09-04-plugin-mode-design.md`（插件模式方案；
早前依赖 Host 侧改动的方案已废弃删除）。开发状态跟踪：`docs/plan/status.md`。

## 安装

```sh
dsh plugin --profile <name> add dsh-enhanced-workspace
```

`cordis.patch.yml` 随 `dsh.profile.bundles` 协调自动挂载；客户端 half 经
`dsh.plugin.json` 的 `client.main`（`lib/client-registry.js`）加载。

## 可选 Command Palette 联动

同时装载 `@deepseek-ai/dsh-client-ui-command-palette` 时，本插件向其
`commandPalette` 服务贡献「切换工作区 / Switch Workspace」命令和工作区 picker；两者 ID
均为 `workspaces.find`（不同注册表），可作为 palette 的 Quick Open 目标。
没有 palette 时不注册贡献、不影响工作区浏览器；服务卸载时随 fiber 清理，
再次提供服务时重新注册。顶层 `inject` 不包含 palette，也没有 palette 运行时包依赖；
开发时仅通过 `devDependencies` 的 `link:../dsh-command-palette` 消费 core 类型。

- 命令描述提供两层独立双语：稳定 `workspace` 总 tag（工作区 / Workspace）与
  子命令（切换工作区 / Switch Workspace）。title 仅返回当前语言，不拼接译文；
  保留 aliases/category。面板负责 locale 显示与两层 fuzzy 搜索，支持 `wsp swt`、
  `工区 switch`；纯英文与旧 provider 兼容，无强制 subtitle。
  图标已接入语义 ID：总 tag 为 `workspace`（工作区树），切换子命令为 `open`
  （打开的文件夹，不因 picker target 使用放大镜）；资源项不继承 tag 图标。
  详见[对接协议与验证边界](docs/command-palette.md)。
- 数据来自完整宿主工作区列表，不受侧边栏搜索、目录折叠或分页影响。
- 标签复用 workspace-controller 的 `workspaceDisplayTitle` helper 本地化默认
  工作区；搜索同时匹配存储标题、显示标题、路径 basename 和完整路径。
  查询按 NFKC、大小写与空白归一化，每个 token 必须命中；每 token 按
  精确、前缀、子串、有序子序列计分并累加，分数相同保留宿主顺序。
  空查询优先显示当前主视图会话所属工作区。
- 工作区列表未 ready 或连接未 connected 时显示错误，而不是「尚无工作区」；
  工作区、当前会话及连接变化会触发 picker 重新查询，语言切换会刷新标签。
- 确认时重新检查连接、列表与工作区身份；随后等待公开
  `uiWorkspace.openWorkspace(workspaceId)`，复用宿主的空会话复用/创建与导航策略，
  不另造会话创建流程。打开拒绝时返回 `failed` 并在浏览器 console 记录工作区
  ID、路径与原始错误，不再把 void handoff 提前报告为 `completed`。
  宿主仍负责导航 supersession：正常 resolve 也可能表示请求被后续导航取代，
  因而不额外发送切换成功 toast。交接后取消只抑制结果反馈，不撤销宿主导航。

## 开发

```sh
pnpm install
pnpm test            # 纯函数单测 + 组件 spec
pnpm typecheck
pnpm build && pnpm pack && pnpm test:mount
```

## Known Limitations

- 遮蔽形态下 workspace-logo 插件的行内 logo 槽位（`sidebar.workspaces.
  workspaceIcon/Menu/HoverIcon`）不可渲染（ui-slots 子槽位单声明者冲突）。
- Hover 卡片两处与内置的差异：卡片宽度用 `HoverCard` 原语默认 244px（内置
  会话卡片 300px 的 `width` 彩蛋要 ui-primitives 0.1.2 才发布，0.1.1-rc.1
  无此 prop）；路径不做 `~` 缩写（插件没有 host-description 注入钩子，
  未知 $HOME）。文件域若有长路径，卡片内文件盒横向滚动可达。
- Hover 卡片床面（`HoverCard` 原语 compact `.card`）原版两主题都写死暗色
  `#2C2C2E`、不随主题模块：插件用 `HoverCardSurfaceSync`（挂在卡片
  `content` 内，同步原语床面元素本身）把床面改读 `--dsw-alias-bg-layer-2`
  —— 其暗色值恰为原色，暗色观感不变，亮色自动获得浅色床面；复制反馈态
  （原语把内容换成写死 `#FFFFFF` 的标签）随卡片 `color` 一并自适应；卡内
  左内边距从原语 16px 收紧到 12px（与上下一致，卡在行右缘时 16px 读起来
  像多余空隙）。宿主无 alias token 时回退原语固定色。
- Hover 卡片锚点：fileTreeUi 行（label 槽是消费方唯一渲染面）里 `HoverCard`
  原版锚在框架的 `rowLabel` 片段上（实测首层缩进时卡片比行顶低 7px、left
  比行右缘缩进 ~48px，即「没 top 对齐、没 right 对齐」）。插件用
  `HoverRowAnchorSync`（包在 anchor prop 外）把原语根 span 按实测负外边距
  扩展到整行盒子（文字用等值 padding 钉回原视觉位置），根 span 转
  hit-test 透明（标签内容重新可命中）——卡片与内置 ui-workspace 一致：
  top 对齐行顶、距行右缘 8px；本地回退行（锚点即整行）不受影响。
- 目录树为插件本地权威：跨标签页并发编辑 last-writer-wins，不做冲突合并；
  reconcile 失败仅 `console.warn`（插件树仍是显示权威）。
- 目录与工作区的**拖拽已实现**（目录行正中 = 移入末尾；行上/下边、工作区
  行间 = 锚点插入，目录与工作区同层可穿插，跨目录亦可；⌘/Ctrl 多选 + 整组
  共同拖动见上方功能列表）；**会话行的拖拽排序
  （手动顺序编辑）尚未实现**（数据面与 `insertSessionBefore` 已就绪），留待
  后续迭代。
- **多选仅作用于可被拖拽的行**（folder 树 + 工作区行，含最近使用行、
  repo 视图的成员/平铺工作区行；fileTreeUi 组合 profile 的框架行同样支持
  ——多选走框架一等契约：行模型传 `selected` 数据态 +
  `onSelectToggle`，⌘/Ctrl+点击由框架路由、选中 wash 与 aria-selected
  由框架渲染（dsh-file-tree-ui `9cace1e` 起，需与 provider 同版本装载）；
  插件内置回退路径自绘选中态）；**repo 组头行**与未注册工作树分组行仍为
  单行拖拽。选中态不持久化、不参与「移动到…」等对话框。
- **Cmd/Ctrl+N 快捷键**只在浏览器区挂载期间生效（侧边栏展开态；收成
  rail 时由 shell 的 rail 新建按钮兜底）——机制描述见上方功能列表。
- 挂载冒烟 `pnpm test:mount` 需要 PATH 上有 `dsh` CLI 且已
  `pnpm exec playwright install chromium`（脚本使用 scratch DSH_HOME，
  不触碰真实 `~/.dsh`）。