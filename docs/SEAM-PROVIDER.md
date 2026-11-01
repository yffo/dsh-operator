# 官方 computer-use seam 的 provider 适配

> 0.21.12 / PLAN 0.11-4。研究结论：seam 契约极薄（只是一个独占注册表），所以本包**以 provider 形态加入官方 seam 的成本很低**，无需任何工具目录 / ActionResult / element token 映射。

## 1. seam 到底是什么

`@deepseek-ai/dsh-computer-use`（`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-computer-use`）的全部实现只有：

- `class ComputerUseRegistry extends Service`，服务名 `computerUse`
- `register(name): () => Promise<void>`：**单 provider 独占槽位**，重复注册直接抛错
- `get providerName()`：仅用于诊断

它**不**负责工具目录、动作语义、`ActionResult`、`element token`、`verify_state` 谓词，也不注册模型可见工具、不协调 Session。这些全部由 provider 自己实现。官方 provider（`dsh-experimental-computer-use-cua-driver-native`）就是「自己注册工具 + 自己跑原生 SDK + 向 seam 报名」。

## 2. 本包的接入行为

新增 `lib/seam-provider.js`：

| 场景 | 行为 |
|---|---|
| seam 未挂载（现有用户） | 探测不到 `computerUse` 服务 → 保持原有 **host 层全局挂载**，行为不变 |
| seam 已挂载且槽位空闲 | 以 `dsh-operator` 注册为官方 provider，并用 generator effect 绑定本插件生命周期（插件卸载时释放槽位） |
| 槽位已是本包（热重载） | 幂等跳过，不重复注册 |
| 槽位被其它 provider 占用 | **fail-fast** 抛错：`computer-use seam 已被 "<name>" 注册；dsh-operator 需要独占槽位（二选一：移除官方 provider，或不要把 dsh-operator 和 seam 同时挂载）` |

实现要点：

- 不用 cordis 的 `inject: ["computerUse"]`（必需注入会让没装 seam 的用户直接加载失败），而是运行时 `ctx.get("computerUse")` 探测；
- `brand` 只是类型层的 branded string，运行时是恒等函数，所以直接传 `"dsh-operator"` 即可，不需要 import seam 包（保持零依赖）；
- `operator_status` 输出新增 `seamProvider: string`（仅当已注册 seam 时出现），文本里多一行 `seam provider: dsh-operator`。

## 3. 怎么启用（可选）

本包永远可以直接全局挂载（默认方式）。想用「官方 seam + 本包 provider」的组合：

1. profile 依赖里装 seam：`@deepseek-ai/dsh-computer-use`（官方实验版 rc 即可）
2. `~/.dsh/profiles/desktop/cordis.patch.yml` 里挂一行 seam，例如：

```yaml
- name: '@deepseek-ai/dsh-computer-use'
```

3. 重启 App；`operator_status` 里出现 `seam provider: dsh-operator` 即生效。

**注意**：同一组合里不要再挂官方 cua-driver-native provider——两套 computer-use 抢桌面，本包会按上面的语义直接抛错。真要用官方 provider，就把 dsh-operator 从组合里移掉（二选一）。

## 4. 验证方式

- 静态：`node scripts/check-p0.mjs`（含 seam 接入三项守卫）
- 单元：`npm test`（`test/seam-provider.test.mjs` 覆盖未挂载 / 空闲注册 / 幂等 / 他人占用 / 状态字段）
- 引导：`npm run preflight`（未挂载 seam 时插件必须正常启动）
- 运行时：挂 seam + 重启后看 `operator_status` 的 `seamProvider` 字段
