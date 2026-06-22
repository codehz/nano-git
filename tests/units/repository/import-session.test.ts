/**
 * Import Session 单元测试
 *
 * 测试 Phase 1 只读会话的冻结语义和 view 操作。
 * 不依赖 HTTP 传输，直接构造 mock advertisement。
 *
 * @see .drafts/import-session-rfc.md
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { createPackWriter } from "@/odb/pack/index.ts";
import { createMemoryRepositoryBackend } from "@/repository/backend/index.ts";
import {
  createImportSession,
  createRepoImportOperations,
  createImportView,
  matchRefGlob,
} from "@/repository/import-session.ts";
import { encodePktLine } from "@/transport/pkt-line.ts";

import type { RemoteRef, RefAdvertisement } from "@/transport/types.ts";

// ============================================================================
// Mock 数据
// ============================================================================

const MOCK_HASH_A = sha1("a".repeat(40));
const MOCK_HASH_B = sha1("b".repeat(40));
const MOCK_HASH_C = sha1("c".repeat(40));
const MOCK_HASH_D = sha1("d".repeat(40));

function createMockAdvertisement(overrides?: Partial<RefAdvertisement>): RefAdvertisement {
  const refs: RemoteRef[] = [
    { hash: MOCK_HASH_A, name: "HEAD", symrefTarget: "refs/heads/main" },
    { hash: MOCK_HASH_A, name: "refs/heads/main" },
    { hash: MOCK_HASH_B, name: "refs/heads/develop" },
    { hash: MOCK_HASH_B, name: "refs/heads/feature/login" },
    { hash: MOCK_HASH_C, name: "refs/tags/v1.0.0" },
    { hash: MOCK_HASH_C, name: "refs/tags/v1.1.0" },
    { hash: MOCK_HASH_D, name: "refs/tags/v2.0.0-beta" },
  ];

  return {
    capabilities: {},
    refs,
    defaultBranch: "refs/heads/main",
    ...overrides,
  };
}

const MOCK_SOURCE = { url: "https://example.com/repo.git" };

// ============================================================================
// Glob 模式匹配
// ============================================================================

describe("glob 模式匹配", () => {
  test("精确匹配", () => {
    expect(matchRefGlob("refs/heads/main", "refs/heads/main")).toBe(true);
  });

  test("通配符匹配分支", () => {
    expect(matchRefGlob("refs/heads/*", "refs/heads/main")).toBe(true);
    expect(matchRefGlob("refs/heads/*", "refs/heads/develop")).toBe(true);
    expect(matchRefGlob("refs/heads/*", "refs/tags/v1.0")).toBe(false);
  });

  test("通配符匹配 tag 前缀", () => {
    expect(matchRefGlob("refs/tags/v*", "refs/tags/v1.0.0")).toBe(true);
    expect(matchRefGlob("refs/tags/v*", "refs/tags/v2.0.0-beta")).toBe(true);
    expect(matchRefGlob("refs/tags/v*", "refs/heads/main")).toBe(false);
  });

  test("不匹配不相关模式", () => {
    expect(matchRefGlob("refs/heads/main", "refs/heads/develop")).toBe(false);
    expect(matchRefGlob("refs/heads/*", "refs/tags/v1.0")).toBe(false);
  });

  test("通配符匹配子路径", () => {
    expect(matchRefGlob("refs/heads/*", "refs/heads/feature/login")).toBe(true);
  });
});

// ============================================================================
// View 操作
// ============================================================================

describe("ImportView", () => {
  const adv = createMockAdvertisement();

  test("where 过滤保留匹配项", () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const branches = view.where((ref) => ref.name.startsWith("refs/heads/"));
    expect(branches.refs.length).toBe(3);
    expect(branches.refs.map((r) => r.name).sort()).toEqual([
      "refs/heads/develop",
      "refs/heads/feature/login",
      "refs/heads/main",
    ]);
  });

  test("where 空条件返回空视图", () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const empty = view.where(() => false);
    expect(empty.refs.length).toBe(0);
  });

  test("exclude 排除匹配模式", () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const withoutBeta = view.exclude("refs/tags/*beta*");
    expect(withoutBeta.refs.some((r) => r.name === "refs/tags/v2.0.0-beta")).toBe(false);
    expect(withoutBeta.refs.some((r) => r.name === "refs/tags/v1.0.0")).toBe(true);
  });

  test("union 合并两个视图", () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const branches = view.where((ref) => ref.name.startsWith("refs/heads/"));
    const tags = view.where((ref) => ref.name.startsWith("refs/tags/"));

    const combined = branches.union(tags);
    expect(combined.refs.length).toBe(6);
  });

  test("union 去重", () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const same = view.union(view);
    // 不包含 HEAD 时，adv.refs 长度为 7（含 HEAD），allRefs 去重后应与原数量一致
    expect(same.refs.length).toBe(adv.refs.length);
  });

  test("name 创建命名视图", () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const named = view.name("branches");
    expect(named.label).toBe("branches");
    // 命名视图应保留所有 refs
    expect(named.refs.length).toBe(adv.refs.length);
  });

  test("视图冻结：refs 不可变", () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    expect(Object.isFrozen(view.refs)).toBe(true);
  });

  test("view 链式调用", () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const result = view
      .where((ref) => ref.name.startsWith("refs/heads/"))
      .exclude("refs/heads/feature/*")
      .name("core-branches");

    expect(result.label).toBe("core-branches");
    expect(result.refs.length).toBe(2);
    expect(result.refs.map((r) => r.name).sort()).toEqual([
      "refs/heads/develop",
      "refs/heads/main",
    ]);
  });
});

// ============================================================================
// Session 只读操作
// ============================================================================

describe("ImportSession", () => {
  const backend = createMemoryRepositoryBackend();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("select 按 glob 选择 refs", () => {
    const branches = session.select("refs/heads/*");
    expect(branches.refs.length).toBe(3);
    branches.refs.forEach((ref) => {
      expect(ref.name.startsWith("refs/heads/")).toBe(true);
    });
  });

  test("select 不匹配时返回空视图", () => {
    const result = session.select("refs/heads/nonexistent/*");
    expect(result.refs.length).toBe(0);
  });

  test("selectRefs 多模式选择", () => {
    const view = session.selectRefs(["refs/heads/main", "refs/tags/v1*"]);
    expect(view.refs.length).toBe(3);
    const names = view.refs.map((r) => r.name).sort();
    expect(names).toEqual(["refs/heads/main", "refs/tags/v1.0.0", "refs/tags/v1.1.0"]);
  });

  test("selectRefs 去重", () => {
    const view = session.selectRefs(["refs/heads/*", "refs/heads/main"]);
    const mainCount = view.refs.filter((r) => r.name === "refs/heads/main").length;
    expect(mainCount).toBe(1);
  });

  test("defaultBranch 返回默认分支视图", () => {
    const view = session.defaultBranch();
    expect(view.refs.length).toBe(1);
    expect(view.refs[0]?.name).toBe("refs/heads/main");
    expect(view.refs[0]?.hash).toBe(MOCK_HASH_A);
  });

  test("defaultBranch 无默认分支时返回空", () => {
    const noDefaultAdv: RefAdvertisement = {
      ...adv,
      defaultBranch: undefined,
    };
    const noDefaultSession = createImportSession(MOCK_SOURCE, backend, noDefaultAdv);
    const view = noDefaultSession.defaultBranch();
    expect(view.refs.length).toBe(0);
  });

  test("headTarget 返回 HEAD 指向的分支", () => {
    const view = session.headTarget();
    expect(view.refs.length).toBe(1);
    expect(view.refs[0]?.name).toBe("refs/heads/main");
  });

  test("headTarget 无 symrefTarget 时返回空", () => {
    const noSymrefAdv: RefAdvertisement = {
      ...adv,
      refs: [
        { hash: MOCK_HASH_A, name: "HEAD" },
        { hash: MOCK_HASH_A, name: "refs/heads/main" },
      ],
    };
    const noSymrefSession = createImportSession(MOCK_SOURCE, backend, noSymrefAdv);
    const view = noSymrefSession.headTarget();
    expect(view.refs.length).toBe(0);
  });

  test("allRefs 返回所有非 HEAD refs", () => {
    const view = session.allRefs();
    // mock 有 6 个非 HEAD refs
    expect(view.refs.length).toBe(6);
    expect(view.refs.some((r) => r.name === "HEAD")).toBe(false);
  });

  test("advertisement 冻结：可直接访问原始快照", () => {
    expect(session.advertisement).toEqual(adv);
  });

  test("source 冻结：保持传入的 source 配置", () => {
    expect(session.source).toEqual(MOCK_SOURCE);
    expect(session.source.url).toBe("https://example.com/repo.git");
  });
});

// ============================================================================
// ImportPlanBuilder 基础行为
// ============================================================================

describe("ImportPlanBuilder 基础行为", () => {
  const backend = createMemoryRepositoryBackend();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("plan() 返回 plan builder", () => {
    const plan = session.plan();
    expect(plan).toBeDefined();
    expect(typeof plan.preview).toBe("function");
    expect(typeof plan.apply).toBe("function");
    expect(typeof plan.materialize).toBe("function");
  });

  test("preview() 返回 canApply = true", () => {
    const plan = session.plan();
    const preview = plan.preview();
    expect(preview.canApply).toBe(true);
    expect(preview.remoteSnapshot).toEqual(adv);
  });

  test("apply() 返回空结果（无物化操作）", async () => {
    const plan = session.plan();
    const result = await plan.apply();
    expect(result.importedObjects).toBe(0);
    expect(result.updatedRefs.size).toBe(0);
  });

  test("materialize 链式调用后 preview 返回真实 ref 操作", () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan();

    plan.materialize(defaultBranch).toBranch("main");
    const preview = plan.preview();

    expect(preview.canApply).toBe(true);
    expect(preview.refOperations.length).toBeGreaterThan(0);
    expect(preview.selectedRefs.length).toBeGreaterThan(0);
    expect(preview.objectRoots.length).toBeGreaterThan(0);
    expect(preview.diagnostics.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 会话冻结语义
// ============================================================================

describe("会话冻结语义", () => {
  test("多次调用 select 返回相同快照", () => {
    const backend = createMemoryRepositoryBackend();
    const adv = createMockAdvertisement();
    const session = createImportSession(MOCK_SOURCE, backend, adv);

    // 即使 advertisement 被外部修改，session 已经持有快照
    adv.refs = [];
    adv.defaultBranch = undefined;

    const branches = session.select("refs/heads/*");
    expect(branches.refs.length).toBe(3);
    expect(session.advertisement.defaultBranch).toBe("refs/heads/main");
  });

  test("view 派生后原 advertisement 修改不影响已有 view", () => {
    const backend = createMemoryRepositoryBackend();
    const adv = createMockAdvertisement();
    const session = createImportSession(MOCK_SOURCE, backend, adv);

    const branches = session.select("refs/heads/*");
    expect(branches.refs.length).toBe(3);

    // 修改 advertisement 不影响已派生的 view
    adv.refs = [];
    expect(branches.refs.length).toBe(3);
  });

  test("advertisement 内部 ref 项也会被冻结复制", () => {
    const backend = createMemoryRepositoryBackend();
    const adv = createMockAdvertisement();
    const session = createImportSession(MOCK_SOURCE, backend, adv);

    adv.refs[1]!.name = "refs/heads/hijacked";
    adv.refs[0]!.symrefTarget = "refs/heads/hijacked";

    expect(session.defaultBranch().refs[0]?.name).toBe("refs/heads/main");
    expect(session.headTarget().refs[0]?.name).toBe("refs/heads/main");
    expect(session.advertisement.refs[1]?.name).toBe("refs/heads/main");
  });

  test("source 在会话内冻结为快照", () => {
    const backend = createMemoryRepositoryBackend();
    const source = {
      url: "https://example.com/original.git",
      headers: { Authorization: "Bearer token-a" },
    };
    const session = createImportSession(source, backend, createMockAdvertisement());

    source.url = "https://example.com/changed.git";
    source.headers.Authorization = "Bearer token-b";

    expect(session.source.url).toBe("https://example.com/original.git");
    expect(session.source.headers?.Authorization).toBe("Bearer token-a");
  });
});

// ============================================================================
// Phase 2：PlanBuilder Preview
// ============================================================================

describe("Phase 2 PlanBuilder — 命名空间物化", () => {
  const backend = createMemoryRepositoryBackend();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("toNamespace 将分支映射到镜像命名空间", () => {
    const branches = session.select("refs/heads/*");
    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", { policy: { mode: "mirror" }, prune: true });

    const preview = plan.preview();

    // 所有 3 个分支应映射到镜像命名空间
    expect(preview.selectedRefs.length).toBe(3);
    const localRefs = preview.selectedRefs.map((r) => r.localTarget).sort();
    expect(localRefs).toEqual([
      "refs/mirrors/upstream/develop",
      "refs/mirrors/upstream/feature/login",
      "refs/mirrors/upstream/main",
    ]);

    expect(preview.canApply).toBe(true);
  });

  test("toNamespace 精确目标（无通配符）重复映射", () => {
    const mainRef = session.selectRefs(["refs/heads/main"]);
    const plan = session.plan().materialize(mainRef).toNamespace("refs/heads/main-backup");

    const preview = plan.preview();
    expect(preview.selectedRefs.length).toBe(1);
    expect(preview.selectedRefs[0]?.localTarget).toBe("refs/heads/main-backup");
  });

  test("toNamespace 标签映射到 refs/tags/* 命名空间", () => {
    const tags = session.select("refs/tags/*");
    const plan = session.plan().materialize(tags).toNamespace("refs/tags/*");

    const preview = plan.preview();
    // 标签的公共前缀是 refs/tags/，所以 * 匹配 v1.0.0, v1.1.0, v2.0.0-beta
    expect(preview.selectedRefs.length).toBe(3);
    const localRefs = preview.selectedRefs.map((r) => r.localTarget).sort();
    expect(localRefs).toEqual(["refs/tags/v1.0.0", "refs/tags/v1.1.0", "refs/tags/v2.0.0-beta"]);
  });

  test("子路径分支保留嵌套路径", () => {
    // feature/login 的公共前缀是 refs/heads/
    // 映射到 refs/mirrors/upstream/* 应保留 feature/login
    const branches = session.select("refs/heads/*");
    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", { policy: { mode: "mirror" } });

    const preview = plan.preview();
    const loginTarget = preview.selectedRefs.find(
      (r) => r.remoteRef.name === "refs/heads/feature/login",
    );
    expect(loginTarget).toBeDefined();
    expect(loginTarget!.localTarget).toBe("refs/mirrors/upstream/feature/login");
  });
});

describe("Phase 2 PlanBuilder — 分支/tag/HEAD 物化", () => {
  const backend = createMemoryRepositoryBackend();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("toBranch 创建本地分支", () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).toBranch("main");

    const preview = plan.preview();
    expect(preview.selectedRefs.length).toBe(1);
    expect(preview.selectedRefs[0]?.localTarget).toBe("refs/heads/main");
    expect(preview.refOperations[0]?.localRef).toBe("refs/heads/main");
  });

  test("toBranch 带 refs/heads/ 前缀", () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).toBranch("refs/heads/custom-main");

    const preview = plan.preview();
    expect(preview.selectedRefs[0]?.localTarget).toBe("refs/heads/custom-main");
  });

  test("toTag 创建本地 tag", () => {
    const tags = session.select("refs/tags/v1*");
    const plan = session.plan().materialize(tags).toTag("v1-current");

    const preview = plan.preview();
    expect(preview.selectedRefs.length).toBe(0);
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes('toTag("v1-current") 需要单一 ref 视图'),
      ),
    ).toBe(true);
  });

  test("toTag 带 refs/tags/ 前缀", () => {
    const tagRef = session.selectRefs(["refs/tags/v1.0.0"]);
    const plan = session.plan().materialize(tagRef).toTag("refs/tags/stable-v1");

    const preview = plan.preview();
    expect(preview.selectedRefs[0]?.localTarget).toBe("refs/tags/stable-v1");
  });

  test("setHead 设置 HEAD 到最后物化的 ref", () => {
    const defaultBranch = session.defaultBranch();
    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();

    const preview = plan.preview();
    expect(preview.headOperation).toBeDefined();
    expect(preview.headOperation!.targetRef).toBe("refs/heads/main");
  });

  test("setHead 绑定当前 view 对应的前置物化结果，而不是全局最后一个映射", () => {
    const branches = session.select("refs/heads/*");
    const defaultBranch = session.defaultBranch();
    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
      })
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();

    const preview = plan.preview();
    expect(preview.headOperation?.targetRef).toBe("refs/heads/main");
  });

  test("setHead 无前置物化时发出警告", () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).setHead();

    const preview = plan.preview();
    // setHead 在物化操作中但没有前置 toBranch/toNamespace
    // headOperation 应为 undefined，同时发出警告
    expect(preview.headOperation).toBeUndefined();
    const warns = preview.diagnostics.filter((d) => d.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });

  test("setHead 指向镜像命名空间时报错", () => {
    const defaultBranch = session.defaultBranch();
    const preview = session
      .plan()
      .materialize(defaultBranch)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
      })
      .materialize(defaultBranch)
      .setHead()
      .preview();

    expect(preview.headOperation).toBeUndefined();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("setHead() 只能指向 refs/heads/*"),
      ),
    ).toBe(true);
  });

  test("setHead 指向 tag 时报错", () => {
    const tagRef = session.selectRefs(["refs/tags/v1.0.0"]);
    const preview = session
      .plan()
      .materialize(tagRef)
      .toTag("stable-v1")
      .materialize(tagRef)
      .setHead()
      .preview();

    expect(preview.headOperation).toBeUndefined();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("setHead() 只能指向 refs/heads/*"),
      ),
    ).toBe(true);
  });

  test("setHead({ detach: true }) 仍要求目标是 refs/heads/*", () => {
    const defaultBranch = session.defaultBranch();
    const preview = session
      .plan()
      .materialize(defaultBranch)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
      })
      .materialize(defaultBranch)
      .setHead({ detach: true })
      .preview();

    expect(preview.headOperation).toBeUndefined();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("setHead() 只能指向 refs/heads/*"),
      ),
    ).toBe(true);
  });

  test("toBranch 多 ref 视图直接报错", () => {
    const branches = session.select("refs/heads/*");
    const preview = session.plan().materialize(branches).toBranch("main").preview();

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes('toBranch("main") 需要单一 ref 视图'),
      ),
    ).toBe(true);
  });

  test("多个 materialize 链完整工作", () => {
    const branches = session.select("refs/heads/*");
    const releaseTags = session.selectRefs(["refs/tags/v1.0.0"]);
    const defaultBranch = session.defaultBranch();

    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
      })
      .materialize(releaseTags)
      .toNamespace("refs/tags/*", {
        policy: { mode: "create-only" },
      })
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();

    const preview = plan.preview();

    // 3 branches + 1 release tag + 1 branch + HEAD
    expect(preview.selectedRefs.length).toBe(5);
    expect(preview.headOperation).toBeDefined();
    expect(preview.headOperation!.targetRef).toBe("refs/heads/main");

    // 应包含本地前置条件
    expect(preview.localPreconditions.length).toBeGreaterThan(0);
  });
});

describe("Phase 2 PlanBuilder — 前置条件与诊断", () => {
  const backend = createMemoryRepositoryBackend();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("preview 包含正确的 localPreconditions", () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).toBranch("new-main");
    const preview = plan.preview();

    // 应有 refs/heads/new-main 的前置条件（不存在时为 null）
    const precondition = preview.localPreconditions.find(
      (p) => p.refName === "refs/heads/new-main",
    );
    expect(precondition).toBeDefined();
    // 本地不存在，expectedHash 应为 null
    expect(precondition!.expectedHash).toBeNull();
  });

  test("setHead 会把 HEAD 纳入前置条件快照", () => {
    backend.refs.write("HEAD", "ref: refs/heads/old-main");

    const defaultBranch = session.defaultBranch();
    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();
    const preview = plan.preview();

    const headPrecondition = preview.localPreconditions.find((p) => p.refName === "HEAD");
    expect(headPrecondition).toBeDefined();
    expect(headPrecondition?.expectedValue).toBe("ref: refs/heads/old-main");
  });

  test("create-only 策略检测已有 ref 冲突", () => {
    // 先在本地创建一个 tag
    backend.refs.write("refs/tags/v1.0.0", sha1("e".repeat(40)));

    const tagView = session.selectRefs(["refs/tags/v1.0.0"]);
    const plan = session
      .plan()
      .materialize(tagView)
      .toTag("v1.0.0", { policy: { mode: "create-only" } });

    const preview = plan.preview();

    // 应有 error 级别的诊断信息
    const errors = preview.diagnostics.filter((d) => d.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((d) => d.message.includes("create-only"))).toBe(true);

    // refOperations 中不应包含被拒绝的 ref
    // 因为有 error 诊断，canApply 应为 false
    expect(preview.canApply).toBe(false);
    const tagOps = preview.refOperations.filter((r) => r.localRef === "refs/tags/v1.0.0");
    expect(tagOps.length).toBe(0);
  });

  test("no-op 跳过（远程 hash 与本地相同）", () => {
    // 先写入一个与远端 hash 相同的 ref
    backend.refs.write("refs/heads/main", MOCK_HASH_A);

    const mainView = session.selectRefs(["refs/heads/main"]);
    const plan = session.plan().materialize(mainView).toBranch("main");
    const preview = plan.preview();

    // 应为 info 级别的 "已是最新" 诊断
    const skipMessages = preview.diagnostics.filter((d) => d.message.includes("已是最新"));
    expect(skipMessages.length).toBeGreaterThan(0);

    // refOperations 不应包含被跳过的 ref
    const mainOps = preview.refOperations.filter((r) => r.localRef === "refs/heads/main");
    expect(mainOps.length).toBe(0);
  });

  test("hash 相同但对象缺失时仍会规划对象导入", () => {
    backend.refs.write("refs/heads/main", MOCK_HASH_A);

    const mainView = session.selectRefs(["refs/heads/main"]);
    const plan = session.plan().materialize(mainView).toBranch("main");
    const preview = plan.preview();

    expect(preview.selectedRefs.length).toBe(1);
    expect(preview.objectRoots).toContain(MOCK_HASH_A);
    expect(preview.refOperations.length).toBe(0);
  });

  test("自定义命名空间未显式指定 policy 时拒绝 apply", () => {
    const branches = session.select("refs/heads/*");
    const plan = session.plan().materialize(branches).toNamespace("refs/mirrors/upstream/*");
    const preview = plan.preview();

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("需要显式指定 policy"),
      ),
    ).toBe(true);
  });

  test("命名视图标签会出现在诊断中", () => {
    const namedEmptyView = session.select("refs/heads/nonexistent/*").name("empty-branches");
    const preview = session.plan().materialize(namedEmptyView).toBranch("ghost").preview();

    expect(
      preview.diagnostics.some(
        (d) => d.level === "warn" && d.message.includes('命名视图 "empty-branches"'),
      ),
    ).toBe(true);
  });
});

describe("Phase 2 PlanBuilder — 边界与错误", () => {
  const backend = createMemoryRepositoryBackend();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("空 view 的 toBranch 发出警告但不崩溃", () => {
    const emptyView = session.select("refs/heads/nonexistent/*");
    const plan = session.plan().materialize(emptyView).toBranch("ghost");
    const preview = plan.preview();

    const warnings = preview.diagnostics.filter((d) => d.message.includes("view 为空"));
    expect(warnings.length).toBeGreaterThan(0);
    expect(preview.selectedRefs.length).toBe(0);
  });

  test("空 view 的 toTag 发出警告但不崩溃", () => {
    const emptyView = session.select("refs/tags/nonexistent/*");
    const plan = session.plan().materialize(emptyView).toTag("ghost");
    const preview = plan.preview();

    const warnings = preview.diagnostics.filter((d) => d.message.includes("view 为空"));
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("空 view 的 toNamespace 返回空映射", () => {
    const emptyView = session.select("refs/heads/nonexistent/*");
    const plan = session.plan().materialize(emptyView).toNamespace("refs/mirrors/*");
    const preview = plan.preview();

    expect(preview.selectedRefs.length).toBe(0);
  });

  test("精确目标不允许开启 prune", () => {
    const mainRef = session.selectRefs(["refs/heads/main"]);
    const preview = session
      .plan()
      .materialize(mainRef)
      .toNamespace("refs/mirrors/upstream/main", {
        policy: { mode: "mirror" },
        prune: true,
      })
      .preview();

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("prune 只允许用于带 * 的命名空间投影"),
      ),
    ).toBe(true);
  });

  test("多个动作写入同一目标 ref 时拒绝 apply", () => {
    const mainRef = session.selectRefs(["refs/heads/main"]);
    const developRef = session.selectRefs(["refs/heads/develop"]);

    const preview = session
      .plan()
      .materialize(mainRef)
      .toBranch("shared")
      .materialize(developRef)
      .toBranch("shared")
      .preview();

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) =>
          d.level === "error" &&
          d.message.includes('本地 ref "refs/heads/shared" 被多个物化动作同时写入'),
      ),
    ).toBe(true);
  });

  test("apply() 空 plan 返回空结果", async () => {
    const plan = session.plan();
    const result = await plan.apply();
    expect(result.importedObjects).toBe(0);
    expect(result.updatedRefs.size).toBe(0);
  });

  test("preview 保留 remoteSnapshot 快照", () => {
    const plan = session.plan();
    const preview = plan.preview();

    expect(preview.remoteSnapshot.defaultBranch).toBe("refs/heads/main");
    expect(preview.remoteSnapshot.refs.length).toBe(7);
  });

  test("preview 结果会被冻结", () => {
    const preview = session.plan().materialize(session.defaultBranch()).toBranch("main").preview();

    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.selectedRefs)).toBe(true);
    expect(Object.isFrozen(preview.localPreconditions)).toBe(true);
    expect(Object.isFrozen(preview.refOperations)).toBe(true);
    expect(Object.isFrozen(preview.diagnostics)).toBe(true);
  });
});

// ============================================================================
// Phase 3：Apply 执行器
// ============================================================================

/**
 * 构建与 commit hash 匹配的 mock advertisement
 */
