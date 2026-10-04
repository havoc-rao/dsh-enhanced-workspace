# commandPalette 可选对接

工作区插件客户端通过 `installWorkspacePalette(ctx)` 的可选
`ctx.inject(['commandPalette'], paletteCtx => …)` 安装真实 provider。
所有字典、贡献和 locale 订阅由注入子上下文 effect 管理；服务缺席时不影响侧栏，
服务失效/插件卸载时注销自己的贡献，不 dispose 共享面板服务。
运行时代码不导入 palette 实现，仅 type-import `/core` 契约。

## 两层双语描述与语义图标（已接入）

[真实 provider](../src/client/command-palette/provider.ts) 返回插件/领域总 tag 与
独立子命令标题和图标，不新增可执行的总命令：

```ts
const workspaceTag = {
  id: 'workspace',
  title: 'Workspace',
  localizedTitles: { zh: '工作区', en: 'Workspace' },
  iconId: 'workspace',
} as const;
// 现有 workspaces.find 的 describe；copy/metadata/aliases 均为 provider 现有定义。
// describe 时动态读取当前语言，注册与 picker target 不变。
return {
  pluginTag: workspaceTag,
  iconId: 'open',
  title: copy().commandTitle, // zh: 切换工作区；en: Switch Workspace
  localizedTitles: {
    zh: workspaceCommandMetadata.zh.title,
    en: workspaceCommandMetadata.en.title,
  },
  category: copy().category,
  aliases: workspaceCommandAliases,
};
```

同插件命令应复用同一个稳定 tag ID 和一致文案。保留既有查找/搜索/打开别名与
当前语言 category；中文 title 不拼接 ` · Switch Workspace` 等英文后缀。
目前只有 `workspaces.find` 一条命令，引用同 ID 的本地工作区 picker。

tag 与 child 的 zh/en 都是可选字段，纯英文、仅 title 的旧 provider 都合法，
没有必须返回的 subtitle。主标题与 tag 按 locale 由面板解析；仅中文 locale
显示不重复的独立英文翻译纯文本（无 EN 标签），英文 locale 不显示中文次标题。

tag 的 ID/title/zh/en 和 child 的 ID/title/zh/en、aliases/category 全部由
面板做 fuzzy 搜索（精确、前缀、子串、顺序非连续字符），所有 token 均需匹配，
可跨层命中。例如 `wsp swt`、`工区 switch` 都找到工作区切换命令。
不要为了命令搜索改变资源 picker 的查询逻辑。

## 已接入的图标选型

palette 真实类型已公开 `PaletteIconId = 'workspace' | 'git' | 'search' | 'create' | 'open'`，
`CommandPluginTag`、`CommandDescriptor` 与 `PickerItem` 均支持可选 `iconId`。
本仓库使用真实契约类型安全接入，不用断言或 ts-ignore 绕过字段检查。
controller 的 `DisplayRow.iconId/pluginTagIconId` 传递纯数据，palette UI 静态
映射 DSH shared SVG；生产 provider 不导入 React 图标、不传 ReactNode/原始 SVG，
也不把组件名写入旧 `icon` 文本或使用 emoji 假装 SVG。

| 贡献 | 生产字段与取值 | palette UI 映射的 DSH 共享组件 | 理由 |
| --- | --- | --- | --- |
| 总 tag `workspace`（工作区 / Workspace） | `pluginTag.iconId: 'workspace'` | `IconWorkspaceTreeOutlineRegular` | 表示工作区域/目录树身份 |
| 唯一子命令 `workspaces.find`（切换工作区 / Switch Workspace，target 为 picker） | `CommandDescriptor.iconId: 'open'` | `IconFolderOpenOutlineRegular` | 打开的文件夹表达打开/切换工作区入口，不使用放大镜；仅覆盖自身，不改变 tag |
| picker `workspaces.find` 返回的工作区资源项 | 不配置 item iconId 或旧 icon | 保留原有资源回退 | 资源不是子命令，不继承 workspace tag 或 open 动作图标 |

切换工作区的主要动作是打开/切换目标，故选 `open`，**不因 target 为 picker
就强制放大镜**。`search` → `IconSearchOutlineRegular` 仍是通用查询/查找语义，
供真正以查询为主要动作的其他命令使用，不是本插件切换工作区的选型。

当前没有 palette 创建工作区或 Git 子命令，因此不选 `create` / `git`，也不为
图标展示新增没有业务实现的贡献。未来若真正贡献创建动作，再独立选择 `create`
（`IconPlusOutlineRegular`）；Git 动作/领域如有需要再选择 `git`
（`IconBranchOutlineRegular`）。同一插件的子命令可以使用不同语义 ID。

### 回退约定与验证边界

- 子命令行按「有效自身 iconId → 非空旧 icon 文本 → 有效 tag iconId →
  原有通用回退」解析；总 tag 标题只用自己的有效 iconId。单行覆盖不改变
  共享 tag 或其他命令；未知 ID 按缺失继续回退。旧 icon 仍为文本，不解析名称。
- 资源项按「有效 item iconId → 非空旧 icon 文本 → 原有资源回退」解析，
  **不继承 tag**，包括直接打开 picker 的场景。
- 图标与 locale 无关、不参与 fuzzy 搜索，UI 使用 currentColor 与统一尺寸。
- 本仓库真实 controller 回归验证命令行同时传递 `iconId: 'open'` 与
  `pluginTagIconId: 'workspace'`，语言切换后保持一致；由命令进入与直接打开
  picker 的资源行都不继承这两个字段。UI resolver 自身的完整映射、未知 ID
  及旧文本兼容测试归 palette 仓库维护。
- 已接入源码和 snapshot 不等于已部署到宿主浏览器；本轮未做真实 GUI 验证，
  不宣称当前页面已加载新的打开文件夹 SVG。

## 保持不变的资源与生命周期边界

- picker 使用完整宿主目录，不读取侧栏折叠/过滤后的 DOM；queryMode 为 local。
- picker 自己匹配名称、显示名、路径和 basename，排序、截断并返回 hasMore。
- accept 重新解析最新目录、连接状态与目标；提交前检查 abort，等待公开
  `uiWorkspace.openWorkspace`；提交后取消不回滚，不重复打开或发送成功 toast。
- workspace/session/connection 的订阅仅在 picker 激活时由控制器管理；locale
  改变动态刷新文案；注册失败回滚 picker，注销幂等并逆序清理。

## 验证

[command-palette.spec.ts](../tests/command-palette.spec.ts) 使用链接包真实
`createPaletteController`，覆盖安装后的两层描述、图标 snapshot 与资源不继承，
中英文/跨层模糊搜索、纯英文及旧 provider 兼容，并回归查询/导航/返回/卸载、
注册失败、动态 locale、连接变化和取消边界。
这不是宿主浏览器端验证；不据此宣称当前 GUI 已挂载或快捷键已交付。

契约依据：[palette 对接协议](../../dsh-command-palette/docs/cmd-integration.md)。
