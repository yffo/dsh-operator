/**
 * v2 工具面收敛（0.17）第一步：注册表统一。
 *
 * 工具实现目前分散在两处：
 * - `lib/operator-tools.js` 注册的 24 个扩展工具（handlers Map，同时供 skill_run/plan_run 回放）；
 * - fork 的 `lib/computer-use/index.js` 注册的 14 个桌面基础工具（screenshot/click/…）。
 *
 * 这里提供一个纯函数把两边合成一个只读视图，供未来的 `cu_observe`/`cu_act` 分派器使用。
 * 本步不改变任何现有工具行为；重名时先注册者优先（两边目前没有重名）。
 */

/**
 * 合并多个「工具名 → 描述符」映射。
 * @param {...(Map<string, unknown> | undefined | null)} maps
 * @returns {Map<string, unknown>}
 */
export function mergeToolRegistries(...maps) {
	const merged = new Map();
	for (const map of maps) {
		if (!(map instanceof Map)) continue;
		for (const [name, descriptor] of map) {
			if (typeof name !== "string" || name.length === 0) continue;
			if (merged.has(name)) continue;
			merged.set(name, descriptor);
		}
	}
	return merged;
}

/**
 * 取名字列表（排序后），便于测试和状态展示。
 * @param {Map<string, unknown>} registry
 * @returns {string[]}
 */
export function registryNames(registry) {
	if (!(registry instanceof Map)) return [];
	return [...registry.keys()].sort();
}

/**
 * 判断注册表里是否有某个工具。
 * @param {Map<string, unknown>} registry
 * @param {string} name
 */
export function hasTool(registry, name) {
	return registry instanceof Map && registry.has(name);
}
