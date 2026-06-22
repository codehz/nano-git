/**
 * Push Pack 规划测试
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { mergePushBoundaries, computeObjectsToSend } from "@/transport/push-pack-plan.ts";

import type { SHA1 } from "@/core/types.ts";
import type { PushRefItem } from "@/transport/push-ref-plan.ts";

describe("mergePushBoundaries", () => {
  test("无 shallow 且无 push refs 应返回 undefined", () => {
    const result = mergePushBoundaries(undefined, []);
    expect(result).toBeUndefined();
  });

  test("无 shallow 但有 push refs 应返回 remote tips", () => {
    const tip = sha1("0000000000000000000000000000000000000001");
    const pushRefs: PushRefItem[] = [
      {
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        localHash: tip,
        remoteHash: tip,
        force: false,
      },
    ];
    const result = mergePushBoundaries(undefined, pushRefs);
    expect(result).toBeInstanceOf(Set);
    expect(result!.has(tip)).toBe(true);
    expect(result!.size).toBe(1);
  });

  test("有 shallow 且无 push refs 返回 shallow set", () => {
    const shallow = new Set<SHA1>([sha1("0000000000000000000000000000000000000002")]);
    const result = mergePushBoundaries(shallow, []);
    expect(result).toBeInstanceOf(Set);
    expect(result!.size).toBe(1);
  });

  test("合并 shallow 和 push refs", () => {
    const shallow = new Set<SHA1>([sha1("0000000000000000000000000000000000000001")]);
    const tip = sha1("0000000000000000000000000000000000000002");
    const pushRefs: PushRefItem[] = [
      {
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        localHash: tip,
        remoteHash: tip,
        force: false,
      },
    ];
    const result = mergePushBoundaries(shallow, pushRefs);
    expect(result!.size).toBe(2);
    expect(result!.has(sha1("0000000000000000000000000000000000000001"))).toBe(true);
    expect(result!.has(sha1("0000000000000000000000000000000000000002"))).toBe(true);
  });

  test("过滤掉 remoteHash 为 null 的 push refs", () => {
    const pushRefs: PushRefItem[] = [
      {
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        localHash: sha1("0000000000000000000000000000000000000001"),
        remoteHash: null,
        force: false,
      },
    ];
    const result = mergePushBoundaries(undefined, pushRefs);
    expect(result).toBeUndefined();
  });
});

describe("computeObjectsToSend", () => {
  test("推送本地新增对象应全部包含", () => {
    const store = createMemoryObjectStore();
    const localHash = store.write({ type: "blob", content: Buffer.from("new content") });

    const pushRefs: PushRefItem[] = [
      {
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        localHash,
        remoteHash: null,
        force: false,
      },
    ];
    const remoteRefs = new Map<string, SHA1>();

    const result = computeObjectsToSend(store, pushRefs, remoteRefs, undefined);
    expect(result).toContain(localHash);
  });

  test("远程已有的对象应被排除", () => {
    const store = createMemoryObjectStore();
    const sharedHash = store.write({ type: "blob", content: Buffer.from("shared") });
    const localOnlyHash = store.write({ type: "blob", content: Buffer.from("local only") });

    const pushRefs: PushRefItem[] = [
      {
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        localHash: localOnlyHash,
        remoteHash: sharedHash,
        force: false,
      },
    ];
    const remoteRefs = new Map<string, SHA1>([["refs/heads/main", sharedHash]]);

    const result = computeObjectsToSend(store, pushRefs, remoteRefs, undefined);
    expect(result).not.toContain(sharedHash);
    expect(result).toContain(localOnlyHash);
  });

  test("删除操作（localHash === null）跳过对象收集", () => {
    const store = createMemoryObjectStore();
    // 创建一个对象但不被 push ref 引用（删除操作）
    store.write({ type: "blob", content: Buffer.from("deleted content") });

    const pushRefs: PushRefItem[] = [
      {
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        localHash: null,
        remoteHash: sha1("0000000000000000000000000000000000000001"),
        force: false,
      },
    ];
    const remoteRefs = new Map<string, SHA1>();

    const result = computeObjectsToSend(store, pushRefs, remoteRefs, undefined);
    expect(result).toEqual([]);
  });
});
