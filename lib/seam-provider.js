/**
 * 官方 computer-use seam 的 provider 适配（0.21.12 / PLAN 0.11-4）。
 *
 * 背景：`@deepseek-ai/dsh-computer-use` 的 seam 并**不是**工具目录/ActionResult 契约，
 * 它只有一个「单 provider 独占槽位」的注册表：
 *   - 服务名 `computerUse`，`register(name)` 占用槽位并返回释放函数；
 *   - `providerName` 只用于诊断；
 *   - seam 自身不注册模型可见工具、不协调 Session；工具与语义仍由 provider 自己负责。
 * 因此本包接入 seam 的成本很低：seam 已挂载时注册一个 provider 名，卸载时释放；
 * seam 未挂载时保持原有的 host 层全局挂载行为（向后兼容）。
 *
 * 官方 provider 用 `inject: ["computerUse", ...]` 做必需注入；本包必须兼容
 * 「没装 seam 的现有用户」，所以不用 inject，而是运行时 `ctx.get("computerUse")` 探测。
 */

/** 本包在 seam 里注册的 provider 名（与包名一致，便于诊断）。 */
export const SEAM_PROVIDER_NAME = "dsh-operator";

/**
 * 取 seam 注册表；未挂载 seam 时返回 undefined。
 * @param {object | undefined} ctx cordis 插件上下文
 * @returns {{ providerName?: string, register: (name: string) => () => unknown } | undefined}
 */
export function seamRegistryOf(ctx) {
	if (ctx === void 0 || typeof ctx.get !== "function") return void 0;
	const seam = ctx.get("computerUse");
	if (seam === void 0 || typeof seam.register !== "function") return void 0;
	return seam;
}

/**
 * 占用 seam 的 provider 槽位。
 * - seam 未挂载：`{ attached: false }`，调用方继续全局挂载；
 * - 槽位已被本包占用（热重载）：`{ attached: false, providerName }`，幂等跳过；
 * - 槽位被其它 provider 占用：抛错，避免两套 computer-use 同时抢桌面；
 * - 槽位空闲：注册并返回 `release`（调用方应挂在自身 effect 作用域里，卸载时释放）。
 * @param {object | undefined} ctx cordis 插件上下文
 * @param {string} providerName 注册名
 * @returns {{ attached: boolean, providerName?: string, release?: () => unknown }}
 */
export function claimSeamProvider(ctx, providerName = SEAM_PROVIDER_NAME) {
	const seam = seamRegistryOf(ctx);
	if (seam === void 0) return { attached: false };
	const taken = typeof seam.providerName === "string" && seam.providerName.length > 0 ? seam.providerName : void 0;
	if (taken === providerName) return { attached: false, providerName };
	if (taken !== void 0) {
		throw new Error(
			`computer-use seam 已被 "${taken}" 注册；dsh-operator 需要独占槽位（二选一：移除官方 provider，或不要把 dsh-operator 和 seam 同时挂载）`
		);
	}
	const release = seam.register(providerName);
	return { attached: true, providerName, release };
}
