# delegate_workspace 委派体验问题分析与优化任务书

> 2026 现场记录：三次委派全部 `workspace delegation ended: aborted`，无输出。
> 本文档 = 问题分析（可直接作为 dsh-workspace-chain 的改进输入）+ 续做任务书。

## 1. 事实现场（三次委派记录）

| # | 时间 | 目标工作区 | 模式 | 结果 | 旁证 |
| --- | --- | --- | --- | --- | --- |
| 1 | 会话内 | dsh-remote | 前台 | `workspace delegation ended: aborted`，Diagnostic 仅 session id（session-145262c3-…） | dsh-remote 仓库留下半成品（cordis.patch.yml 的 `!!js` config 表达式 + lib/index.js 的 schema/优先级链，`node --check` 通过）→ 任务实际执行到"主体实现完成、验证未收尾" |
| 2 | 会话内 | dsh-remote | 后台 | 运行中 `job_output` 无过程输出；`wait: true` 直接 `Error: wait aborted`；结算同 1（session-8393ca48-…） | 同上（同一个任务的延续，未新增提交） |
| 3 | 会话内 | dsh-workspace-chain | 后台 | 同 1（session-4d95d586-…），无输出 | 无（目标仓库无改动） |

关键事实：

- **三个目标不同的会话（两个不同工作区）以同一错误终止** → 指向委派通道/宿主会话管理的系统性问题，不是某个工作区或任务本身的问题；
- **会话确实能执行**（#1 有真实半成品产出），但最终被被动中止，且父会话拿不到任何诊断；
- **父会话全程无法干预**：`list_agents` 看不到委派会话、不能追加消息；`job_output` 运行中无过程输出；
- **任务书只存在于调用参数里**，abort 后丢失；新会话只能靠文件系统脏状态（git status / diff）反推进展。

## 2. 问题清单与根因推断

### P1 失败诊断缺失
- 现象：aborted 只回传 session id，无原因分类（timeout / 主动 cancel / 会话 crash / 宿主回收）、无目标会话 transcript/日志路径、无最后进度/产物快照。
- 根因推断：结算路径只透传了宿主 session API 的终止信号，没有把诊断面（日志、状态、分类）接出来。README 声称"失败和部分输出如实回传"——与实际不符，属机制缺口或未覆盖"被动中止"路径。
- 影响：父会话无法判断"没开始 / 执行中 / 执行完但没回报"，只能外部推断（#1 靠 git status）。

### P2 过程不可见
- 现象：后台 job 运行中 `job_output` 返回 `(no new output)`；无 heartbeat、无 checkpoint、无阶段性输出。
- 根因推断：`sessions.prompt` + `agent.whenIdle()` 是"整轮结束"模型，天然无过程输出；插件没有为长任务定义中间可见性协议。
- 影响：长任务（如跨仓库改动+验证）在数十分钟内对父会话是黑盒。

### P3 等待/收取通道不稳定
- 现象：`job_output wait: true` 直接 `Error: wait aborted`；前台模式长调用也被 abort。
- 根因推断：等待通道的"中止"与"任务失败"没有区分；没有超时契约（defaultTimeoutMs 300000 仅 SDK 路径，本地路径无对应护栏）；wait 超时没有返回"still running + 已等待时长"的明确状态。
- 影响：父会话对"是否还在跑 / 何时有结果 / 该不该等"失去确定性。

### P4 不可恢复
- 现象：abort 后任务书与上下文全部丢失；无续跑入口；半成品依赖文件系统脏状态推断。
- 根因推断：任务书未持久化，委派会话是 fresh session（不恢复父会话上下文），宿主保留的真会话没有统一的"恢复指引"被回传给父会话。
- 影响：重试 = 从零再来；#2 重试时任务书靠父会话手工重写，进展靠 diff 推断。

### P5 父会话无干预能力
- 现象：`list_agents` 看不到委派会话；无法 send_message；无法在 abort 前追加指令或拉取中间结果。
- 根因推断：委派会话登记在宿主工作区注册表而非父会话的 subagent 树，父会话侧没有任何观察/控制句柄。
- 影响：发现任务走偏/挂起时只能干等或 job_kill（且 kill 的语义与目标会话取消未联动验证）。

### P6 版本/环境敏感（待宿主侧核查）
- dsh-workspace-chain README 明确"已验证组合：核心运行时 0.1.2-rc.1，SDK client 固定 0.1.1-rc.2"，"已有 profile 应先核对宿主版本"——三次 aborted 也可能与宿主 session API 行为（被动回收策略）相关。**需要在宿主侧确认：委派会话是否有时长/资源限制、aborted 是否对应某条宿主策略。**

## 3. 优化建议（按优先级）

1. **结构化失败诊断**：aborted 结算返回 `{ status: 'failed', reason: 'timeout' | 'cancelled' | 'crash' | 'host-reclaim' | 'unknown', sessionId, logPath?, lastCheckpoint?, resumeHint? }`。报告里给出"从宿主侧如何找回该会话"的明确路径（README 声称任务结束后会话保留，可从工作区列表打开继续——把这个能力变成诊断的一部分）。
2. **轻量 checkpoint 协议**：委派时在目标工作区写入 `<workspace>/.dsh/delegations/<delegationId>/`，含 `task.md`（任务书全文）、`progress.md`（目标会话每完成一个可验证步骤 append 一行）、`resume.md`（新会话续跑指引）。父会话侧 `job_output` 返回该目录摘要。
3. **任务书持久化 + 恢复路径**：task.md/resume.md 即持久化；提供"基于任务文件 + 现场续跑"的任务书模板（新会话读取 task.md + 查看 progress.md + git status 后继续）。
4. **等待语义**：wait 超时返回 `still-running + 已等待时长 + progress 摘要位置 + 建议（继续等/查看/kill）`，不裸 abort；前台模式长任务护栏（文档明确预期时长行为或自动转后台）。
5. **结算通知结构化**：done/failed/cancelled/timeout 分类 + 上述字段；新增字段，保持旧字段兼容。
6. **文档与测试**：README 能力声明与实际行为对齐（"失败和部分输出如实回传"等）；tests 覆盖可测部分，纯机制写明手工验证步骤。

## 4. 给 dsh-workspace-chain 的复现用例

- 用例 A：委派一个长任务（如跨仓库改动+构建+测试）到任意本地工作区，观察前台/后台两种模式 → 预期得到结构化失败或 checkpoint 摘要，而非裸 aborted。
- 用例 B：任务进行中 `job_output` → 应能读到 progress.md 摘要（无则说明协议未生效）。
- 用例 C：`job_output wait: true` 超过等待上限 → 应返回 still-running 状态而非 Error: wait aborted。
- 用例 D：abort 后按 resume.md 指引开新会话续跑 → 应能基于 task.md + progress.md + 工作区现场继续。

## 5. 续做路径（三选一）

- **A**：修复委派通道后，将本任务书原样委派给 dsh-workspace-chain 落地实现；
- **B**：用户手动在 dsh-workspace-chain 工作区开会话，粘贴第 3/4 节内容作为任务书执行；
- **C**：先做 P6 宿主侧核查（会话回收策略、版本匹配），确认根因后再选 A/B。