# Plan 002: Pack 模块 class 改为工厂函数

> **Executor instructions**: 按步骤依次执行，每步完成后运行验证命令并确认预期结果。
> 如遇到 STOP conditions 中的情况，停止并报告。
>
> **Drift check**: `git diff --stat 0b84c60..HEAD -- src/odb/pack/`
> 如有文件已变化，先对比 "Current state" 摘录与当前代码；不一致则 STOP。

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none（但建议在 Plan 003/004 测试补充后执行）
- **Category**: tech-debt
- **Planned at**: commit `0b84c60`, 2026-06-22

## Why this matters

项目约定（AGENTS.md）明确要求"无 class：全部使用工厂函数 + 对象字面量模式"。但 pack 模块中 4 个文件使用了 `class` 声明：`PackBuilder`、`PackIndexReader`、`PackIndexWriter`、`PackObjectStore`。不一致的编码风格使代码库更难推理，新贡献者不知该遵循哪种模式。

## Current state

4 个 class 及其工厂函数封装模式：

### 1. `PackBuilder` (`src/odb/pack/pack-builder.ts`)

当前：

```ts
export class PackBuilder {
  private readonly gitDir: string;
  private readonly objects: EncodedPackObject[] = [];
  private readonly hashes: Set<SHA1> = new Set();
  // getter: objectCount
  // methods: addObject, build
}

export function createPackBuilder(gitDir: string): PackBuilder {
  return new PackBuilder(gitDir);
}
```

### 2. `PackIndexReader` (`src/odb/pack/pack-index-reader.ts`)

当前：

```ts
export class PackIndexReader {
  private readonly data: Buffer;
  private readonly _objectCount: number;
  private readonly fanout: number[];
  // ... many private computed fields
  // getter: objectCount
  // methods: lookup, has, listHashes
}

export function createPackIndexReader(data: Buffer): PackIndexReader {
  return new PackIndexReader(data);
}
```

### 3. `PackIndexWriter` (`src/odb/pack/pack-index-writer.ts`)

当前：

```ts
export class PackIndexWriter {
  private entries: PackIndexEntry[] = [];
  // methods: addEntry, build
}

export function createPackIndexWriter(): PackIndexWriter {
  return new PackIndexWriter();
}
```

### 4. `PackObjectStore` (`src/odb/pack/pack-store.ts`)

当前：

```ts
export class PackObjectStore implements ObjectSource {
  private readonly packDir: string;
  private readonly pairs: PackPair[] = [];
  private loaded = false;
  // methods: refresh, read, exists, list, listPacks, ...
  // getters: packCount, objectCount
}

export function createPackObjectStore(gitDir: string): PackObjectStore {
  return new PackObjectStore(gitDir);
}
```

项目约定（来自 AGENTS.md）：

- "无 class"：全部工厂函数 + 对象字面量模式
- 类型定义通过 `interface` 在工厂函数返回值中表示
- `=====` 分区分隔符
- 注释和 JSDoc 使用中文

已有测试文件：

- `tests/units/odb/pack/pack-builder.test.ts`
- `tests/units/odb/pack/packfile.test.ts`（测试 PackIndexReader 和 PackReader）
- `tests/units/odb/pack/pack-index.test.ts`（测试 PackIndexReader/Writer）
- `tests/units/odb/pack/pack-store.test.ts`（测试 PackObjectStore）
- `tests/units/odb/pack/composite-store.test.ts`

## Commands you will need

| Purpose      | Command                          | Expected on success |
| ------------ | -------------------------------- | ------------------- |
| Install      | `bun install`                    | exit 0              |
| Tests        | `bun test tests/units/odb/pack/` | all pass            |
| Full test    | `bun test tests/units/`          | all pass            |
| Lint         | `bun run lint`                   | exit 0              |
| Format check | `bun run format:check`           | exit 0              |

## Scope

**In scope**:

- `src/odb/pack/pack-builder.ts` — 重构
- `src/odb/pack/pack-index-reader.ts` — 重构
- `src/odb/pack/pack-index-writer.ts` — 重构
- `src/odb/pack/pack-store.ts` — 重构

**Out of scope**:

- 任何测试文件（不应因重构而修改测试）
- `src/odb/pack/pack-store-loader.ts` — 是 `PackObjectStore` 的辅助模块，自然依赖，无需修改
- 其他任何文件

## Steps

### Step 1: `PackBuilder` class → 工厂函数

重构方式：

