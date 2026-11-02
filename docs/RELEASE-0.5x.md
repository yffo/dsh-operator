# 0.5x 发布说明（2026-11）

0.47–0.55 全部围绕一个目标：**同样一次操作，少一轮往返、少一份 token、失败能自己纠回来**。

## 亮点

| 版本 | 变化 | 为什么 |
|---|---|---|
| 0.47.0 | `browser_wait` 支持等文本 | 等异步渲染不用 sleep 猜 |
| 0.48.x | AX 失败自愈（`recovery` 带最新快照）、guard 拒绝给替代路径 | 控件失效时模型能当场换 index 重试 |
| 0.49.0 | `browser_state` 的 `max_refs` | 大页面 refs 可截断 |
| 0.50–0.51 | `click/type/key` 支持 `refresh`，一次调用拿到新 refs | 省掉一次 `browser_state` 往返 |
| 0.51.1 | `browser_prepare {app}` 兼容驱动 `app_name` | 真机上「按 app 找窗口」以前永远失败 |
| 0.51.2 | `refresh` 回包默认 20 个 ref | 35 个 ref 约 1.7KB，截半 |
| 0.52–0.53 | `console/network` 支持 `query`；console 支持 `level` | 只留相关日志，第三方噪音不占 token |
| 0.54.0 | `browser_state` 默认 `semantic_v2` | refs 带可见文案；实测同页 1078 字符 vs 1191，反而更短 |
| 0.55.0 | `browser_wait` 支持 `expect_url` | 等导航不依赖调试端口 |

## 升级注意

- 0.54 之后 `browser_state` 默认语义快照，按文案点击不再需要额外一次快照；驱动不支持时自动回退。
- `refresh` 默认只带 20 个 ref；要全量请显式 `browser_state max_refs`。
- `browser_download` 需要宿主确认通道，没有确认通道（CLI/独立进程）会如实拒绝。

## 真机验证记录（macOS，Chrome 156 + DSH 0.2.1-rc.5）

- `browser_prepare {app:"Chrome"}` → `已绑定 pid=2402 window=76`；
- `browser_state`（默认语义）→ `refs (9): p28:7 link Learn more …`；
- `browser_click {text:"Learn more", refresh:true}` → `已点击 p29:7`，回包 `refs (37)`；
- `browser_wait {expect_url:"help/example-domains"}` → `地址已变化：https://www.iana.org/help/example-domains（157ms）`。
