/**
 * seam provider 适配单测（0.21.12 / PLAN 0.11-4）。
 * 用一个最小的假 ctx / seam 覆盖四条路径：未挂载、空闲注册、本包已注册（幂等）、他方占用（fail-fast）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimSeamProvider, seamRegistryOf, SEAM_PROVIDER_NAME } from "../lib/seam-provider.js";
import { collectStatus } from "../lib/status.js";

function fakeCtx(seam) {
	return { get: (name) => (name === "computerUse" ? seam : void 0) };
}

test("seam 未挂载：不注册、不抛错", () => {
	assert.equal(seamRegistryOf(fakeCtx(void 0)), void 0);
	assert.deepEqual(claimSeamProvider(fakeCtx(void 0)), { attached: false });
	assert.deepEqual(claimSeamProvider(void 0), { attached: false });
});

test("seam 空闲：用 dsh-operator 注册并返回 release", () => {
	const calls = [];
	let released = false;
	const seam = {
		providerName: void 0,
		register: (name) => {
			calls.push(name);
			return () => {
				released = true;
			};
		}
	};
	const claim = claimSeamProvider(fakeCtx(seam));
	assert.equal(calls.length, 1);
	assert.equal(calls[0], SEAM_PROVIDER_NAME);
	assert.equal(claim.attached, true);
	assert.equal(claim.providerName, "dsh-operator");
	assert.equal(typeof claim.release, "function");
	claim.release();
	assert.equal(released, true);
});

test("本包已注册：幂等跳过、不重复注册", () => {
	const seam = {
		providerName: SEAM_PROVIDER_NAME,
		register: () => {
			throw new Error("should not register twice");
		}
	};
	const claim = claimSeamProvider(fakeCtx(seam));
	assert.equal(claim.attached, false);
	assert.equal(claim.providerName, SEAM_PROVIDER_NAME);
});

test("他方占用：fail-fast 并给出二选一提示", () => {
	const seam = { providerName: "cua-driver-native", register: () => () => {} };
	assert.throws(() => claimSeamProvider(fakeCtx(seam)), /已被 "cua-driver-native" 注册/);
	assert.throws(() => claimSeamProvider(fakeCtx(seam)), /独占槽位/);
});

test("operator_status 文本/字段暴露 seam provider（有则显示、无则省略）", () => {
	const withSeam = collectStatus({ version: "0.21.12", platform: "darwin", seamProvider: "dsh-operator", home: "/tmp/nonexistent-home" });
	assert.equal(withSeam.seamProvider, "dsh-operator");
	assert.ok(withSeam.text.includes("seam provider: dsh-operator"));
	const withoutSeam = collectStatus({ version: "0.21.12", platform: "darwin", home: "/tmp/nonexistent-home" });
	assert.equal(withoutSeam.seamProvider, void 0);
	assert.ok(withoutSeam.text.includes("seam provider:") === false);
});
