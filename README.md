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
  重名校验；行菜单操作 + 「移动到…」目录选择器）
- **拖拽**：工作区拖到目录行 = 移入该目录末尾，拖到工作区行间 = 锚点插入
  （含跨目录）；目录拖到目录行 = 移入 / 行间重排（环 / 深度守卫，失败非致命）；
  会话组内排序策略：按活动（默认）或手动顺序
- **内置状态复刻**：会话行状态点（running = 像素追逐 loading 动画 /
  等待处理 / 已完成），所在目录与工作区行（含最近使用行）同步点亮图标
- **Hover 卡片（内置 ui-workspace 复刻）**：悬停真实工作区行 → 右侧弹出
  卡片（标题 + 完整目录路径 + 绝对创建时间，点击卡片复制路径）；悬停会话行
  → 卡片（标题 + 相对时间 + 实时状态 + 读写文件域，列表 <-> 目录树切换，
  文件行点击标记观察）。复用 `dsh-client-ui-primitives` 的 `HoverCard`
  原语（右侧定位 / 悬停驻留 / 复制反馈），内容与纯派生函数从内置 rows /
  tree 复刻。
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
- 目录树为插件本地权威：跨标签页并发编辑 last-writer-wins，不做冲突合并；
  reconcile 失败仅 `console.warn`（插件树仍是显示权威）。
- 目录与工作区的**拖拽已实现**（目录行 = 移入末尾；工作区行间 = 锚点插入，
  跨目录亦可）；**会话行的拖拽排序（手动顺序编辑）尚未实现**（数据面与
  `insertSessionBefore` 已就绪），留待后续迭代。
- 挂载冒烟 `pnpm test:mount` 需要 PATH 上有 `dsh` CLI 且已
  `pnpm exec playwright install chromium`（脚本使用 scratch DSH_HOME，
  不触碰真实 `~/.dsh`）。