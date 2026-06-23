/**
 * transport/protocol/ref-collection.ts 单元测试
 *
 * 覆盖 getLocalRefs / remoteRefsToMap
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";
import { getLocalRefs, remoteRefsToMap } from "@/transport/protocol/ref-collection.ts";

describe("getLocalRefs()", () => {
  test("空仓库返回空 Map（不含 HEAD）", () => {
    const refs = createMemoryRefStore();
    const result = getLocalRefs(refs);
    expect(result.size).toBe(0);
  });

  test("包含分支引用（含可解析的 HEAD）", () => {
    const refs = createMemoryRefStore();
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    refs.write("HEAD", "ref: refs/heads/main");
    refs.write("refs/heads/main", hash);

    const result = getLocalRefs(refs);
    expect(result.get("refs/heads/main")).toBe(hash);
    // HEAD 可解析为具体哈希时也会被包含
    expect(result.get("HEAD")).toBe(hash);
  });

  test("HEAD 直接指向哈希时也应包含", () => {
    const refs = createMemoryRefStore();
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    refs.write("HEAD", hash);

    const result = getLocalRefs(refs);
    expect(result.get("HEAD")).toBe(hash);
  });

  test("多个分支", () => {
    const refs = createMemoryRefStore();
    const h1 = sha1("1111111111111111111111111111111111111111");
    const h2 = sha1("2222222222222222222222222222222222222222");
    refs.write("refs/heads/main", h1);
    refs.write("refs/heads/feature", h2);

    const result = getLocalRefs(refs);
    expect(result.size).toBe(2);
    expect(result.get("refs/heads/main")).toBe(h1);
    expect(result.get("refs/heads/feature")).toBe(h2);
  });

  test("损坏的引用被静默跳过", () => {
    const initial = new Map<string, string>([
      ["refs/heads/good", "95d09f2b10159347eece71399a7e2e907ea3df4f"],
      ["refs/heads/bad", "not-a-valid-hash"],
    ]);
    const refs = createMemoryRefStore(initial);

    const result = getLocalRefs(refs);
    expect(result.get("refs/heads/good")).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
    expect(result.has("refs/heads/bad")).toBe(false);
  });

  test("标签引用", () => {
    const refs = createMemoryRefStore();
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    refs.write("refs/tags/v1.0", hash);

    const result = getLocalRefs(refs);
    expect(result.get("refs/tags/v1.0")).toBe(hash);
  });
});

describe("remoteRefsToMap()", () => {
  test("远程引用列表转换为 Map", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const refs = [
      { name: "HEAD", hash },
      { name: "refs/heads/main", hash },
    ];
    const result = remoteRefsToMap(refs);
    expect(result.size).toBe(2);
    expect(result.get("HEAD")).toBe(hash);
    expect(result.get("refs/heads/main")).toBe(hash);
  });

  test("空列表返回空 Map", () => {
    const result = remoteRefsToMap([]);
    expect(result.size).toBe(0);
  });

  test("相同名称后覆盖前（使用后出现的值）", () => {
    const h1 = sha1("1111111111111111111111111111111111111111");
    const h2 = sha1("2222222222222222222222222222222222222222");
    const refs = [
      { name: "refs/heads/main", hash: h1 },
      { name: "refs/heads/main", hash: h2 },
    ];
    const result = remoteRefsToMap(refs);
    expect(result.get("refs/heads/main")).toBe(h2);
  });
});