function createAdvForCommit(
  commitHash: string,
  refs?: Array<{ name: string; hash: string }>,
): RefAdvertisement {
  const advRefs: RemoteRef[] = [
    { hash: sha1("a".repeat(40)), name: "HEAD", symrefTarget: "refs/heads/main" },
    { hash: sha1(commitHash), name: "refs/heads/main" },
    { hash: sha1(commitHash), name: "refs/heads/develop" },
    ...(refs ?? []).map((r) => ({ hash: sha1(r.hash), name: r.name })),
  ];
  return {
    capabilities: {},
    refs: advRefs,
    defaultBranch: "refs/heads/main",
  };
}

describe("Phase 3 — apply 写 ref", () => {
  function createRepoWithObjects() {
    const backend = createMemoryRepositoryBackend();
    const { objects } = backend;

    // 创建空 tree
    const treeHash = objects.write({
      type: "tree",
      entries: [],
    });

    // 创建 commit
    const commitHash = objects.write({
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "test commit\n",
    });

    // 创建第二个 commit（用于分支推进）
    const commitHash2 = objects.write({
      type: "commit",
      tree: treeHash,
      parents: [commitHash],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "second commit\n",
    });

    // 创建 blob（用于非 commit 命名空间）
    const blobContent = Buffer.from("hello world");
    const blobHash = objects.write({
      type: "blob",
      content: blobContent,
    });

    return { backend, treeHash, commitHash, commitHash2, blobHash };
  }

  test("preview 阶段直接拒绝非 fast-forward 更新", () => {
    const { backend, commitHash, commitHash2 } = createRepoWithObjects();
    backend.refs.write("refs/heads/main", commitHash2);

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const preview = session.plan().materialize(session.defaultBranch()).toBranch("main").preview();

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes('ref "refs/heads/main" 无法 fast-forward'),
      ),
    ).toBe(true);
  });

  test("preview 阶段直接拒绝把非 commit 对象物化到 refs/heads/*", () => {
    const { backend, blobHash } = createRepoWithObjects();
    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: blobHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: blobHash, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const preview = session.plan().materialize(session.defaultBranch()).toBranch("main").preview();

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) =>
          d.level === "error" &&
          d.message.includes("refs/heads/* can only point to commit objects"),
      ),
    ).toBe(true);
  });

  test("toBranch 创建本地分支", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).toBranch("main");

    const result = await plan.apply();

    expect(result.importedObjects).toBe(0); // 本地已有对象
    expect(result.updatedRefs.get("refs/heads/main")).toBe(sha1(commitHash));
    expect(backend.refs.read("refs/heads/main")).toBe(commitHash);
  });

  test("toBranch + setHead 设置 HEAD", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();

    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();

    const result = await plan.apply();

    expect(result.updatedRefs.has("refs/heads/main")).toBe(true);
    expect(result.headTarget).toBe("refs/heads/main");
    expect(backend.refs.read("HEAD")).toBe("ref: refs/heads/main");
  });

  test("mirror 策略允许 refs/heads/* 执行非 fast-forward 更新", async () => {
    const { backend, commitHash, commitHash2 } = createRepoWithObjects();
    const treeHash = backend.objects.write({
      type: "tree",
      entries: [],
    });
    const divergedCommit = backend.objects.write({
      type: "commit",
      tree: treeHash,
      parents: [commitHash],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "diverged commit\n",
    });

    backend.refs.write("refs/heads/main", divergedCommit);

    const adv = createAdvForCommit(commitHash2);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();

    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main", { policy: { mode: "mirror" } });

    const preview = plan.preview();
    expect(preview.canApply).toBe(true);
    expect(
      preview.diagnostics.some((d) => d.level === "info" && d.message.includes("mirror 策略覆盖")),
    ).toBe(true);

    const result = await plan.apply();

    expect(result.updatedRefs.get("refs/heads/main")).toBe(commitHash2);
    expect(backend.refs.read("refs/heads/main")).toBe(commitHash2);
  });

  test("setHead({ detach: true }) 写入 detached HEAD", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();

    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead({ detach: true });

    const preview = plan.preview();
    expect(preview.headOperation?.detach).toBe(true);

    const result = await plan.apply();

    expect(result.headTarget).toBe("refs/heads/main");
    expect(backend.refs.read("HEAD")).toBe(commitHash);
  });

  test("toNamespace 创建镜像 refs", async () => {
    const { backend, commitHash, commitHash2 } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash, [
      { name: "refs/heads/feature/login", hash: commitHash2 },
    ]);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const branches = session.select("refs/heads/*");

    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
      });

    const result = await plan.apply();

    // main 和 develop 应镜像到 upstream
    expect(result.updatedRefs.has("refs/mirrors/upstream/main")).toBe(true);
    expect(result.updatedRefs.has("refs/mirrors/upstream/develop")).toBe(true);
    expect(result.updatedRefs.has("refs/mirrors/upstream/feature/login")).toBe(true);

    // 原始命名空间不应被修改（镜像操作不写原始命名空间）
    expect(backend.refs.read("refs/heads/main")).toBeNull();
  });

  test("toTag 创建本地 tag", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash, [{ name: "refs/tags/v1.0.0", hash: commitHash }]);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const tags = session.select("refs/tags/*");

    const plan = session
      .plan()
      .materialize(tags)
      .toTag("v1.0.0", { policy: { mode: "create-only" } });

    const result = await plan.apply();

    expect(result.updatedRefs.has("refs/tags/v1.0.0")).toBe(true);
    expect(backend.refs.read("refs/tags/v1.0.0")).toBe(commitHash);
  });

  test("prune 删除陈旧 ref", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    // 在本地手动写入一个陈旧 ref，模拟之前的镜像遗留
    backend.refs.write("refs/mirrors/upstream/stale-branch", commitHash);

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const branches = session.select("refs/heads/*");

    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
        prune: true,
      });

    const result = await plan.apply();

    // stale-branch 应在 prunedRefs 中
    expect(result.deletedRefs).toContain("refs/mirrors/upstream/stale-branch");
    // 验证对应的 ref 已被删除
    expect(backend.refs.read("refs/mirrors/upstream/stale-branch")).toBeNull();
  });

  test("非尾部通配 prune 只清理匹配目标模式的 refs", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    backend.refs.write("refs/mirrors/main-backup", commitHash);
    backend.refs.write("refs/mirrors/legacy-backup", commitHash);
    backend.refs.write("refs/mirrors/keep", commitHash);

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const mainView = session.selectRefs(["refs/heads/main"]);

    const result = await session
      .plan()
      .materialize(mainView)
      .toNamespace("refs/mirrors/*-backup", {
        policy: { mode: "mirror" },
        prune: true,
      })
      .apply();

    expect(result.deletedRefs).toEqual(["refs/mirrors/legacy-backup"]);
    expect(backend.refs.read("refs/mirrors/main-backup")).toBe(commitHash);
    expect(backend.refs.read("refs/mirrors/keep")).toBe(commitHash);
  });

  test("同一命名空间的多个 prune 物化会合并 ownership", async () => {
    const { backend, commitHash, commitHash2 } = createRepoWithObjects();
    backend.refs.write("refs/mirrors/upstream/main", commitHash);
    backend.refs.write("refs/mirrors/upstream/develop", commitHash2);
    backend.refs.write("refs/mirrors/upstream/legacy", commitHash);

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: commitHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: commitHash, name: "refs/heads/main" },
        { hash: commitHash2, name: "refs/heads/develop" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const mainView = session.selectRefs(["refs/heads/main"]);
    const developView = session.selectRefs(["refs/heads/develop"]);

    const result = await session
      .plan()
      .materialize(mainView)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
        prune: true,
      })
      .materialize(developView)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
        prune: true,
      })
      .apply();

    expect(result.deletedRefs).toEqual(["refs/mirrors/upstream/legacy"]);
    expect(backend.refs.read("refs/mirrors/upstream/main")).toBe(commitHash);
    expect(backend.refs.read("refs/mirrors/upstream/develop")).toBe(commitHash2);
  });

  test("空 authority view + prune 会清理整个命名空间", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    backend.refs.write("refs/mirrors/upstream/legacy", commitHash);
    backend.refs.write("refs/mirrors/upstream/old", commitHash);

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const emptyView = session.select("refs/heads/nonexistent/*");

    const result = await session
      .plan()
      .materialize(emptyView)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
        prune: true,
      })
      .apply();

    expect([...result.deletedRefs].sort()).toEqual([
      "refs/mirrors/upstream/legacy",
      "refs/mirrors/upstream/old",
    ]);
    expect(backend.refs.read("refs/mirrors/upstream/legacy")).toBeNull();
    expect(backend.refs.read("refs/mirrors/upstream/old")).toBeNull();
  });
});