```ts
// 导出类型接口
export interface PackBuilder {
  readonly objectCount: number;
  addObject(obj: GitObject): SHA1;
  build(): PackBuildResult;
}

// 工厂函数
export function createPackBuilder(gitDir: string): PackBuilder {
  const objects: EncodedPackObject[] = [];
  const hashes = new Set<SHA1>();

  function addObject(obj: GitObject): SHA1 {
    const entry = toEncodedPackObject(obj);
    const hash = entry.hash;
    if (hashes.has(hash)) return hash;
    objects.push(entry);
    hashes.add(hash);
    return hash;
  }

  function build(): PackBuildResult {
    const packDir = join(gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });
    const encoded = buildEncodedPack(objects);
    const idxWriter = createPackIndexWriter();
    for (const entry of encoded.entries) {
      idxWriter.addEntry(entry);
    }
    const idxData = idxWriter.build(encoded.packChecksum);
    const checksumHex = encoded.packChecksum.toString("hex");
    const packPath = join(packDir, `pack-${checksumHex}.pack`);
    const idxPath = join(packDir, `pack-${checksumHex}.idx`);
    writeFileSync(packPath, encoded.packData);
    writeFileSync(idxPath, idxData);
    return { packPath, idxPath, checksum: checksumHex, objectCount: objects.length };
  }

  return {
    get objectCount() {
      return objects.length;
    },
    addObject,
    build,
  };
}
```

关键点：

- 移除 `class PackBuilder` 和 `private` 成员
- 内部状态变为闭包中的 `const` 变量
- `export type { PackBuildResult }` 保持不变
- 保留 `createPackBuilder` 导出，签名不变
- `objectCount` 用 getter 语法，调用方通过 `builder.objectCount` 访问（不变）

**Verify**: `bun test tests/units/odb/pack/pack-builder.test.ts` → 全部通过。

### Step 2: `PackIndexReader` class → 工厂函数

这是 4 个中最大的 class，因为它有大量的 `private` 计算字段（`sha1TableOffset`、`crc32TableOffset` 等）。

重构方式：

- 删除 `class PackIndexReader`
- 所有 `private readonly` 字段变为工厂函数作用域内的 `const` 变量
- 方法变为内部函数，引用闭包中的 `const data` 等
- 使用对象字面量返回接口

```ts
export interface PackIndexReader {
  readonly objectCount: number;
  lookup(hash: SHA1): PackIndexEntry | undefined;
  has(hash: SHA1): boolean;
  listHashes(): SHA1[];
}

export function createPackIndexReader(data: Buffer): PackIndexReader {
  // 原来 constructor 中的逻辑
  if (data.length < IDX_V2_HEADER_SIZE) {
    throw new PackIndexError("Index file too small");
  }
  const signature = data.subarray(0, 4);
  if (!signature.equals(IDX_V2_SIGNATURE)) {
    throw new PackIndexError(`Invalid signature: ${signature.toString("hex")}`);
  }
  const version = data.readUInt32BE(4);
  if (version !== IDX_V2_VERSION) {
    throw new PackIndexError(`Unsupported version: ${version}`);
  }

  const fanout: number[] = [];
  const fanoutStart = IDX_V2_HEADER_SIZE;
  for (let i = 0; i < 256; i++) {
    fanout.push(data.readUInt32BE(fanoutStart + i * 4));
  }
  const _objectCount = fanout[255]!;
  const sha1TableOffset = IDX_V2_HEADER_SIZE + IDX_V2_FANOUT_SIZE;
  const crc32TableOffset = sha1TableOffset + _objectCount * 20;
  const offsetTableOffset = crc32TableOffset + _objectCount * 4;
  const largeOffsetTable = offsetTableOffset + _objectCount * 4;

  // 私有方法变为内部函数
  function getHashAt(index: number): string {
    const offset = sha1TableOffset + index * 20;
    return data.subarray(offset, offset + 20).toString("hex");
  }

  function getEntryAt(index: number): PackIndexEntry {
    const hash = sha1(getHashAt(index));
    const crc32 = data.readUInt32BE(crc32TableOffset + index * 4);
    let offset = data.readUInt32BE(offsetTableOffset + index * 4);
    if (offset & 0x80000000) {
      offset = Number(data.readBigUInt64BE(largeOffsetTable + (offset & 0x7fffffff) * 8));
    }
    return { hash, offset, crc32 };
  }

  function lookup(hash: SHA1): PackIndexEntry | undefined {
    const firstByte = parseInt(hash.slice(0, 2), 16);
    const start = firstByte > 0 ? fanout[firstByte - 1]! : 0;
    const end = fanout[firstByte]!;
    let low = start,
      high = end;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const midHash = getHashAt(mid);
      const cmp = midHash.localeCompare(hash);
      if (cmp < 0) {
        low = mid + 1;
      } else if (cmp > 0) {
        high = mid;
      } else {
        return getEntryAt(mid);
      }
    }
    return undefined;
  }

  // ... 其他方法

  return {
    get objectCount() {
      return _objectCount;
    },
    lookup,
    has(hash: SHA1): boolean {
      return lookup(hash) !== undefined;
    },
    listHashes(): SHA1[] {
      /* ... */
    },
  };
}
```

