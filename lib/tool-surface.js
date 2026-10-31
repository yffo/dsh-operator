/**
 * v2 强工具分派器（0.17 起步）。
 *
 * 目的：把多个「动作相同、参数相近」的工具收敛成一个带 `action` 枚举的强工具，
 * 降低工具数量与 schema token；旧工具名保留一个版本过渡。
 *
 * 关键约束（踩过的坑）：
 * - DSH 输出 schema 校验是运行时的：`additionalProperties: false` 时必须把所有可能字段都声明；
 * - 合并多个工具的输出字段时**必须去掉 required**（否则某个 action 缺字段就判定失败）；
 * - 分派器只做路由，不重写被合并工具的 execute/render，避免行为漂移。
 */

/** 深拷贝一个 schema 子树并去掉 required 标记。 */
function stripRequired(node) {
	if (Array.isArray(node)) return node.map(stripRequired);
	if (node === null || typeof node !== "object") return node;
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "required") continue;
		out[key] = stripRequired(value);
	}
	return out;
}

/** 合并多个输出 schema 的 properties（先到先得；同名但结构不同时保留第一个）。 */
export function mergeOutputSchema(members) {
	const properties = {};
	for (const member of members) {
		const schema = member?.definition?.output?.schema;
		if (schema === null || typeof schema !== "object") continue;
		for (const [key, value] of Object.entries(schema.properties ?? {})) {
			if (properties[key] === void 0) properties[key] = stripRequired(value);
		}
	}
	return { type: "object", additionalProperties: false, properties };
}

/**
 * 把工具定义里的 `parameters` 归一化成「参数名 -> spec」映射。
 * 为何需要：注册进 DSH 后的工具定义，其 `parameters` 已被 defineTool 编译成
 * JSON Schema 形态 `{ type: "object", properties, required }`；而新建工具要用
 * 声明式参数映射。两种形态都要兼容，否则会把 type/properties 当成参数名。
 */
export function parameterSpecs(definition) {
	const parameters = definition?.parameters;
	if (parameters === null || typeof parameters !== "object") return {};
	if (parameters.type === "object" && parameters.properties !== null && typeof parameters.properties === "object") {
		const required = Array.isArray(parameters.required) ? parameters.required : [];
		const specs = {};
		for (const [key, value] of Object.entries(parameters.properties)) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
			// DSL 只接受 required: true 或省略；required:false 会被 schema 编译器拒绝
			specs[key] = required.includes(key) ? { ...value, required: true } : { ...value };
		}
		return specs;
	}
	return parameters;
}

/** 合并多个工具的入参（去掉 action 由分派器自己声明）。 */
export function mergeParameters(members) {
	const properties = {};
	const collisions = [];
	for (const member of members) {
		const parameters = parameterSpecs(member?.definition);
		for (const [key, value] of Object.entries(parameters)) {
			if (key === "action") continue;
			if (properties[key] !== void 0) {
				collisions.push(key);
				continue;
			}
			properties[key] = value;
		}
	}
	return { properties, collisions };
}

/**
 * 生成一个分派器定义（不注册，交给调用方 register）。
 *
 * @param {object} options
 * @param {string} options.name 新工具名
 * @param {string} options.description
 * @param {Map<string, any>} options.registry 统一注册表（name → 工具定义）
 * @param {Record<string, string>} options.actions action → 旧工具名
 * @param {(definition: any) => any} options.defineTool
 */
export function buildDispatcher({ name, description, registry, actions, defineTool, parameters, requiredByAction }) {
	const entries = Object.entries(actions);
	// registry 里的描述符有两种形态：扩展工具 { execute, render, definition } / fork 工具为原始定义。
	// 统一解析出 definition / execute / render 三件套，避免分派器依赖具体形态。
	const resolveMember = (toolName) => {
		const raw = registry.get(toolName);
		if (raw === void 0 || raw === null) return { toolName, definition: void 0, execute: void 0, render: void 0 };
		const definition = raw.definition !== void 0 ? raw.definition : raw;
		return {
			toolName,
			definition,
			execute: typeof raw.execute === "function" ? raw.execute : definition?.execute,
			render: typeof raw.render === "function" ? raw.render : definition?.output?.render
		};
	};
	const members = entries.map(([, toolName]) => resolveMember(toolName));
	const missing = members.filter((member) => member.definition === void 0 || typeof member.execute !== "function").map((member) => member.toolName);
	if (missing.length > 0) throw new Error(`${name}: missing tools for dispatch: ${missing.join(", ")}`);
	const merged = parameters !== void 0 ? { properties: parameters } : mergeParameters(members);
	const mergedParameters = merged.properties;
	const actionNames = entries.map(([action]) => action);
	const outputSchema = mergeOutputSchema(members);

	const definition = {
		name,
		description,
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: actionNames,
				description: `Action: ${actionNames.join(" | ")}.`
			},
			...mergedParameters
		},
		output: {
			schema: outputSchema,
			render(args, value) {
				const toolName = actions[args?.action];
				const member = members.find((entry) => entry.toolName === toolName);
				const render = member?.render;
				if (typeof render === "function") return render(args, value);
				return [{ type: "text", text: String(value?.text ?? "") }];
			}
		},
		isConcurrencySafe: () => true,
		presentCall: (args) => ({ title: name, detail: String(args?.action ?? "") }),
		async execute(args, exec) {
			const action = args?.action;
			const toolName = actions[action];
			if (toolName === void 0) throw new Error(`${name}: unknown action ${String(action)}`);
			const required = requiredByAction?.[action] ?? [];
			const missingArgs = required.filter((key) => {
				const value = args?.[key];
				return value === void 0 || (Array.isArray(value) && value.length === 0) || value === "";
			});
			if (missingArgs.length > 0) throw new Error(`${name}: missing parameter(s) for action "${action}": ${missingArgs.join(", ")}`);
			const member = members.find((entry) => entry.toolName === toolName);
			const rest = { ...args };
			delete rest.action;
			return member.execute(rest, exec);
		}
	};
	try {
		return defineTool(definition);
	} catch (error) {
		process.stderr.write("[cu_observe schema dump] " + JSON.stringify(definition.parameters).slice(0, 3000) + "\n");
		throw error;
	}
}

/** 判断某个分派器覆盖的工具是否全部在 registry 里（供测试/状态展示）。 */
export function dispatcherCoverage(actions, registry) {
	const missing = Object.values(actions).filter((toolName) => !registry.has(toolName));
	return { covered: Object.keys(actions).length - missing.length, total: Object.keys(actions).length, missing };
}