describe("Phase 3 — apply 错误处理", () => {
  function createRepoWithObjects() {
    const backend = createMemoryRepositoryBackend();
    const { objects } = backend;
    const treeHash = objects.write({
      type: "tree",
      entries: [],
    });
    const commitHash = objects.write({
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "test commit\n",
    });
    return { backend, commitHash };
  }

  test("前置条件失败时抛错误", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();

    const plan = session.plan().materialize(defaultBranch).toBranch("main");

    // preview 后，外部修改了本地 ref
    const preview = plan.preview();
    expect(preview.canApply).toBe(true);
    expect(preview.localPreconditions.length).toBeGreaterThan(0);

    // 在 apply 前手动写 ref，破坏前置条件
    // 注意：前置条件是针对目标 ref 的，这里写一个不同 hash 的 ref 来触发
    // 但由于目标 ref 不存在，precondition 是 null，写一个不同值的 ref 会触发
    backend.refs.write("refs/heads/main", sha1("f".repeat(40)));

    // apply 应因前置条件变化而失败
    expect(plan.apply()).rejects.toThrow(/前置条件/);
  });

  test("HEAD 在 preview 后漂移时 apply 失败", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    backend.refs.write("HEAD", "ref: refs/heads/previous");

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();

    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();

    const preview = plan.preview();
    expect(preview.localPreconditions.some((p) => p.refName === "HEAD")).toBe(true);

    backend.refs.write("HEAD", "ref: refs/heads/changed");

    expect(plan.apply()).rejects.toThrow(/前置条件/);
  });

  test("prune 命名空间在 preview 后新增 ref 时 apply 失败", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    backend.refs.write("refs/mirrors/upstream/main", commitHash);

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const branches = session.selectRefs(["refs/heads/main"]);

    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
        prune: true,
      });

    const preview = plan.preview();
    expect(
      preview.localPreconditions.some((p) => p.namespacePrefix === "refs/mirrors/upstream/"),
    ).toBe(true);

    backend.refs.write("refs/mirrors/upstream/rogue", sha1("e".repeat(40)));

    expect(plan.apply()).rejects.toThrow(
      /命名空间 "refs\/mirrors\/upstream\/\*" 在 preview\(\) 后已变化/,
    );
  });

  test("preview 后追加动作时 apply 使用最新计划", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();

    const plan = session.plan();
    const firstPreview = plan.preview();
    expect(firstPreview.refOperations.length).toBe(0);

    plan.materialize(defaultBranch).toBranch("main");
    const result = await plan.apply();

    expect(result.updatedRefs.get("refs/heads/main")).toBe(commitHash);
    expect(backend.refs.read("refs/heads/main")).toBe(commitHash);
  });

  test("create-only 策略拒绝已有 ref", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();

    // 先写一个同名同 hash 的 ref，导致 no-op（不会触发拒绝）
    // 写一个不同 hash 的 ref，create-only 才会拒绝
    backend.refs.write("refs/heads/main", sha1("d".repeat(40)));

    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main", { policy: { mode: "create-only" } });

    expect(plan.apply()).rejects.toThrow(/错误.*无法执行/);
    expect(backend.refs.read("refs/heads/main")).toBe(sha1("d".repeat(40)));
    // 原始 hash 保持不变
    expect(backend.refs.read("refs/heads/main")).toBe(sha1("d".repeat(40)));
  });

  test("create-only 策略会把符号引用视为已存在 ref", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    backend.refs.write("refs/heads/current", commitHash);
    backend.refs.write("refs/heads/main", "ref: refs/heads/current");

    const nextCommit = backend.objects.write({
      type: "commit",
      tree: backend.objects.write({
        type: "tree",
        entries: [],
      }),
      parents: [commitHash],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "next commit\n",
    });

    const adv = createAdvForCommit(nextCommit);
    const session = createImportSession(MOCK_SOURCE, backend, adv);

    const plan = session
      .plan()
      .materialize(session.defaultBranch())
      .toBranch("main", { policy: { mode: "create-only" } });

    const preview = plan.preview();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === "error" && diagnostic.message.includes("create-only 策略拒绝更新"),
      ),
    ).toBe(true);
    expect(plan.apply()).rejects.toThrow(/create-only/);
  });

  test("对象缺失时 apply 失败（经 transport 拉取仍失败）", async () => {
    const { backend } = createRepoWithObjects();
    // 注意：这里 commitHash 对应的对象已存在于 backend 中
    // 我们创建一个引用了一个不存在的 hash 的 advertisement
    const missingHash = sha1("c".repeat(40));
    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: missingHash, name: "HEAD" },
        { hash: missingHash, name: "refs/heads/missing" },
      ],
      defaultBranch: undefined,
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const missingView = session.selectRefs(["refs/heads/missing"]);

    const plan = session.plan().materialize(missingView).toBranch("missing-tip");

    // preview 应检测到可以 apply（有 ref 操作）
    const preview = plan.preview();
    expect(preview.canApply).toBe(true);
    expect(preview.selectedRefs.length).toBeGreaterThan(0);

    // apply 应尝试拉取（使用真实 transport 连接，会失败）
    // 但这里不会连接真实服务，因为我们没有给 apply 传入 transport
    // 它会尝试创建默认的 http transport，连接失败
    expect(plan.apply()).rejects.toThrow();
  });

  test("hash 相同但对象缺失时 apply 仍会尝试导入对象", async () => {
    const backend = createMemoryRepositoryBackend();
    backend.refs.write("refs/heads/main", MOCK_HASH_A);

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: MOCK_HASH_A, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: MOCK_HASH_A, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };

    const session = createImportSession(MOCK_SOURCE, backend, adv, () => ({
      advertise: async () => adv,
      request: async () => {
        throw new Error("transport requested");
      },
    }));

    const plan = session.plan().materialize(session.defaultBranch()).toBranch("main");
    const preview = plan.preview();

    expect(preview.refOperations.length).toBe(0);
    expect(preview.objectRoots).toContain(MOCK_HASH_A);
    expect(plan.apply()).rejects.toThrow(/transport requested/);
  });

  test("fetch-pack 期间本地 ref 漂移时 apply 在写入前失败", async () => {
    const backend = createMemoryRepositoryBackend();
    const sourceRepo = createMemoryRepositoryBackend();
    const tree = {
      type: "tree" as const,
      entries: [],
    };
    const treeHash = sourceRepo.objects.write(tree);
    const commit = {
      type: "commit" as const,
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "remote commit\n",
    };
    const commitHash = sourceRepo.objects.write(commit);

    const writer = createPackWriter();
    writer.addObject(tree);
    writer.addObject(commit);
    const rawResponse = Buffer.concat([encodePktLine("NAK\n"), writer.build()]);

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv, () => ({
      advertise: async () => adv,
      request: async () => {
        backend.refs.write("refs/heads/main", sha1("f".repeat(40)));
        return rawResponse;
      },
    }));

    const plan = session.plan().materialize(session.defaultBranch()).toBranch("main");
    const preview = plan.preview();
    expect(preview.objectRoots).toContain(sha1(commitHash));

    expect(plan.apply()).rejects.toThrow(/前置条件/);
    expect(backend.refs.read("refs/heads/main")).toBe(sha1("f".repeat(40)));
  });

  test("目标符号引用在 preview 后漂移时 apply 失败", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    backend.refs.write("refs/heads/current", commitHash);
    backend.refs.write("refs/heads/main", "ref: refs/heads/current");

    const nextCommit = backend.objects.write({
      type: "commit",
      tree: backend.objects.write({
        type: "tree",
        entries: [],
      }),
      parents: [commitHash],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "next commit\n",
    });

    const adv = createAdvForCommit(nextCommit);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const plan = session
      .plan()
      .materialize(session.defaultBranch())
      .toBranch("main", { policy: { mode: "mirror" } });

    const preview = plan.preview();
    expect(preview.localPreconditions.some((p) => p.refName === "refs/heads/main")).toBe(true);

    backend.refs.write("refs/heads/main", "ref: refs/heads/other");

    expect(plan.apply()).rejects.toThrow(/前置条件/);
  });
});

describe("openImportSession 选项透传", () => {
  test("options.token 会并入 session source 快照", async () => {
    const backend = createMemoryRepositoryBackend();
    const repo = createRepoImportOperations(backend);
    const advertised = createMockAdvertisement();

    const session = await repo.openImportSession(
      { url: "https://example.com/private.git" },
      {
        token: "secret-token",
        transportFactory: () => ({
          advertise: async () => advertised,
          request: async () => Buffer.alloc(0),
        }),
      },
    );

    expect(session.source.token).toBe("secret-token");
  });
});
