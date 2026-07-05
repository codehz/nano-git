/**
 * Import Session 单元测试
 *
 * 不依赖 HTTP 传输，直接构造 mock advertisement。
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/memory.ts";
import { writeObject } from "@/objects/raw.ts";
import { encodeObject } from "@/objects/raw.ts";
import { createPackWriter } from "@/pack/writer/pack-writer.ts";
import { formatGitCliShallowSince } from "@/repository/import/git-cli-shallow-since.ts";
import { matchRefGlob } from "@/repository/import/import-glob.ts";
import {
  createImportSession,
  createRepoImportOperations,
} from "@/repository/import/import-session.ts";
import { createImportView } from "@/repository/import/import-view.ts";
import {
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
} from "@/transport/protocol/pkt-line.ts";
import { sha1 } from "@/types/index.ts";

import type {
  ImportPlanDraft,
  ImportPrepareOptions,
} from "@/repository/import/import-session-types.ts";
import type { V2GitServiceTransport } from "@/transport/client/upload-pack/types.ts";
import type { RemoteRef, RefAdvertisement } from "@/transport/protocol/types.ts";

// ============================================================================
// Mock 数据
// ============================================================================

function populateMockObjects(backend: ReturnType<typeof createMemoryRepositoryBackend>) {
  const treeHash = writeObject(backend.objects, {
    type: "tree",
    entries: [],
  });

  const createCommit = (parents: readonly string[], message: string) =>
    writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: parents.map((parent) => sha1(parent)),
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message,
    });

  const mainHash = createCommit([], "main\n");
  const developHash = createCommit([mainHash], "develop\n");
  const releaseHash = createCommit([developHash], "release-v1\n");
  const betaHash = createCommit([releaseHash], "release-v2-beta\n");

  return {
    mainHash,
    developHash,
    releaseHash,
    betaHash,
  };
}

function createBackendWithMockObjects() {
  const backend = createMemoryRepositoryBackend();
  populateMockObjects(backend);
  return backend;
}

const mockFixtureBackend = createMemoryRepositoryBackend();
const mockHashes = populateMockObjects(mockFixtureBackend);

const MOCK_HASH_A = mockHashes.mainHash;
const MOCK_HASH_B = mockHashes.developHash;
const MOCK_HASH_C = mockHashes.releaseHash;
const MOCK_HASH_D = mockHashes.betaHash;

describe("formatGitCliShallowSince()", () => {
  test("普通 Unix 时间戳保持原样", () => {
    expect(
      formatGitCliShallowSince(4_102_444_799, {
        epochSeconds: 1_783_256_314,
        year: 2026,
        month: 6,
        day: 5,
        hours: 20,
        minutes: 58,
        seconds: 34,
      }),
    ).toBe("4102444799");
  });

  test("极端 future 时间戳会复刻 git CLI 的 approxidate 退化行为", () => {
    const now = {
      epochSeconds: 1_783_256_314,
      year: 2026,
      month: 6,
      day: 5,
      hours: 20,
      minutes: 58,
      seconds: 34,
    } as const;

    expect(formatGitCliShallowSince(4_102_444_800, now)).toBe("18446744071662610042");
    expect(formatGitCliShallowSince(4_102_444_801, now)).toBe("18446744071662696442");
    expect(formatGitCliShallowSince(4_102_448_400, now)).toBe("18446744071973650042");
    expect(formatGitCliShallowSince(4_102_531_200, now)).toBe("1123051130");
    expect(formatGitCliShallowSince(4_294_967_295, now)).toBe("1783256314");
    expect(formatGitCliShallowSince(4_294_967_296, now)).toBe("1783256314");
  });
});

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

async function prepareDraft(draft: ImportPlanDraft, options?: ImportPrepareOptions) {
  return draft.build().prepare(options);
}

async function previewDraft(draft: ImportPlanDraft, options?: ImportPrepareOptions) {
  const plan = draft.build();
  const prepared = await plan.prepare(options);
  return Object.freeze({
    ...prepared.preview,
    selectedRefs: plan.inspect().selectedRefs,
  });
}

async function applyDraft(draft: ImportPlanDraft, options?: ImportPrepareOptions) {
  return (await prepareDraft(draft, options)).apply();
}

function inspectDraft(draft: ImportPlanDraft) {
  return draft.build().inspect();
}

// ============================================================================
// Glob 模式匹配
// ============================================================================

describe("glob 模式匹配", () => {
  test("精确匹配", async () => {
    expect(matchRefGlob("refs/heads/main", "refs/heads/main")).toBe(true);
  });

  test("通配符匹配分支", async () => {
    expect(matchRefGlob("refs/heads/*", "refs/heads/main")).toBe(true);
    expect(matchRefGlob("refs/heads/*", "refs/heads/develop")).toBe(true);
    expect(matchRefGlob("refs/heads/*", "refs/tags/v1.0")).toBe(false);
  });

  test("通配符匹配 tag 前缀", async () => {
    expect(matchRefGlob("refs/tags/v*", "refs/tags/v1.0.0")).toBe(true);
    expect(matchRefGlob("refs/tags/v*", "refs/tags/v2.0.0-beta")).toBe(true);
    expect(matchRefGlob("refs/tags/v*", "refs/heads/main")).toBe(false);
  });

  test("不匹配不相关模式", async () => {
    expect(matchRefGlob("refs/heads/main", "refs/heads/develop")).toBe(false);
    expect(matchRefGlob("refs/heads/*", "refs/tags/v1.0")).toBe(false);
  });

  test("通配符匹配子路径", async () => {
    expect(matchRefGlob("refs/heads/*", "refs/heads/feature/login")).toBe(true);
  });
});

// ============================================================================
// View 操作
// ============================================================================

describe("ImportView", () => {
  const adv = createMockAdvertisement();

  test("where 过滤保留匹配项", async () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const branches = view.where((ref) => ref.name.startsWith("refs/heads/"));
    expect(branches.refs.length).toBe(3);
    expect(branches.refs.map((r) => r.name).sort()).toEqual([
      "refs/heads/develop",
      "refs/heads/feature/login",
      "refs/heads/main",
    ]);
  });

  test("where 空条件返回空视图", async () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const empty = view.where(() => false);
    expect(empty.refs.length).toBe(0);
  });

  test("exclude 排除匹配模式", async () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const withoutBeta = view.exclude("refs/tags/*beta*");
    expect(withoutBeta.refs.some((r) => r.name === "refs/tags/v2.0.0-beta")).toBe(false);
    expect(withoutBeta.refs.some((r) => r.name === "refs/tags/v1.0.0")).toBe(true);
  });

  test("union 合并两个视图", async () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const branches = view.where((ref) => ref.name.startsWith("refs/heads/"));
    const tags = view.where((ref) => ref.name.startsWith("refs/tags/"));

    const combined = branches.union(tags);
    expect(combined.refs.length).toBe(6);
  });

  test("union 去重", async () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const same = view.union(view);
    // 不包含 HEAD 时，adv.refs 长度为 7（含 HEAD），allRefs 去重后应与原数量一致
    expect(same.refs.length).toBe(adv.refs.length);
  });

  test("name 创建命名视图", async () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    const named = view.name("branches");
    expect(named.label).toBe("branches");
    // 命名视图应保留所有 refs
    expect(named.refs.length).toBe(adv.refs.length);
  });

  test("视图冻结：refs 不可变", async () => {
    const view = createImportView(adv.refs) as ReturnType<typeof createImportView>;
    expect(Object.isFrozen(view.refs)).toBe(true);
  });

  test("view 链式调用", async () => {
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

  test("select 按 glob 选择 refs", async () => {
    const branches = session.select("refs/heads/*");
    expect(branches.refs.length).toBe(3);
    branches.refs.forEach((ref) => {
      expect(ref.name.startsWith("refs/heads/")).toBe(true);
    });
  });

  test("select 不匹配时返回空视图", async () => {
    const result = session.select("refs/heads/nonexistent/*");
    expect(result.refs.length).toBe(0);
  });

  test("selectRefs 多模式选择", async () => {
    const view = session.selectRefs(["refs/heads/main", "refs/tags/v1*"]);
    expect(view.refs.length).toBe(3);
    const names = view.refs.map((r) => r.name).sort();
    expect(names).toEqual(["refs/heads/main", "refs/tags/v1.0.0", "refs/tags/v1.1.0"]);
  });

  test("selectRefs 去重", async () => {
    const view = session.selectRefs(["refs/heads/*", "refs/heads/main"]);
    const mainCount = view.refs.filter((r) => r.name === "refs/heads/main").length;
    expect(mainCount).toBe(1);
  });

  test("defaultBranch 返回默认分支视图", async () => {
    const view = session.defaultBranch();
    expect(view.refs.length).toBe(1);
    expect(view.refs[0]?.name).toBe("refs/heads/main");
    expect(view.refs[0]?.hash).toBe(MOCK_HASH_A);
  });

  test("defaultBranch 无默认分支时返回空", async () => {
    const noDefaultAdv: RefAdvertisement = {
      ...adv,
      defaultBranch: undefined,
    };
    const noDefaultSession = createImportSession(MOCK_SOURCE, backend, noDefaultAdv);
    const view = noDefaultSession.defaultBranch();
    expect(view.refs.length).toBe(0);
  });

  test("headTarget 返回 HEAD 指向的分支", async () => {
    const view = session.headTarget();
    expect(view.refs.length).toBe(1);
    expect(view.refs[0]?.name).toBe("refs/heads/main");
  });

  test("headTarget 无 symrefTarget 时返回空", async () => {
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

  test("allRefs 返回所有非 HEAD refs", async () => {
    const view = session.allRefs();
    // mock 有 6 个非 HEAD refs
    expect(view.refs.length).toBe(6);
    expect(view.refs.some((r) => r.name === "HEAD")).toBe(false);
  });

  test("advertisement 冻结：可直接访问原始快照", async () => {
    expect(session.advertisement).toEqual(adv);
  });

  test("source 冻结：保持传入的 source 配置", async () => {
    expect(session.source).toEqual(MOCK_SOURCE);
    expect(session.source.url).toBe("https://example.com/repo.git");
  });
});

// ============================================================================
// ImportPlanDraft 基础行为
// ============================================================================

describe("ImportPlanDraft 基础行为", () => {
  const backend = createBackendWithMockObjects();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("plan() 返回 draft", async () => {
    const plan = session.plan();
    expect(plan).toBeDefined();
    expect(typeof plan.materialize).toBe("function");
    expect(typeof plan.build).toBe("function");
  });

  test("空计划可 inspect 且可 prepare", async () => {
    const plan = session.plan();
    const inspection = inspectDraft(plan);
    expect(inspection.canPrepare).toBe(true);
    expect(inspection.selectedRefs).toEqual([]);

    const preview = await previewDraft(plan);
    expect(preview.canApply).toBe(true);
    expect(preview.remoteSnapshot).toEqual(adv);
  });

  test("空计划 apply() 返回空结果", async () => {
    const plan = session.plan();
    const result = await applyDraft(plan);
    expect(result.importedObjects).toBe(0);
    expect(result.updatedRefs.size).toBe(0);
  });

  test("materialize 链式调用后 inspect/prepare 返回真实计划", async () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan();

    plan.materialize(defaultBranch).toBranch("main");
    const inspection = inspectDraft(plan);
    expect(inspection.selectedRefs.length).toBeGreaterThan(0);
    expect(inspection.canPrepare).toBe(true);

    const preview = await previewDraft(plan);

    expect(preview.canApply).toBe(true);
    expect(preview.refOperations.length).toBeGreaterThan(0);
    expect(preview.objectRoots.length).toBe(0);
    expect(preview.prefetchedObjects).toBe(0);
    expect(preview.diagnostics.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 会话冻结语义
// ============================================================================

describe("会话冻结语义", () => {
  test("多次调用 select 返回相同快照", async () => {
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

  test("view 派生后原 advertisement 修改不影响已有 view", async () => {
    const backend = createMemoryRepositoryBackend();
    const adv = createMockAdvertisement();
    const session = createImportSession(MOCK_SOURCE, backend, adv);

    const branches = session.select("refs/heads/*");
    expect(branches.refs.length).toBe(3);

    // 修改 advertisement 不影响已派生的 view
    adv.refs = [];
    expect(branches.refs.length).toBe(3);
  });

  test("advertisement 内部 ref 项也会被冻结复制", async () => {
    const backend = createMemoryRepositoryBackend();
    const adv = createMockAdvertisement();
    const session = createImportSession(MOCK_SOURCE, backend, adv);

    adv.refs[1]!.name = "refs/heads/hijacked";
    adv.refs[0]!.symrefTarget = "refs/heads/hijacked";

    expect(session.defaultBranch().refs[0]?.name).toBe("refs/heads/main");
    expect(session.headTarget().refs[0]?.name).toBe("refs/heads/main");
    expect(session.advertisement.refs[1]?.name).toBe("refs/heads/main");
  });

  test("source 在会话内冻结为快照", async () => {
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
// ImportPlanDraft / ImportPlan / PreparedImportPlan
// ============================================================================

describe("ImportPlanDraft — 命名空间物化", () => {
  const backend = createBackendWithMockObjects();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("toNamespace 将分支映射到镜像命名空间", async () => {
    const branches = session.select("refs/heads/*");
    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", { policy: { mode: "mirror" }, prune: true });

    const preview = await previewDraft(plan);

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

  test("toNamespace 精确目标（无通配符）重复映射", async () => {
    const mainRef = session.selectRefs(["refs/heads/main"]);
    const plan = session.plan().materialize(mainRef).toNamespace("refs/heads/main-backup");

    const preview = await previewDraft(plan);
    expect(preview.selectedRefs.length).toBe(1);
    expect(preview.selectedRefs[0]?.localTarget).toBe("refs/heads/main-backup");
  });

  test("toNamespace 标签映射到 refs/tags/* 命名空间", async () => {
    const tags = session.select("refs/tags/*");
    const plan = session.plan().materialize(tags).toNamespace("refs/tags/*");

    const preview = await previewDraft(plan);
    // 标签的公共前缀是 refs/tags/，所以 * 匹配 v1.0.0, v1.1.0, v2.0.0-beta
    expect(preview.selectedRefs.length).toBe(3);
    const localRefs = preview.selectedRefs.map((r) => r.localTarget).sort();
    expect(localRefs).toEqual(["refs/tags/v1.0.0", "refs/tags/v1.1.0", "refs/tags/v2.0.0-beta"]);
  });

  test("子路径分支保留嵌套路径", async () => {
    // feature/login 的公共前缀是 refs/heads/
    // 映射到 refs/mirrors/upstream/* 应保留 feature/login
    const branches = session.select("refs/heads/*");
    const plan = session
      .plan()
      .materialize(branches)
      .toNamespace("refs/mirrors/upstream/*", { policy: { mode: "mirror" } });

    const preview = await previewDraft(plan);
    const loginTarget = preview.selectedRefs.find(
      (r) => r.remoteRef.name === "refs/heads/feature/login",
    );
    expect(loginTarget).toBeDefined();
    expect(loginTarget!.localTarget).toBe("refs/mirrors/upstream/feature/login");
  });
});

describe("ImportPlanDraft — 分支/tag/HEAD 物化", () => {
  const backend = createBackendWithMockObjects();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("toBranch 创建本地分支", async () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).toBranch("main");

    const preview = await previewDraft(plan);
    expect(preview.selectedRefs.length).toBe(1);
    expect(preview.selectedRefs[0]?.localTarget).toBe("refs/heads/main");
    expect(preview.refOperations[0]?.localRef).toBe("refs/heads/main");
  });

  test("toBranch 带 refs/heads/ 前缀", async () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).toBranch("refs/heads/custom-main");

    const preview = await previewDraft(plan);
    expect(preview.selectedRefs[0]?.localTarget).toBe("refs/heads/custom-main");
  });

  test("toTag 创建本地 tag", async () => {
    const tags = session.select("refs/tags/v1*");
    const plan = session.plan().materialize(tags).toTag("v1-current");

    const preview = await previewDraft(plan);
    expect(preview.selectedRefs.length).toBe(0);
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes('toTag("v1-current") 需要单一 ref 视图'),
      ),
    ).toBe(true);
  });

  test("toTag 带 refs/tags/ 前缀", async () => {
    const tagRef = session.selectRefs(["refs/tags/v1.0.0"]);
    const plan = session.plan().materialize(tagRef).toTag("refs/tags/stable-v1");

    const preview = await previewDraft(plan);
    expect(preview.selectedRefs[0]?.localTarget).toBe("refs/tags/stable-v1");
  });

  test("setHead 设置 HEAD 到最后物化的 ref", async () => {
    const defaultBranch = session.defaultBranch();
    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();

    const preview = await previewDraft(plan);
    expect(preview.headOperation).toBeDefined();
    expect(preview.headOperation!.targetRef).toBe("refs/heads/main");
  });

  test("setHead 绑定当前 view 对应的前置物化结果，而不是全局最后一个映射", async () => {
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

    const preview = await previewDraft(plan);
    expect(preview.headOperation?.targetRef).toBe("refs/heads/main");
  });

  test("setHead 无前置物化时发出警告", async () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).setHead();

    const preview = await previewDraft(plan);
    // setHead 在物化操作中但没有前置 toBranch/toNamespace
    // headOperation 应为 undefined，同时发出警告
    expect(preview.headOperation).toBeUndefined();
    const warns = preview.diagnostics.filter((d) => d.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });

  test("setHead 指向镜像命名空间时报错", async () => {
    const defaultBranch = session.defaultBranch();
    const preview = await previewDraft(
      session
        .plan()
        .materialize(defaultBranch)
        .toNamespace("refs/mirrors/upstream/*", {
          policy: { mode: "mirror" },
        })
        .materialize(defaultBranch)
        .setHead(),
    );

    expect(preview.headOperation).toBeUndefined();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("setHead() 只能指向 refs/heads/*"),
      ),
    ).toBe(true);
  });

  test("setHead 指向 tag 时报错", async () => {
    const tagRef = session.selectRefs(["refs/tags/v1.0.0"]);
    const preview = await previewDraft(
      session.plan().materialize(tagRef).toTag("stable-v1").materialize(tagRef).setHead(),
    );

    expect(preview.headOperation).toBeUndefined();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("setHead() 只能指向 refs/heads/*"),
      ),
    ).toBe(true);
  });

  test("setHead({ detach: true }) 仍要求目标是 refs/heads/*", async () => {
    const defaultBranch = session.defaultBranch();
    const preview = await previewDraft(
      session
        .plan()
        .materialize(defaultBranch)
        .toNamespace("refs/mirrors/upstream/*", {
          policy: { mode: "mirror" },
        })
        .materialize(defaultBranch)
        .setHead({ detach: true }),
    );

    expect(preview.headOperation).toBeUndefined();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("setHead() 只能指向 refs/heads/*"),
      ),
    ).toBe(true);
  });

  test("toBranch 多 ref 视图直接报错", async () => {
    const branches = session.select("refs/heads/*");
    const preview = await previewDraft(session.plan().materialize(branches).toBranch("main"));

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes('toBranch("main") 需要单一 ref 视图'),
      ),
    ).toBe(true);
  });

  test("多个 materialize 链完整工作", async () => {
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

    const preview = await previewDraft(plan);

    // 3 branches + 1 release tag + 1 branch + HEAD
    expect(preview.selectedRefs.length).toBe(5);
    expect(preview.headOperation).toBeDefined();
    expect(preview.headOperation!.targetRef).toBe("refs/heads/main");
  });
});

describe("ImportPlanDraft — 前置条件与诊断", () => {
  const backend = createBackendWithMockObjects();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("prepare 预览不暴露内部前置条件快照", async () => {
    const defaultBranch = session.defaultBranch();
    const plan = session.plan().materialize(defaultBranch).toBranch("new-main");
    const preview = await previewDraft(plan);

    expect("localPreconditions" in preview).toBe(false);
  });

  test("setHead 的准备预览仍可正常生成", async () => {
    backend.refs.write("HEAD", "ref: refs/heads/old-main");

    const defaultBranch = session.defaultBranch();
    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();
    const preview = await previewDraft(plan);

    expect(preview.headOperation?.targetRef).toBe("refs/heads/main");
    expect("localPreconditions" in preview).toBe(false);
  });

  test("create-only 策略检测已有 ref 冲突", async () => {
    // 先在本地创建一个 tag
    backend.refs.write("refs/tags/v1.0.0", sha1("e".repeat(40)));

    const tagView = session.selectRefs(["refs/tags/v1.0.0"]);
    const plan = session
      .plan()
      .materialize(tagView)
      .toTag("v1.0.0", { policy: { mode: "create-only" } });

    const preview = await previewDraft(plan);

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

  test("no-op 跳过（远程 hash 与本地相同）", async () => {
    // 先写入一个与远端 hash 相同的 ref
    backend.refs.write("refs/heads/main", MOCK_HASH_A);

    const mainView = session.selectRefs(["refs/heads/main"]);
    const plan = session.plan().materialize(mainView).toBranch("main");
    const preview = await previewDraft(plan);

    // 应为 info 级别的 "已是最新" 诊断
    const skipMessages = preview.diagnostics.filter((d) => d.message.includes("已是最新"));
    expect(skipMessages.length).toBeGreaterThan(0);

    // refOperations 不应包含被跳过的 ref
    const mainOps = preview.refOperations.filter((r) => r.localRef === "refs/heads/main");
    expect(mainOps.length).toBe(0);
  });

  test("hash 相同但对象缺失时仍会规划对象导入", async () => {
    const isolatedBackend = createMemoryRepositoryBackend();
    isolatedBackend.refs.write("refs/heads/main", MOCK_HASH_A);
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async () => {
        throw new Error("transport requested");
      },
    };
    const isolatedSession = createImportSession(MOCK_SOURCE, isolatedBackend, adv, mockV2Transport);

    const mainView = isolatedSession.selectRefs(["refs/heads/main"]);
    const plan = isolatedSession.plan().materialize(mainView).toBranch("main");
    expect(previewDraft(plan)).rejects.toThrow(/transport requested/);
  });

  test("自定义命名空间未显式指定 policy 时拒绝 apply", async () => {
    const branches = session.select("refs/heads/*");
    const plan = session.plan().materialize(branches).toNamespace("refs/mirrors/upstream/*");
    const preview = await previewDraft(plan);

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("需要显式指定 policy"),
      ),
    ).toBe(true);
  });

  test("命名视图标签会出现在诊断中", async () => {
    const namedEmptyView = session.select("refs/heads/nonexistent/*").name("empty-branches");
    const preview = await previewDraft(
      session.plan().materialize(namedEmptyView).toBranch("ghost"),
    );

    expect(
      preview.diagnostics.some(
        (d) => d.level === "warn" && d.message.includes('命名视图 "empty-branches"'),
      ),
    ).toBe(true);
  });

  test("命名视图标签会结构化出现在 preview 中", async () => {
    const namedDefaultBranch = session.defaultBranch().name("default-branch");
    const preview = await previewDraft(
      session
        .plan()
        .materialize(namedDefaultBranch)
        .toBranch("named-main")
        .materialize(namedDefaultBranch)
        .setHead(),
    );

    expect(preview.selectedRefs[0]?.viewLabel).toBe("default-branch");
    expect(preview.refOperations[0]?.viewLabel).toBe("default-branch");
    expect(preview.headOperation?.targetRef).toBe("refs/heads/named-main");
    expect(preview.headOperation?.viewLabel).toBe("default-branch");
  });
});

describe("ImportPlanDraft — 边界与错误", () => {
  const backend = createBackendWithMockObjects();
  const adv = createMockAdvertisement();
  const session = createImportSession(MOCK_SOURCE, backend, adv);

  test("空 view 的 toBranch 发出警告但不崩溃", async () => {
    const emptyView = session.select("refs/heads/nonexistent/*");
    const plan = session.plan().materialize(emptyView).toBranch("ghost");
    const preview = await previewDraft(plan);

    const warnings = preview.diagnostics.filter((d) => d.message.includes("view 为空"));
    expect(warnings.length).toBeGreaterThan(0);
    expect(preview.selectedRefs.length).toBe(0);
  });

  test("空 view 的 toTag 发出警告但不崩溃", async () => {
    const emptyView = session.select("refs/tags/nonexistent/*");
    const plan = session.plan().materialize(emptyView).toTag("ghost");
    const preview = await previewDraft(plan);

    const warnings = preview.diagnostics.filter((d) => d.message.includes("view 为空"));
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("空 view 的 toNamespace 返回空映射", async () => {
    const emptyView = session.select("refs/heads/nonexistent/*");
    const plan = session.plan().materialize(emptyView).toNamespace("refs/mirrors/*");
    const preview = await previewDraft(plan);

    expect(preview.selectedRefs.length).toBe(0);
  });

  test("精确目标不允许开启 prune", async () => {
    const mainRef = session.selectRefs(["refs/heads/main"]);
    const preview = await previewDraft(
      session
        .plan()
        .materialize(mainRef)
        .toNamespace("refs/mirrors/upstream/main", {
          policy: { mode: "mirror" },
          prune: true,
        }),
    );

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes("prune 只允许用于带 * 的命名空间投影"),
      ),
    ).toBe(true);
  });

  test("多个动作写入同一目标 ref 时拒绝 apply", async () => {
    const mainRef = session.selectRefs(["refs/heads/main"]);
    const developRef = session.selectRefs(["refs/heads/develop"]);

    const preview = await previewDraft(
      session
        .plan()
        .materialize(mainRef)
        .toBranch("shared")
        .materialize(developRef)
        .toBranch("shared"),
    );

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
    const result = await applyDraft(plan);
    expect(result.importedObjects).toBe(0);
    expect(result.updatedRefs.size).toBe(0);
  });

  test("preview 保留 remoteSnapshot 快照", async () => {
    const plan = session.plan();
    const preview = await previewDraft(plan);

    expect(preview.remoteSnapshot.defaultBranch).toBe("refs/heads/main");
    expect(preview.remoteSnapshot.refs.length).toBe(7);
  });

  test("preview 结果会被冻结", async () => {
    const preview = await previewDraft(
      session.plan().materialize(session.defaultBranch()).toBranch("main"),
    );

    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.selectedRefs)).toBe(true);
    expect(Object.isFrozen(preview.refOperations)).toBe(true);
    expect(Object.isFrozen(preview.diagnostics)).toBe(true);
  });
});

// ============================================================================
// Apply 执行器
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

describe("apply 写 ref", () => {
  function createRepoWithObjects() {
    const backend = createMemoryRepositoryBackend();
    const { objects } = backend;

    // 创建空 tree
    const treeHash = writeObject(objects, {
      type: "tree",
      entries: [],
    });

    // 创建 commit
    const commitHash = writeObject(objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "test commit\n",
    });

    // 创建第二个 commit（用于分支推进）
    const commitHash2 = writeObject(objects, {
      type: "commit",
      tree: treeHash,
      parents: [commitHash],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "second commit\n",
    });

    // 创建 blob（用于非 commit 命名空间）
    const blobContent = Buffer.from("hello world");
    const blobHash = writeObject(objects, {
      type: "blob",
      content: blobContent,
    });

    return { backend, treeHash, commitHash, commitHash2, blobHash };
  }

  test("prepare 阶段直接拒绝非 fast-forward 更新", async () => {
    const { backend, commitHash, commitHash2 } = createRepoWithObjects();
    backend.refs.write("refs/heads/main", commitHash2);

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const preview = await previewDraft(
      session.plan().materialize(session.defaultBranch()).toBranch("main"),
    );

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (d) => d.level === "error" && d.message.includes('ref "refs/heads/main" 无法 fast-forward'),
      ),
    ).toBe(true);
  });

  test("prepare 阶段直接拒绝把非 commit 对象物化到 refs/heads/*", async () => {
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
    const preview = await previewDraft(
      session.plan().materialize(session.defaultBranch()).toBranch("main"),
    );

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

    const result = await applyDraft(plan);

    expect(result.importedObjects).toBe(0); // 本地已有对象
    expect(result.updatedRefs.get("refs/heads/main")).toBe(sha1(commitHash));
    expect(backend.refs.read("refs/heads/main")).toBe(commitHash);
  });

  test("fetch 返回 shallow-info 时，prepare/apply 会同步 backend.shallow", async () => {
    const backend = createMemoryRepositoryBackend();
    const remoteBackend = createMemoryRepositoryBackend();
    const tree = {
      type: "tree" as const,
      entries: [],
    };
    const treeHash = writeObject(backend.objects, tree);
    const parent = {
      type: "commit" as const,
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "boundary parent\n",
    };
    const parentHash = writeObject(remoteBackend.objects, parent);
    const localTip = {
      type: "commit" as const,
      tree: treeHash,
      parents: [parentHash],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "local shallow tip\n",
    };
    const localTipHash = writeObject(backend.objects, localTip);
    const remoteCommit = {
      type: "commit" as const,
      tree: treeHash,
      parents: [localTipHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "remote tip\n",
    };
    const remoteCommitHash = writeObject(remoteBackend.objects, remoteCommit);

    backend.refs.write("refs/heads/main", localTipHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");
    backend.shallow.write([localTipHash]);

    const writer = createPackWriter();
    writer.addRaw(encodeObject(parent));
    writer.addRaw(encodeObject(remoteCommit));

    const fetchResponse = Buffer.concat([
      encodePktLine("shallow-info\n"),
      encodePktLine(`shallow ${parentHash}\n`),
      encodePktLine(`unshallow ${localTipHash}\n`),
      encodeDelimiterPkt(),
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);

    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async () => fetchResponse,
    };
    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: remoteCommitHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: remoteCommitHash, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport, ["shallow"]);

    const prepared = await prepareDraft(
      session.plan().materialize(session.defaultBranch()).toBranch("main"),
    );

    expect(prepared.preview.shallowUpdate).toEqual({
      shallow: [parentHash],
      unshallow: [localTipHash],
    });
    expect(backend.shallow.read()).toEqual([localTipHash]);

    const result = await prepared.apply();

    expect(result.shallowUpdate).toEqual({
      shallow: [parentHash],
      unshallow: [localTipHash],
    });
    expect(backend.shallow.read()).toEqual([parentHash]);
    expect(result.updatedRefs.get("refs/heads/main")).toBe(remoteCommitHash);
  });

  test("deepen 会在对象已存在时继续发起 fetch，并携带 shallow/deepen 参数", async () => {
    const backend = createMemoryRepositoryBackend();
    const remoteBackend = createMemoryRepositoryBackend();
    const tree = {
      type: "tree" as const,
      entries: [],
    };
    const treeHash = writeObject(remoteBackend.objects, tree);
    const parent = {
      type: "commit" as const,
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "parent\n",
    };
    const parentHash = writeObject(remoteBackend.objects, parent);
    const tip = {
      type: "commit" as const,
      tree: treeHash,
      parents: [parentHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "tip\n",
    };
    const tipHash = writeObject(remoteBackend.objects, tip);

    writeObject(backend.objects, tree);
    writeObject(backend.objects, tip);
    backend.refs.write("refs/heads/main", tipHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");
    backend.shallow.write([tipHash]);

    const writer = createPackWriter();
    writer.addRaw(encodeObject(parent));
    const calls: string[][] = [];
    const fetchResponse = Buffer.concat([
      encodePktLine("shallow-info\n"),
      encodePktLine(`shallow ${parentHash}\n`),
      encodePktLine(`unshallow ${tipHash}\n`),
      encodeDelimiterPkt(),
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return fetchResponse;
      },
    };
    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: tipHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: tipHash, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport, ["shallow"]);

    const prepared = await prepareDraft(
      session.plan().materialize(session.defaultBranch()).toBranch("main"),
      { deepen: 1 },
    );

    expect(calls).toEqual([
      [
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${tipHash}`,
        "deepen 1",
        "deepen-relative",
        `want ${tipHash}`,
        `have ${tipHash}`,
      ],
    ]);
    expect(prepared.preview.prefetchedObjects).toBe(1);
    expect(prepared.preview.shallowUpdate).toEqual({
      shallow: [parentHash],
      unshallow: [tipHash],
    });

    const result = await prepared.apply();
    expect(result.importedObjects).toBe(1);
    expect(backend.shallow.read()).toEqual([parentHash]);
  });

  test("shallowSince 会在对象已存在时透传为 deepen-since 请求", async () => {
    const backend = createMemoryRepositoryBackend();
    const remoteBackend = createMemoryRepositoryBackend();
    const tree = {
      type: "tree" as const,
      entries: [],
    };
    const treeHash = writeObject(remoteBackend.objects, tree);
    const parent = {
      type: "commit" as const,
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "parent\n",
    };
    const parentHash = writeObject(remoteBackend.objects, parent);
    const tip = {
      type: "commit" as const,
      tree: treeHash,
      parents: [parentHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "tip\n",
    };
    const tipHash = writeObject(remoteBackend.objects, tip);

    writeObject(backend.objects, tree);
    writeObject(backend.objects, tip);
    backend.refs.write("refs/heads/main", tipHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");
    backend.shallow.write([tipHash]);

    const writer = createPackWriter();
    writer.addRaw(encodeObject(parent));
    const calls: string[][] = [];
    const fetchResponse = Buffer.concat([
      encodePktLine("shallow-info\n"),
      encodePktLine(`shallow ${parentHash}\n`),
      encodePktLine(`unshallow ${tipHash}\n`),
      encodeDelimiterPkt(),
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return fetchResponse;
      },
    };
    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: tipHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: tipHash, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport, ["shallow"]);

    await prepareDraft(session.plan().materialize(session.defaultBranch()).toBranch("main"), {
      shallowSince: 1672548608,
    });

    expect(calls).toEqual([
      [
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${tipHash}`,
        "deepen-since 1672548608",
        `want ${tipHash}`,
        `have ${tipHash}`,
      ],
    ]);
  });

  test("shallowSince 必须是有限整数秒级 Unix 时间戳", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);

    for (const shallowSince of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(
        prepareDraft(session.plan().materialize(session.defaultBranch()).toBranch("main"), {
          shallowSince,
        }),
      ).rejects.toThrow(/shallowSince 必须是有限整数秒级 Unix 时间戳/);
    }
  });

  test("完整仓库上的 shallow 请求不会再用 known-common 提示裁剪祖先 have", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, {
      type: "tree" as const,
      entries: [],
    });
    const rootHash = writeObject(backend.objects, {
      type: "commit" as const,
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "root\n",
    });
    const secondHash = writeObject(backend.objects, {
      type: "commit" as const,
      tree: treeHash,
      parents: [rootHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "second\n",
    });
    const tipHash = writeObject(backend.objects, {
      type: "commit" as const,
      tree: treeHash,
      parents: [secondHash],
      author: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      message: "tip\n",
    });

    backend.refs.write("refs/heads/main", tipHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return Buffer.concat([
          encodePktLine("acknowledgments\n"),
          encodePktLine("NAK\n"),
          encodeFlushPkt(),
        ]);
      },
    };
    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: tipHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: tipHash, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport, ["shallow"]);

    expect(
      prepareDraft(session.plan().materialize(session.defaultBranch()).toBranch("main"), {
        deepen: 1,
      }),
    ).rejects.toThrow(/without packfile payload/);

    expect(calls[0]).toEqual([
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      "deepen 1",
      "deepen-relative",
      `want ${tipHash}`,
      `have ${tipHash}`,
      `have ${secondHash}`,
      `have ${rootHash}`,
    ]);
  });

  test("shallowSince 若服务端返回 unshallow 但父提交仍缺失，应拒绝而不是清空 shallow", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, {
      type: "tree" as const,
      entries: [],
    });
    const missingParent = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const tip = {
      type: "commit" as const,
      tree: treeHash,
      parents: [missingParent],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "tip\n",
    };
    const tipHash = writeObject(backend.objects, tip);

    backend.refs.write("refs/heads/main", tipHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");
    backend.shallow.write([tipHash]);

    const writer = createPackWriter();
    const fetchResponse = Buffer.concat([
      encodePktLine("acknowledgments\n"),
      encodePktLine(`ACK ${tipHash}\n`),
      encodePktLine("ready\n"),
      encodeDelimiterPkt(),
      encodePktLine("shallow-info\n"),
      encodePktLine(`unshallow ${tipHash}\n`),
      encodeDelimiterPkt(),
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async () => fetchResponse,
    };
    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: tipHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: tipHash, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport, ["shallow"]);

    expect(
      prepareDraft(session.plan().materialize(session.defaultBranch()).toBranch("main"), {
        shallowSince: 0,
      }),
    ).rejects.toThrow(/missing from the local store/);
    expect(backend.shallow.read()).toEqual([tipHash]);
  });

  test("unshallow 在完整仓库上会直接报错", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);

    expect(
      prepareDraft(session.plan().materialize(session.defaultBranch()).toBranch("main"), {
        unshallow: true,
      }),
    ).rejects.toThrow(/shallow 仓库/);
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

    const result = await applyDraft(plan);

    expect(result.updatedRefs.has("refs/heads/main")).toBe(true);
    expect(result.headTarget).toBe("refs/heads/main");
    expect(backend.refs.read("HEAD")).toBe("ref: refs/heads/main");
  });

  test("mirror 策略允许 refs/heads/* 执行非 fast-forward 更新", async () => {
    const { backend, commitHash, commitHash2 } = createRepoWithObjects();
    const treeHash = writeObject(backend.objects, {
      type: "tree",
      entries: [],
    });
    const divergedCommit = writeObject(backend.objects, {
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

    const prepared = await prepareDraft(plan);
    const preview = prepared.preview;
    expect(preview.canApply).toBe(true);
    expect(
      preview.diagnostics.some((d) => d.level === "info" && d.message.includes("mirror 策略覆盖")),
    ).toBe(true);

    const result = await applyDraft(plan);

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

    const preview = await previewDraft(plan);
    expect(preview.headOperation?.detach).toBe(true);

    const result = await applyDraft(plan);

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

    const result = await applyDraft(plan);

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

    const result = await applyDraft(plan);

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

    const result = await applyDraft(plan);

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

    const result = await applyDraft(
      session
        .plan()
        .materialize(mainView)
        .toNamespace("refs/mirrors/*-backup", {
          policy: { mode: "mirror" },
          prune: true,
        }),
    );

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

    const result = await applyDraft(
      session
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
        }),
    );

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

    const result = await applyDraft(
      session
        .plan()
        .materialize(emptyView)
        .toNamespace("refs/mirrors/upstream/*", {
          policy: { mode: "mirror" },
          prune: true,
        }),
    );

    expect([...result.deletedRefs].sort()).toEqual([
      "refs/mirrors/upstream/legacy",
      "refs/mirrors/upstream/old",
    ]);
    expect(backend.refs.read("refs/mirrors/upstream/legacy")).toBeNull();
    expect(backend.refs.read("refs/mirrors/upstream/old")).toBeNull();
  });
});

describe("apply 错误处理", () => {
  function createRepoWithObjects() {
    const backend = createMemoryRepositoryBackend();
    const { objects } = backend;
    const treeHash = writeObject(objects, {
      type: "tree",
      entries: [],
    });
    const commitHash = writeObject(objects, {
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

    // prepare 后，外部修改了本地 ref
    const prepared = await prepareDraft(plan);
    const preview = prepared.preview;
    expect(preview.canApply).toBe(true);

    // 在 apply 前手动写 ref，破坏前置条件
    // 注意：前置条件是针对目标 ref 的，这里写一个不同 hash 的 ref 来触发
    // 但由于目标 ref 不存在，precondition 是 null，写一个不同值的 ref 会触发
    backend.refs.write("refs/heads/main", sha1("f".repeat(40)));

    // apply 应因前置条件变化而失败
    expect(prepared.apply()).rejects.toThrow(/前置条件/);
  });

  test("HEAD 在 prepare 生成预览后漂移时 apply 失败", async () => {
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

    const prepared = await prepareDraft(plan);

    backend.refs.write("HEAD", "ref: refs/heads/changed");

    expect(prepared.apply()).rejects.toThrow(/前置条件/);
  });

  test("prune 命名空间在 prepare 生成预览后新增 ref 时 apply 失败", async () => {
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

    const prepared = await prepareDraft(plan);

    backend.refs.write("refs/mirrors/upstream/rogue", sha1("e".repeat(40)));

    expect(prepared.apply()).rejects.toThrow(
      /命名空间 "refs\/mirrors\/upstream\/\*" 在 prepare\(\) 生成的预览后已变化/,
    );
  });

  test("prepare 前追加动作时 apply 使用最新计划", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv);
    const defaultBranch = session.defaultBranch();

    const plan = session.plan();
    const firstPreview = await previewDraft(plan);
    expect(firstPreview.refOperations.length).toBe(0);

    plan.materialize(defaultBranch).toBranch("main");
    const result = await applyDraft(plan);

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

    expect(applyDraft(plan)).rejects.toThrow(/错误.*无法执行/);
    expect(backend.refs.read("refs/heads/main")).toBe(sha1("d".repeat(40)));
    // 原始 hash 保持不变
    expect(backend.refs.read("refs/heads/main")).toBe(sha1("d".repeat(40)));
  });

  test("create-only 策略会把符号引用视为已存在 ref", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    backend.refs.write("refs/heads/current", commitHash);
    backend.refs.write("refs/heads/main", "ref: refs/heads/current");

    const nextCommit = writeObject(backend.objects, {
      type: "commit",
      tree: writeObject(backend.objects, {
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

    const preview = await previewDraft(plan);
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === "error" && diagnostic.message.includes("create-only 策略拒绝更新"),
      ),
    ).toBe(true);
    expect(applyDraft(plan)).rejects.toThrow(/create-only/);
  });

  test("对象缺失时 preview 预取失败会向上传递 transport 错误", async () => {
    const { backend } = createRepoWithObjects();
    const missingHash = sha1("c".repeat(40));
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async () => {
        throw new Error("transport requested");
      },
    };
    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: missingHash, name: "HEAD" },
        { hash: missingHash, name: "refs/heads/missing" },
      ],
      defaultBranch: undefined,
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);
    const missingView = session.selectRefs(["refs/heads/missing"]);
    const plan = session.plan().materialize(missingView).toBranch("missing-tip");

    expect(previewDraft(plan)).rejects.toThrow();
    expect(applyDraft(plan)).rejects.toThrow();
  });

  test("hash 相同但对象缺失时 preview 会先尝试导入对象", async () => {
    const backend = createMemoryRepositoryBackend();
    backend.refs.write("refs/heads/main", MOCK_HASH_A);

    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async () => {
        throw new Error("transport requested");
      },
    };

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: MOCK_HASH_A, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: MOCK_HASH_A, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };

    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const plan = session.plan().materialize(session.defaultBranch()).toBranch("main");
    expect(previewDraft(plan)).rejects.toThrow(/transport requested/);
    expect(applyDraft(plan)).rejects.toThrow(/transport requested/);
  });

  test("prepare 期间本地 ref 漂移会直接返回失败预览", async () => {
    const backend = createMemoryRepositoryBackend();
    const sourceRepo = createMemoryRepositoryBackend();
    const tree = {
      type: "tree" as const,
      entries: [],
    };
    const treeHash = writeObject(sourceRepo.objects, tree);
    const commit = {
      type: "commit" as const,
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 0, timezone: "+0000" },
      message: "remote commit\n",
    };
    const commitHash = writeObject(sourceRepo.objects, commit);

    const writer = createPackWriter();
    writer.addRaw(encodeObject(tree));
    writer.addRaw(encodeObject(commit));
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);
    const negotiationResponse = Buffer.concat([
      encodePktLine("acknowledgments\n"),
      encodePktLine("NAK\n"),
      encodeFlushPkt(),
    ]);

    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        backend.refs.write("refs/heads/main", sha1("f".repeat(40)));
        return args?.includes("done") ? packfileResponse : negotiationResponse;
      },
    };

    const adv = createAdvForCommit(commitHash);
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const plan = session.plan().materialize(session.defaultBranch()).toBranch("main");
    const preview = await previewDraft(plan);
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === "error" && diagnostic.message.includes("前置条件校验失败"),
      ),
    ).toBe(true);

    expect(applyDraft(plan)).rejects.toThrow(/无法执行/);
    expect(backend.refs.read("refs/heads/main")).toBe(sha1("f".repeat(40)));
  });

  test("仅对象库中存在但不被本地 ref 可达的远端 ref，不应作为 known-common have 参与协商", async () => {
    const backend = createMemoryRepositoryBackend();
    const localTree = {
      type: "tree" as const,
      entries: [],
    };
    const localTreeHash = writeObject(backend.objects, localTree);
    const localCommit = {
      type: "commit" as const,
      tree: localTreeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "local commit\n",
    };
    const localCommitHash = writeObject(backend.objects, localCommit);
    backend.refs.write("refs/heads/main", localCommitHash);

    const danglingCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: localTreeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "dangling commit\n",
    });

    const remoteCommit = {
      type: "commit" as const,
      tree: localTreeHash,
      parents: [localCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      message: "remote commit\n",
    };
    const remoteCommitHash = writeObject(createMemoryRepositoryBackend().objects, remoteCommit);

    const writer = createPackWriter();
    writer.addRaw(encodeObject(remoteCommit));
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);
    const negotiationResponse = Buffer.concat([
      encodePktLine("acknowledgments\n"),
      encodePktLine("NAK\n"),
      encodeFlushPkt(),
    ]);

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return args?.includes("done") ? packfileResponse : negotiationResponse;
      },
    };

    const adv = createAdvForCommit(remoteCommitHash, [
      { name: "refs/heads/stale", hash: danglingCommitHash },
    ]);
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const plan = session
      .plan()
      .materialize(session.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
    const preview = await previewDraft(plan);

    expect(preview.canApply).toBe(true);
    const fetchCall = calls.find((args) => args.includes("want " + remoteCommitHash));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toContain(`have ${localCommitHash}`);
    expect(fetchCall).not.toContain(`have ${danglingCommitHash}`);
  });

  test("未变化远端 ref 即使不在本轮 want 中，也应作为 known-common 提示裁剪祖先 have", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const rootCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "root commit\n",
    });
    const featureCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [rootCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "feature old\n",
    });
    const stableCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [featureCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      message: "stable common\n",
    });
    const mainCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [stableCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 4, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 4, timezone: "+0000" },
      message: "main old\n",
    });

    backend.refs.write("refs/heads/main", mainCommitHash);
    backend.refs.write("refs/heads/stable", stableCommitHash);
    backend.refs.write("refs/heads/feature", featureCommitHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");

    const remoteFeature = {
      type: "commit" as const,
      tree: treeHash,
      parents: [featureCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 5, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 5, timezone: "+0000" },
      message: "feature new\n",
    };
    const remoteMain = {
      type: "commit" as const,
      tree: treeHash,
      parents: [mainCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 6, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 6, timezone: "+0000" },
      message: "main new\n",
    };
    const remoteFeatureRaw = encodeObject(remoteFeature);
    const remoteMainRaw = encodeObject(remoteMain);

    const writer = createPackWriter();
    writer.addRaw(remoteFeatureRaw);
    writer.addRaw(remoteMainRaw);
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);
    const negotiationResponse = Buffer.concat([
      encodePktLine("acknowledgments\n"),
      encodePktLine("NAK\n"),
      encodeFlushPkt(),
    ]);

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return args?.includes("done") ? packfileResponse : negotiationResponse;
      },
    };

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: remoteMainRaw.hash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: remoteMainRaw.hash, name: "refs/heads/main" },
        { hash: remoteFeatureRaw.hash, name: "refs/heads/feature" },
        { hash: stableCommitHash, name: "refs/heads/stable" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const preview = await previewDraft(
      session
        .plan()
        .materialize(session.select("refs/heads/*"))
        .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } }),
    );

    expect(preview.canApply).toBe(true);
    const fetchCall = calls.find((args) => args.includes(`want ${remoteMainRaw.hash}`));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toContain(`have ${mainCommitHash}`);
    expect(fetchCall).toContain(`have ${stableCommitHash}`);
    expect(fetchCall).not.toContain(`have ${featureCommitHash}`);
  });

  test("远端 annotated tag 对象缺失但 peeled commit 本地可达时，应使用 peeled commit 作为 known-common", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const rootCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "root commit\n",
    });
    const localCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [rootCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "local commit\n",
    });
    backend.refs.write("refs/heads/main", localCommitHash);

    const remoteTag = {
      type: "tag" as const,
      object: localCommitHash,
      objectType: "commit" as const,
      tag: "v-remote",
      tagger: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      message: "v-remote\n",
    };
    const remoteTagRaw = encodeObject(remoteTag);
    const writer = createPackWriter();
    writer.addRaw(remoteTagRaw);
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return packfileResponse;
      },
    };

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: localCommitHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: localCommitHash, name: "refs/heads/main" },
        { hash: remoteTagRaw.hash, name: "refs/tags/v-remote", peeled: localCommitHash },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const plan = session
      .plan()
      .materialize(session.select("refs/tags/*"))
      .toNamespace("refs/tags/*", { policy: { mode: "create-only" } });
    const preview = await previewDraft(plan);

    expect(preview.canApply).toBe(true);
    const fetchCall = calls.find((args) => args.includes("want " + remoteTagRaw.hash));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toContain(`have ${localCommitHash}`);
    expect(fetchCall).not.toContain(`have ${rootCommitHash}`);
  });

  test("显式抓取分支与 annotated tag 时不应再附带 include-tag", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const localCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "local commit\n",
    });
    const remoteCommit = {
      type: "commit" as const,
      tree: treeHash,
      parents: [localCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "remote commit\n",
    };
    const remoteCommitRaw = encodeObject(remoteCommit);
    const remoteCommitHash = remoteCommitRaw.hash;
    const remoteTag = {
      type: "tag" as const,
      object: remoteCommitHash,
      objectType: "commit" as const,
      tag: "v-next",
      tagger: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      message: "v-next\n",
    };
    const remoteTagRaw = encodeObject(remoteTag);

    backend.refs.write("refs/heads/main", localCommitHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");

    const writer = createPackWriter();
    writer.addRaw(remoteCommitRaw);
    writer.addRaw(remoteTagRaw);
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return packfileResponse;
      },
    };

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: remoteCommitHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: remoteCommitHash, name: "refs/heads/main" },
        { hash: remoteTagRaw.hash, name: "refs/tags/v-next", peeled: remoteCommitHash },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const preview = await previewDraft(
      session
        .plan()
        .materialize(session.select("refs/heads/*"))
        .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
        .materialize(session.select("refs/tags/*"))
        .toNamespace("refs/tags/*", { policy: { mode: "create-only" } }),
    );

    expect(preview.canApply).toBe(true);
    const fetchCall = calls.find((args) => args.includes(`want ${remoteCommitHash}`));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toContain(`want ${remoteTagRaw.hash}`);
    expect(fetchCall).toContain(`have ${localCommitHash}`);
    expect(fetchCall).not.toContain("include-tag");
  });

  test("shallow + 显式 tag pattern 对已存在 annotated tag 不应像 refspec 一样继续显式 want", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const localCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "local commit\n",
    });
    const remoteCommit = {
      type: "commit" as const,
      tree: treeHash,
      parents: [localCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "remote commit\n",
    };
    const remoteCommitRaw = encodeObject(remoteCommit);
    const remoteCommitHash = remoteCommitRaw.hash;
    const remoteTag = {
      type: "tag" as const,
      object: remoteCommitHash,
      objectType: "commit" as const,
      tag: "v-next",
      tagger: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      message: "v-next\n",
    };
    const remoteTagRaw = encodeObject(remoteTag);

    writeObject(backend.objects, remoteCommit);
    writeObject(backend.objects, remoteTag);
    backend.refs.write("refs/heads/main", remoteCommitHash);
    backend.refs.write("refs/tags/v-next", remoteTagRaw.hash);
    backend.refs.write("HEAD", "ref: refs/heads/main");

    const writer = createPackWriter();
    writer.addRaw(remoteCommitRaw);
    writer.addRaw(remoteTagRaw);
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return packfileResponse;
      },
    };

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: remoteCommitHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: remoteCommitHash, name: "refs/heads/main" },
        { hash: remoteTagRaw.hash, name: "refs/tags/v-next", peeled: remoteCommitHash },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const preview = await previewDraft(
      session
        .plan()
        .materialize(session.select("refs/heads/*"))
        .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
        .materialize(session.select("refs/tags/*"))
        .toNamespace("refs/tags/*", { policy: { mode: "create-only" } }),
      {
        depth: 1,
        requestedExplicitTags: true,
      },
    );

    expect(preview.canApply).toBe(true);
    const fetchCall = calls.find((args) => args.includes(`want ${remoteCommitHash}`));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).not.toContain(`want ${remoteTagRaw.hash}`);
    expect(fetchCall).not.toContain("include-tag");
  });

  test("shallow + 显式 tag refspec 会继续显式 want 已存在的 annotated tag", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const localCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "local commit\n",
    });
    const remoteCommit = {
      type: "commit" as const,
      tree: treeHash,
      parents: [localCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "remote commit\n",
    };
    const remoteCommitRaw = encodeObject(remoteCommit);
    const remoteCommitHash = remoteCommitRaw.hash;
    const remoteTag = {
      type: "tag" as const,
      object: remoteCommitHash,
      objectType: "commit" as const,
      tag: "v-next",
      tagger: { name: "Test", email: "test@test", timestamp: 3, timezone: "+0000" },
      message: "v-next\n",
    };
    const remoteTagRaw = encodeObject(remoteTag);

    writeObject(backend.objects, remoteCommit);
    writeObject(backend.objects, remoteTag);
    backend.refs.write("refs/heads/main", remoteCommitHash);
    backend.refs.write("refs/tags/v-next", remoteTagRaw.hash);
    backend.refs.write("HEAD", "ref: refs/heads/main");

    const writer = createPackWriter();
    writer.addRaw(remoteCommitRaw);
    writer.addRaw(remoteTagRaw);
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return packfileResponse;
      },
    };

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: remoteCommitHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: remoteCommitHash, name: "refs/heads/main" },
        { hash: remoteTagRaw.hash, name: "refs/tags/v-next", peeled: remoteCommitHash },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const preview = await previewDraft(
      session
        .plan()
        .materialize(session.select("refs/heads/*"))
        .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
        .materialize(session.select("refs/tags/*"))
        .toNamespace("refs/tags/*", { policy: { mode: "create-only" } }),
      {
        depth: 1,
        refetchExistingTagTargetsInShallow: true,
      },
    );

    expect(preview.canApply).toBe(true);
    const fetchCall = calls.find((args) => args.includes(`want ${remoteCommitHash}`));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toContain(`want ${remoteTagRaw.hash}`);
    expect(fetchCall).not.toContain("include-tag");
  });

  test("显式 tag 请求即使当前没有匹配到任何 tag，也不会回退到 include-tag", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const localCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "local commit\n",
    });
    const remoteCommit = {
      type: "commit" as const,
      tree: treeHash,
      parents: [localCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "remote commit\n",
    };
    const remoteCommitRaw = encodeObject(remoteCommit);
    const remoteCommitHash = remoteCommitRaw.hash;

    backend.refs.write("refs/heads/main", localCommitHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");

    const writer = createPackWriter();
    writer.addRaw(remoteCommitRaw);
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return packfileResponse;
      },
    };

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: remoteCommitHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: remoteCommitHash, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const preview = await previewDraft(
      session.plan().materialize(session.select("refs/heads/*")).toNamespace("refs/heads/*"),
      { requestedExplicitTags: true },
    );

    expect(preview.canApply).toBe(true);
    const fetchCall = calls.find((args) => args.includes(`want ${remoteCommitHash}`));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toContain(`have ${localCommitHash}`);
    expect(fetchCall).not.toContain("include-tag");
  });

  test("noTags 会关闭 include-tag 自动跟随", async () => {
    const backend = createMemoryRepositoryBackend();
    const treeHash = writeObject(backend.objects, { type: "tree", entries: [] });
    const localCommitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 1, timezone: "+0000" },
      message: "local commit\n",
    });
    const remoteCommit = {
      type: "commit" as const,
      tree: treeHash,
      parents: [localCommitHash],
      author: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      committer: { name: "Test", email: "test@test", timestamp: 2, timezone: "+0000" },
      message: "remote commit\n",
    };
    const remoteCommitRaw = encodeObject(remoteCommit);
    const remoteCommitHash = remoteCommitRaw.hash;

    backend.refs.write("refs/heads/main", localCommitHash);
    backend.refs.write("HEAD", "ref: refs/heads/main");

    const writer = createPackWriter();
    writer.addRaw(remoteCommitRaw);
    const packfileResponse = Buffer.concat([
      encodePktLine("packfile\n"),
      encodePktLine(Buffer.concat([Buffer.from([0x01]), writer.build()])),
      encodeFlushPkt(),
    ]);

    const calls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        calls.push([...(args ?? [])]);
        return packfileResponse;
      },
    };

    const adv: RefAdvertisement = {
      capabilities: {},
      refs: [
        { hash: remoteCommitHash, name: "HEAD", symrefTarget: "refs/heads/main" },
        { hash: remoteCommitHash, name: "refs/heads/main" },
      ],
      defaultBranch: "refs/heads/main",
    };
    const session = createImportSession(MOCK_SOURCE, backend, adv, mockV2Transport);

    const preview = await previewDraft(
      session.plan().materialize(session.select("refs/heads/*")).toNamespace("refs/heads/*"),
      { noTags: true },
    );

    expect(preview.canApply).toBe(true);
    const fetchCall = calls.find((args) => args.includes(`want ${remoteCommitHash}`));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toContain(`have ${localCommitHash}`);
    expect(fetchCall).not.toContain("include-tag");
  });

  test("目标符号引用在 prepare 生成预览后漂移时 apply 失败", async () => {
    const { backend, commitHash } = createRepoWithObjects();
    backend.refs.write("refs/heads/current", commitHash);
    backend.refs.write("refs/heads/main", "ref: refs/heads/current");

    const nextCommit = writeObject(backend.objects, {
      type: "commit",
      tree: writeObject(backend.objects, {
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

    const prepared = await prepareDraft(plan);

    backend.refs.write("refs/heads/main", "ref: refs/heads/other");

    expect(prepared.apply()).rejects.toThrow(/前置条件/);
  });
});

describe("openImportSession source 透传", () => {
  test("source.token 会并入 session source 快照", async () => {
    const backend = createMemoryRepositoryBackend();
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async () => Buffer.alloc(0),
    };
    const repo = createRepoImportOperations(backend, mockV2Transport);
    const session = await repo.openImportSession({
      url: "https://example.com/private.git",
      token: "secret-token",
    });

    expect(session.source.token).toBe("secret-token");
  });

  test("openImportSession 会在 ls-refs 请求中带 unborn", async () => {
    const backend = createMemoryRepositoryBackend();
    backend.refs.write("HEAD", "ref: refs/heads/main");
    const commandCalls: string[][] = [];
    const mockV2Transport: V2GitServiceTransport = {
      advertise: async () => ({ capabilities: {}, commands: [] }),
      command: async (_command, args) => {
        commandCalls.push([...(args ?? [])]);
        return Buffer.concat([
          encodePktLine(`${MOCK_HASH_A} HEAD symref-target:refs/heads/main\n`),
          encodePktLine(`${MOCK_HASH_A} refs/heads/main\n`),
          encodeFlushPkt(),
        ]);
      },
    };

    const repo = createRepoImportOperations(backend, mockV2Transport);
    await repo.openImportSession({ url: "https://example.com/repo.git" });

    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toContain("unborn");
    expect(commandCalls[0]).toContain("symrefs");
    expect(commandCalls[0]).toContain("peel");
    expect(commandCalls[0]).toContain("ref-prefix refs/heads/main");
  });
});