**Verify**: `bun test tests/units/odb/pack/pack-index.test.ts tests/units/odb/pack/packfile.test.ts` → 全部通过。

### Step 3: `PackIndexWriter` class → 工厂函数

```ts
export function createPackIndexWriter(): PackIndexWriter {
  const entries: PackIndexEntry[] = [];

  function addEntry(entry: PackIndexEntry): void {
    entries.push(entry);
  }

  function build(packChecksum: Buffer): Buffer {
    // ... 原 build() 方法的实现，引用闭包 entries
  }

  // ... 其他内部辅助函数

  return {
    addEntry,
    build,
  };
}
```

除了去除 `class`，这个方法几乎不需要改动实现体本身。

**Verify**: `bun test tests/units/odb/pack/pack-index.test.ts` → 全部通过。

### Step 4: `PackObjectStore` class → 工厂函数

```ts
export interface PackObjectStore extends ObjectSource {
  refresh(): void;
  listPacks(): PackFileInfo[];
  readonly packCount: number;
  readonly objectCount: number;
}

export function createPackObjectStore(gitDir: string): PackObjectStore {
  const packDir = join(gitDir, "objects", "pack");
  const pairs: PackPair[] = [];
  let loaded = false;

  // ... 内部函数

  return {
    read(hash: SHA1): GitObject {
      /* ... */
    },
    exists(hash: SHA1): boolean {
      /* ... */
    },
    list(): SHA1[] {
      /* ... */
    },
    refresh() {
      loaded = false;
      pairs.length = 0;
    },
    // ...
  };
}
```

注意：

- 删掉 `class PackObjectStore implements ObjectSource`
- `ObjectSource` 中的方法应该通过接口满足，而非通过 `implements`
- `PackObjectStore` 需要同时满足 `ObjectSource` 和 `PackObjectStore` 接口
- 考虑是否要在 `pack-store-types.ts` 中或 `pack-store.ts` 中导出 `PackObjectStore` 接口

**Verify**: `bun test tests/units/odb/pack/pack-store.test.ts tests/units/odb/pack/composite-store.test.ts` → 全部通过。

### Step 5: 运行全部测试和 lint

```bash
bun test tests/units/
bun run lint
bun run format:check
```

**Verify**: 全部测试通过，lint 无错误，格式检查通过。

## Test plan

已有测试（pack-builder.test.ts、packfile.test.ts、pack-index.test.ts、pack-store.test.ts、composite-store.test.ts）覆盖了全部 4 个 class 的核心功能。重构后这些测试应保持通过，无需新增测试。

## Done criteria

- [ ] `bun test tests/units/odb/pack/` 全部通过
- [ ] `bun test tests/units/` 全部通过
- [ ] `bun run lint` 无错误
- [ ] `bun run format:check` 无格式问题
- [ ] 仅 4 个文件被修改（`git status` 确认）：`pack-builder.ts`, `pack-index-reader.ts`, `pack-index-writer.ts`, `pack-store.ts`
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- 任何步骤的验证在两次合理修复尝试后仍失败 → 停止并报告，说明哪个 class 的哪个方法转换失败
- 需要修改任何测试文件才能通过测试 → 停止（重构不应改变外部行为）
- 当前代码摘录与工作树不匹配
- 重构产生的文件超出 scope 中的 4 个文件

## Maintenance notes

- 转换成工厂函数后，`PackObjectStore` 的 `refresh()` 重置 `loaded = false; pairs.length = 0` 的行为与之前同。闭包中的 `const pairs` 仍可通过 `pairs.length = 0` 清空。
- `PackIndexReader` 需要在工厂函数中即时完成所有计算（代替 constructor 中的逻辑），避免延迟初始化带来的复杂性。
- 将来新的 pack 模块代码应直接用工厂函数模式编写。
