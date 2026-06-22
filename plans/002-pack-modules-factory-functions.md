# Plan 002: Pack 模块 class 改为工厂函数

> **Executor instructions**: 按步骤依次执行，每步完成后运行验证命令并确认预期结果。
> 如遇到 STOP conditions 中的情况，停止并报告，不要自行发挥。
>
> **Drift check (首先运行)**: `git diff --stat 8897004..HEAD -- src/odb/pack/ src/odb/index.ts src/index.ts`
> 如果这些文件中任何一个在计划编写后发生了变化，先对比 "Current state" 摘录与当前代码；不一致则 STOP。

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none（但建议在 Plan 003/004 测试补充后执行）
- **Category**: tech-debt
- **Planned at**: commit `8897004`, 2026-06-22

## Why this matters

[AGENTS.md](AGENTS.md#L37) 明确要求「无 class：全部使用工厂函数 + 对象字面量模式（`createXxx`）」。但 pack 模块中有 4 个文件使用 `class` 声明：`PackBuilder`、`PackIndexReader`、`PackIndexWriter`、`PackObjectStore`。本计划将这些 class 转换为工厂函数 + 接口模式，与项目规范对齐。

**策略**：逐个转换，每步独立验证。转换顺序为——

1. `PackIndexWriter`（最简单，无内部依赖）+ 同步修改 `PackBuilder` 中的引用
2. `PackIndexReader`（构造逻辑集中在 constructor）+ 同步修改 `pack-store-types.ts`、`pack-store-loader.ts` 中的引用
3. `PackBuilder`（已在步骤 1 中修复了它对 `PackIndexWriter` 的引用）
4. `PackObjectStore`
5. 修复所有 re-export 链中的 `verbatimModuleSyntax` 兼容性

## Current state

4 个 class 及受影响的调用方文件：

### 1. `PackBuilder` — [pack-builder.ts](src/odb/pack/pack-builder.ts)

```ts
// line 23 — 当前用 value import 引入 PackIndexWriter（verbatimModuleSyntax 下，class 可作值导入）
import { PackIndexWriter } from "./pack-index.ts";

// line 53-55 — 已有工厂函数封装
export function createPackBuilder(gitDir: string): PackBuilder {
  return new PackBuilder(gitDir);
}

// line 60-136 — class 定义
export class PackBuilder {
  private readonly gitDir: string;
  private readonly objects: EncodedPackObject[] = [];
  private readonly hashes: Set<SHA1> = new Set();

  constructor(gitDir: string) { this.gitDir = gitDir; }

  addObject(obj: GitObject): SHA1 { ... }    // 去重，push 到 this.objects
  get objectCount(): number { return this.objects.length; }
  build(): PackBuildResult {
    // 关键行 — line 114: 直接 new PackIndexWriter()
    const idxWriter = new PackIndexWriter();
    for (const entry of encoded.entries) { idxWriter.addEntry(entry); }
    const idxData = idxWriter.build(encoded.packChecksum);
    ...
  }
}
```

### 2. `PackIndexReader` — [pack-index-reader.ts](src/odb/pack/pack-index-reader.ts)

```ts
// line 29-31 — 已有工厂函数封装
export function createPackIndexReader(data: Buffer): PackIndexReader {
  return new PackIndexReader(data);
}

// line 36-181 — class 定义
export class PackIndexReader {
  private readonly data: Buffer;
  private readonly _objectCount: number;
  private readonly fanout: number[];
  private readonly sha1TableOffset: number;
  private readonly crc32TableOffset: number;
  private readonly offsetTableOffset: number;
  private readonly largeOffsetTable: number;

  constructor(data: Buffer) {
    this.data = data;
    this.fanout = [];
    this.parseHeader();
    this.parseFanout();
    this._objectCount = this.fanout[255]!;
    // ...计算各种 offset
  }

  get objectCount(): number { return this._objectCount; }
  lookup(hash: SHA1): PackIndexEntry | undefined { ... }   // 二分查找
  has(hash: SHA1): boolean { return this.lookup(hash) !== undefined; }
  listHashes(): SHA1[] { ... }

  private parseHeader(): void { ... }   // 校验签名和版本
  private parseFanout(): void { ... }   // 解析 256 项扇出表
  private getHashAt(index: number): string { ... }
  private getEntryAt(index: number): PackIndexEntry { ... }  // 解析偏移量和大偏移量
}
```

### 3. `PackIndexWriter` — [pack-index-writer.ts](src/odb/pack/pack-index-writer.ts)

```ts
// line 27-29 — 已有工厂函数封装
export function createPackIndexWriter(): PackIndexWriter {
  return new PackIndexWriter();
}

// line 34-168 — class 定义
export class PackIndexWriter {
  private entries: PackIndexEntry[] = [];

  addEntry(entry: PackIndexEntry): void { this.entries.push(entry); }
  build(packChecksum: Buffer): Buffer { ... }  // 排序 + 构建 .idx 二进制

  private createHeader(): Buffer { ... }
  private createFanoutTable(entries: PackIndexEntry[]): Buffer { ... }
  private createSha1Table(entries: PackIndexEntry[]): Buffer { ... }
  private createCrc32Table(entries: PackIndexEntry[]): Buffer { ... }
  private createOffsetTables(entries: PackIndexEntry[]): { offsetTable: Buffer; largeOffsets: number[] } { ... }
  private createLargeOffsetTable(largeOffsets: number[]): Buffer { ... }
  // 注意：这 6 个 private 方法接收 entries 参数（不直接读 this.entries），转换为独立函数时无需任何修改
}
```

### 4. `PackObjectStore` — [pack-store.ts](src/odb/pack/pack-store.ts)

```ts
// line 58-60
export function createPackObjectStore(gitDir: string): PackObjectStore {
  return new PackObjectStore(gitDir);
}

// line 65-175
export class PackObjectStore implements ObjectSource {
  private readonly packDir: string;
  private readonly pairs: PackPair[] = [];
  private loaded = false;

  constructor(gitDir: string) { this.packDir = join(gitDir, "objects", "pack"); }

  refresh(): void { this.loaded = false; this.pairs.length = 0; }
  private ensureLoaded(): void { ... }
  read(hash: SHA1): GitObject { ... }
  exists(hash: SHA1): boolean { ... }
  list(): SHA1[] { ... }
  listHashes(): SHA1[] { return this.list(); }
  listPacks(): PackFileInfo[] { ... }
  get packCount(): number { ... }
  get objectCount(): number { ... }
}
```

### 5. 受影响的调用方

**[pack-store-loader.ts:8,46-51](src/odb/pack/pack-store-loader.ts#L8)**

```ts
import { PackIndexReader } from "./pack-index.ts"; // 需要改为 import type + import create
// ...
pairs.push({
  checksum,
  index: new PackIndexReader(idxData), // 需要改为 createPackIndexReader(idxData)
  reader: null,
  packData: null,
});
```

**[pack-store-types.ts:5](src/odb/pack/pack-store-types.ts#L5)**

```ts
import { PackIndexReader } from "./pack-index.ts"; // 仅用作类型，改为 import type
export interface PackPair {
  index: PackIndexReader; // 类型位置，不改
  // ...
}
```

**[pack-builder.ts:23,114](src/odb/pack/pack-builder.ts#L23)**

```ts
import { PackIndexWriter } from "./pack-index.ts"; // 需改为 import { createPackIndexWriter, type PackIndexWriter }
// ...
const idxWriter = new PackIndexWriter(); // 需改为 createPackIndexWriter()
```

### 6. Re-export 链（verbatimModuleSyntax 下 class→interface 后必须改）

[pack/index.ts:51-59](src/odb/pack/index.ts#L51-L59) — 项目内 re-export：

```ts
export {
  createPackIndexReader,
  createPackIndexWriter,
  PackIndexReader,
  PackIndexWriter,
} from "./pack-index.ts";
export { createPackObjectStore, PackObjectStore } from "./pack-store.ts";
export { createPackBuilder, PackBuilder } from "./pack-builder.ts";
```

`PackIndexReader/Writer` 变 interface 后，不能作为 runtime value 再导出。需拆分为 `export { create... }` + `export type { ... }`。

[odb/index.ts:41-50](src/odb/index.ts#L41-L50) — 聚合 re-export：

```ts
export {
  createPackIndexReader,
  createPackIndexWriter,
  PackIndexReader,
  PackIndexWriter,
  createPackObjectStore,
  PackObjectStore,
  createPackBuilder,
  PackBuilder,
} from "./pack/index.ts";
```

同样需要拆分 type-only 名称。

[src/index.ts:140-154](src/src/index.ts#L140-L154) — 公共 API：

```ts
export {
  createPackIndexReader,
  createPackIndexWriter,
  PackIndexReader,
  PackIndexWriter,
  createPackObjectStore,
  PackObjectStore,
  createPackBuilder,
  PackBuilder,
  type PackBuildResult,
} from "./odb/index.ts";
```

`PackIndexReader/Writer/Build/Store` 全部改为 `type` 前缀。

### 项目约定（来自 AGENTS.md）

- "无 class"：全部工厂函数 + 对象字面量模式
- 类型定义通过 `interface` 导出，在 re-export 中用 `export type { ... }` 或 `type Xxx` 前缀
- `// ====` 分区隔符
- JSDoc 使用中文，含 `@example`
- `verbatimModuleSyntax: true` — runtime value 与 type 的导入/导出必须明确分离

### 已有测试文件

全部从 `@/odb/pack/...` 导入 factory 函数（非直接 import class）：

- `tests/units/odb/pack/pack-builder.test.ts` — 29 个测试中的 4 个
- `tests/units/odb/pack/pack-index.test.ts` — 2 个
- `tests/units/odb/pack/packfile.test.ts` — 5 个（测试 PackReader/Writer，不在 scope）
- `tests/units/odb/pack/pack-store.test.ts` — 4 个
- `tests/units/odb/pack/composite-store.test.ts` — 5 个

## Commands you will need

| Purpose      | Command                          | Expected on success   |
| ------------ | -------------------------------- | --------------------- |
| Install      | `bun install`                    | exit 0                |
| Pack tests   | `bun test tests/units/odb/pack/` | 29 pass, 0 fail       |
| Full tests   | `bun test tests/units/`          | all pass              |
| Lint         | `bun run lint`                   | exit 0                |
| Format check | `bun run format:check`           | exit 0                |
| Verify scope | `git diff --name-only`           | 仅列出 scope 内的文件 |

## Scope

**In scope**:

- `src/odb/pack/pack-index-writer.ts` — 重构 class → 工厂函数 + interface
- `src/odb/pack/pack-index-reader.ts` — 重构 class → 工厂函数 + interface
- `src/odb/pack/pack-builder.ts` — 重构 class → 工厂函数 + interface
- `src/odb/pack/pack-store.ts` — 重构 class → 工厂函数 + interface
- `src/odb/pack/pack-store-loader.ts` — 修改 `new PackIndexReader()` 为 `createPackIndexReader()`、改 import
- `src/odb/pack/pack-store-types.ts` — 改 `import { PackIndexReader }` 为 `import type { PackIndexReader }`
- `src/odb/pack/index.ts` — 拆分 re-export（value vs type）
- `src/odb/index.ts` — 拆分 re-export
- `src/index.ts` — 拆分 re-export

**Out of scope**:

- 任何测试文件（重构不改变外部行为，测试无需修改）
- `pack-reader.ts`、`pack-writer.ts`、`composite-store.ts` — 这些也使用 class，但留待后续 plan 处理（它们更复杂且有更多调用方）
- `src/repository/backend/types.ts` — 已用 `import type { PackBuilder, PackObjectStore }`，无需修改
- `src/repository/backend/file-backend.ts` — 已用 `createPackBuilder()` 和 `createPackObjectStore()` 工厂函数，无需修改

## Steps

### Step 1: `PackIndexWriter` class → 工厂函数 + 更新 `PackBuilder` 中的引用

`PackIndexWriter` 转换是最简单的——其 6 个 private 方法都以 `entries` 为参数（不引用 `this`），转换为闭包中的独立函数时无需任何修改。只需：

1. 删掉 `export class PackIndexWriter`，用 `export interface PackIndexWriter` 替代
2. 删掉 `constructor`（不再需要，空数组在闭包中直接初始化）
3. 删掉 `private` 声明
4. 删掉 `createPackIndexWriter(): PackIndexWriter` 中的 `return new PackIndexWriter()`
5. 将实现体移到闭包中，返回对象字面量
6. 修改 `pack-builder.ts`：import 改为 `{ createPackIndexWriter, type PackIndexWriter }`，`new PackIndexWriter()` 改为 `createPackIndexWriter()`

**pack-index-writer.ts** 完整新代码：

````ts
/**
 * Packfile 索引写入
 */

import { createHash } from "node:crypto";

import {
  IDX_V2_FANOUT_SIZE,
  IDX_V2_HEADER_SIZE,
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
} from "./constants.ts";

import type { PackIndexEntry } from "./pack-index-types.ts";

// ============================================================================
// Packfile 索引写入器接口
// ============================================================================

/**
 * Packfile 索引写入器接口
 */
export interface PackIndexWriter {
  /**
   * 添加一个索引条目
   *
   * @param entry - 索引条目
   */
  addEntry(entry: PackIndexEntry): void;

  /**
   * 构建索引文件数据
   *
   * @param packChecksum - packfile 的 SHA-1 校验和（20 字节）
   * @returns 完整的 .idx 文件数据
   */
  build(packChecksum: Buffer): Buffer;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Packfile 索引写入器
 *
 * @returns 索引写入器实例
 *
 * @example
 * ```ts
 * const writer = createPackIndexWriter();
 * writer.addEntry({ hash, offset: 12, crc32: 0x12345678 });
 * ```
 */
export function createPackIndexWriter(): PackIndexWriter {
  const entries: PackIndexEntry[] = [];

  function createHeader(): Buffer {
    const header = Buffer.alloc(IDX_V2_HEADER_SIZE);
    IDX_V2_SIGNATURE.copy(header, 0);
    header.writeUInt32BE(IDX_V2_VERSION, 4);
    return header;
  }

  function createFanoutTable(sorted: PackIndexEntry[]): Buffer {
    const fanout = Buffer.alloc(IDX_V2_FANOUT_SIZE);
    let count = 0;

    for (let i = 0; i < 256; i++) {
      while (count < sorted.length && parseInt(sorted[count]!.hash.slice(0, 2), 16) <= i) {
        count++;
      }
      fanout.writeUInt32BE(count, i * 4);
    }

    return fanout;
  }

  function createSha1Table(sorted: PackIndexEntry[]): Buffer {
    const sha1Table = Buffer.alloc(sorted.length * 20);
    for (let i = 0; i < sorted.length; i++) {
      Buffer.from(sorted[i]!.hash, "hex").copy(sha1Table, i * 20);
    }
    return sha1Table;
  }

  function createCrc32Table(sorted: PackIndexEntry[]): Buffer {
    const crc32Table = Buffer.alloc(sorted.length * 4);
    for (let i = 0; i < sorted.length; i++) {
      crc32Table.writeUInt32BE(sorted[i]!.crc32 >>> 0, i * 4);
    }
    return crc32Table;
  }

  function createOffsetTables(sorted: PackIndexEntry[]): {
    offsetTable: Buffer;
    largeOffsets: number[];
  } {
    const offsetTable = Buffer.alloc(sorted.length * 4);
    const largeOffsets: number[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const offset = sorted[i]!.offset;
      if (offset >= 0x80000000) {
        const largeIndex = largeOffsets.length;
        largeOffsets.push(offset);
        offsetTable.writeUInt32BE(0x80000000 | largeIndex, i * 4);
      } else {
        offsetTable.writeUInt32BE(offset, i * 4);
      }
    }

    return { offsetTable, largeOffsets };
  }

  function createLargeOffsetTable(largeOffsets: number[]): Buffer {
    const largeOffsetTable = Buffer.alloc(largeOffsets.length * 8);
    for (let i = 0; i < largeOffsets.length; i++) {
      largeOffsetTable.writeBigUInt64BE(BigInt(largeOffsets[i]!), i * 8);
    }
    return largeOffsetTable;
  }

  function addEntry(entry: PackIndexEntry): void {
    entries.push(entry);
  }

  function build(packChecksum: Buffer): Buffer {
    const sorted = [...entries].sort((a, b) => a.hash.localeCompare(b.hash));
    const parts: Buffer[] = [];

    parts.push(createHeader());
    parts.push(createFanoutTable(sorted));
    parts.push(createSha1Table(sorted));
    parts.push(createCrc32Table(sorted));

    const { offsetTable, largeOffsets } = createOffsetTables(sorted);
    parts.push(offsetTable);

    if (largeOffsets.length > 0) {
      parts.push(createLargeOffsetTable(largeOffsets));
    }

    parts.push(packChecksum);

    const idxWithoutChecksum = Buffer.concat(parts);
    const idxChecksum = createHash("sha1").update(idxWithoutChecksum).digest();
    return Buffer.concat([idxWithoutChecksum, idxChecksum]);
  }

  return { addEntry, build };
}
````

**pack-builder.ts 修改（仅第 23 行和第 114 行）**：

- 第 23 行：`import { PackIndexWriter } from "./pack-index.ts";` →
  `import { createPackIndexWriter, type PackIndexWriter } from "./pack-index.ts";`
- 第 114 行：`const idxWriter = new PackIndexWriter();` →
  `const idxWriter = createPackIndexWriter();`

**Verify**: `bun test tests/units/odb/pack/pack-index.test.ts tests/units/odb/pack/pack-builder.test.ts` → 全部通过。

### Step 2: `PackIndexReader` class → 工厂函数 + 更新调用方

`PackIndexReader` 是最复杂的转换。所有 `private readonly` 字段变为闭包 `const`，`parseHeader()` / `parseFanout()` 逻辑内联到工厂函数体中，private 方法变为内部函数。

**闭包变量重命名表**（所有 `this.X` 引用需统一替换）：

| 旧引用                   | 新引用              | 说明             |
| ------------------------ | ------------------- | ---------------- |
| `this.data`              | `data`              | 参数，不变       |
| `this._objectCount`      | `_objectCount`      | 闭包 const       |
| `this.fanout`            | `fanout`            | 闭包 const       |
| `this.sha1TableOffset`   | `sha1TableOffset`   | 闭包 const       |
| `this.crc32TableOffset`  | `crc32TableOffset`  | 闭包 const       |
| `this.offsetTableOffset` | `offsetTableOffset` | 闭包 const       |
| `this.largeOffsetTable`  | `largeOffsetTable`  | 闭包 const       |
| `this.parseHeader()`     | 内联到工厂函数中    | 不再作为方法调用 |
| `this.parseFanout()`     | 内联到工厂函数中    | 不再作为方法调用 |
| `this.getHashAt(i)`      | `getHashAt(i)`      | 内部函数         |
| `this.getEntryAt(i)`     | `getEntryAt(i)`     | 内部函数         |

**pack-index-reader.ts** 完整新代码：

````ts
/**
 * Packfile 索引读取
 */

import { PackIndexError } from "../../core/errors.ts";
import { sha1 } from "../../core/types.ts";
import {
  IDX_V2_FANOUT_SIZE,
  IDX_V2_HEADER_SIZE,
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
} from "./constants.ts";

import type { SHA1 } from "../../core/types.ts";
import type { PackIndexEntry } from "./pack-index-types.ts";

// ============================================================================
// Packfile 索引读取器接口
// ============================================================================

/**
 * Packfile 索引读取器接口
 */
export interface PackIndexReader {
  /** 对象数量 */
  readonly objectCount: number;

  /**
   * 查找对象的索引条目
   *
   * @param hash - 对象的 SHA-1 哈希
   * @returns 索引条目，如果不存在则返回 undefined
   */
  lookup(hash: SHA1): PackIndexEntry | undefined;

  /**
   * 检查对象是否存在
   */
  has(hash: SHA1): boolean;

  /**
   * 获取所有对象的哈希列表
   */
  listHashes(): SHA1[];
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Packfile 索引读取器
 *
 * @param data - 完整的 .idx 文件数据
 * @returns 索引读取器实例
 *
 * @example
 * ```ts
 * const index = createPackIndexReader(idxData);
 * console.log(index.objectCount);
 * ```
 */
export function createPackIndexReader(data: Buffer): PackIndexReader {
  // ---- 校验头部 ----
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

  // ---- 解析扇出表 ----
  const fanout: number[] = [];
  const fanoutStart = IDX_V2_HEADER_SIZE;
  for (let i = 0; i < 256; i++) {
    fanout.push(data.readUInt32BE(fanoutStart + i * 4));
  }

  // ---- 计算各表偏移量 ----
  const _objectCount = fanout[255]!;
  const sha1TableOffset = IDX_V2_HEADER_SIZE + IDX_V2_FANOUT_SIZE;
  const crc32TableOffset = sha1TableOffset + _objectCount * 20;
  const offsetTableOffset = crc32TableOffset + _objectCount * 4;
  const largeOffsetTable = offsetTableOffset + _objectCount * 4;

  // ---- 内部辅助函数 ----
  function getHashAt(index: number): string {
    const offset = sha1TableOffset + index * 20;
    return data.subarray(offset, offset + 20).toString("hex");
  }

  function getEntryAt(index: number): PackIndexEntry {
    const hash = sha1(getHashAt(index));
    const crc32 = data.readUInt32BE(crc32TableOffset + index * 4);

    let offset = data.readUInt32BE(offsetTableOffset + index * 4);
    if (offset & 0x80000000) {
      const largeIndex = offset & 0x7fffffff;
      offset = Number(data.readBigUInt64BE(largeOffsetTable + largeIndex * 8));
    }

    return { hash, offset, crc32 };
  }

  // ---- 公共方法 ----
  function lookup(hash: SHA1): PackIndexEntry | undefined {
    const firstByte = parseInt(hash.slice(0, 2), 16);
    const start = firstByte > 0 ? fanout[firstByte - 1]! : 0;
    const end = fanout[firstByte]!;

    let low = start;
    let high = end;

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

  function has(hash: SHA1): boolean {
    return lookup(hash) !== undefined;
  }

  function listHashes(): SHA1[] {
    const hashes: SHA1[] = [];
    for (let i = 0; i < _objectCount; i++) {
      hashes.push(sha1(getHashAt(i)));
    }
    return hashes;
  }

  // ---- 返回对象字面量 ----
  return {
    get objectCount(): number {
      return _objectCount;
    },
    lookup,
    has,
    listHashes,
  };
}
````

**pack-store-types.ts 修改**：

第 5 行：`import { PackIndexReader } from "./pack-index.ts";` →
`import type { PackIndexReader } from "./pack-index.ts";`
（`PackPair.index` 字段只用 `PackIndexReader` 作类型标注，非运行时使用）

**pack-store-loader.ts 修改**：

1. 第 8 行 import 改为：
   ```ts
   import { createPackIndexReader, type PackIndexReader } from "./pack-index.ts";
   ```
2. 第 48 行：`index: new PackIndexReader(idxData),` →
   `index: createPackIndexReader(idxData),`

**Verify**: `bun test tests/units/odb/pack/pack-index.test.ts tests/units/odb/pack/packfile.test.ts tests/units/odb/pack/pack-store.test.ts tests/units/odb/pack/composite-store.test.ts` → 全部通过。

### Step 3: `PackBuilder` class → 工厂函数

`PackBuilder` 在第 1 步中已经把对 `PackIndexWriter` 的引用改为了 `createPackIndexWriter()`。现在完成 class 本身的转换。

**闭包变量重命名表**：

| 旧引用         | 新引用    | 说明         |
| -------------- | --------- | ------------ |
| `this.gitDir`  | `gitDir`  | 参数，不变   |
| `this.objects` | `objects` | 闭包 `const` |
| `this.hashes`  | `hashes`  | 闭包 `const` |

**pack-builder.ts** 完整新代码：

````ts
/**
 * Packfile 构建器
 *
 * 将 loose objects 打包成新的 packfile 和索引文件，
 * 并写入到 .git/objects/pack/ 目录。
 *
 * 这是 `git repack` 和 `git gc` 的核心功能。
 *
 * @example
 * ```ts
 * const builder = createPackBuilder(gitDir);
 * builder.addObject(blob);
 * builder.addObject(commit);
 * const result = builder.build();
 * // result => { packPath, idxPath, checksum, objectCount }
 * ```
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { buildEncodedPack, type EncodedPackObject, toEncodedPackObject } from "./pack-encoding.ts";
import { createPackIndexWriter, type PackIndexWriter } from "./pack-index.ts";

import type { GitObject, SHA1 } from "../../core/types.ts";
import type { PackBuildResult } from "./pack-builder-types.ts";

export type { PackBuildResult } from "./pack-builder-types.ts";

// ============================================================================
// Packfile 构建器接口
// ============================================================================

/**
 * Packfile 构建器接口
 */
export interface PackBuilder {
  /** 已添加的对象数量 */
  readonly objectCount: number;

  /**
   * 添加一个 Git 对象
   *
   * @param obj - Git 对象
   * @returns 对象的 SHA-1 哈希
   */
  addObject(obj: GitObject): SHA1;

  /**
   * 构建 packfile 和索引文件
   *
   * @returns 构建结果，包含文件路径和校验和
   */
  build(): PackBuildResult;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Packfile 构建器
 *
 * @param gitDir - .git 目录的路径
 * @returns Packfile 构建器实例
 *
 * @example
 * ```ts
 * const builder = createPackBuilder("/path/to/.git");
 *
 * // 添加对象
 * builder.addObject({ type: "blob", content: Buffer.from("hello") });
 * builder.addObject({ type: "blob", content: Buffer.from("world") });
 *
 * // 构建并写入
 * const result = builder.build();
 * console.log(`已打包 ${result.objectCount} 个对象到 ${result.packPath}`);
 * ```
 */
export function createPackBuilder(gitDir: string): PackBuilder {
  const objects: EncodedPackObject[] = [];
  const hashes: Set<SHA1> = new Set();

  function addObject(obj: GitObject): SHA1 {
    const entry = toEncodedPackObject(obj);
    const hash = entry.hash;

    if (hashes.has(hash)) {
      return hash;
    }

    objects.push(entry);
    hashes.add(hash);
    return hash;
  }

  function build(): PackBuildResult {
    const packDir = join(gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });

    const encoded = buildEncodedPack(objects);

    // 构建索引文件
    const idxWriter = createPackIndexWriter();
    for (const entry of encoded.entries) {
      idxWriter.addEntry(entry);
    }
    const idxData = idxWriter.build(encoded.packChecksum);

    // 生成文件名
    const checksumHex = encoded.packChecksum.toString("hex");
    const packPath = join(packDir, `pack-${checksumHex}.pack`);
    const idxPath = join(packDir, `pack-${checksumHex}.idx`);

    // 写入文件
    writeFileSync(packPath, encoded.packData);
    writeFileSync(idxPath, idxData);

    return {
      packPath,
      idxPath,
      checksum: checksumHex,
      objectCount: objects.length,
    };
  }

  return {
    get objectCount(): number {
      return objects.length;
    },
    addObject,
    build,
  };
}
````

**Verify**: `bun test tests/units/odb/pack/pack-builder.test.ts tests/units/odb/pack/pack-store.test.ts tests/units/odb/pack/composite-store.test.ts` → 全部通过。

### Step 4: `PackObjectStore` class → 工厂函数

**闭包变量重命名表**：

| 旧引用         | 新引用    | 说明                                                    |
| -------------- | --------- | ------------------------------------------------------- |
| `this.packDir` | `packDir` | 闭包 const                                              |
| `this.pairs`   | `pairs`   | 闭包 `const`（引用不变，仍可 `.push()`、`.length = 0`） |
| `this.loaded`  | `loaded`  | 闭包 `let`（`refresh()` 重置为 `false`）                |

**pack-store.ts** 完整新代码：

````ts
/**
 * 基于 Packfile 的对象存储
 *
 * 从 .git/objects/pack/ 目录中读取 packfile 和索引文件，
 * 提供只读的对象读取接口。
 *
 * Git 的 pack 目录结构：
 * - pack-<checksum>.pack  — 打包的对象数据
 * - pack-<checksum>.idx   — 对应的索引文件
 *
 * 写入操作不支持（packfile 是只读的），
 * 新对象应写入 loose objects 或创建新的 packfile。
 *
 * @example
 * ```ts
 * const store = createPackObjectStore("/path/to/.git");
 * const obj = store.read(hash);
 * ```
 */

import { join } from "node:path";

import { ObjectNotFoundError } from "../../core/errors.ts";
import { getPackReader, loadPackPairs, toPackFileInfo } from "./pack-store-loader.ts";

import type { GitObject, SHA1 } from "../../core/types.ts";
import type { ObjectSource } from "../types.ts";
import type { PackFileInfo, PackPair } from "./pack-store-types.ts";

export type { PackFileInfo } from "./pack-store-types.ts";

// ============================================================================
// Pack 对象存储接口
// ============================================================================

/**
 * 基于 Packfile 的对象存储接口
 *
 * 扩展 ObjectSource，增加 pack 目录扫描和刷新能力。
 */
export interface PackObjectStore extends ObjectSource {
  /** 刷新 pack 目录缓存 */
  refresh(): void;

  /** 列出当前可见的 pack 文件对 */
  listPacks(): PackFileInfo[];

  /** packfile 数量 */
  readonly packCount: number;

  /** 所有 packfile 中的对象总数 */
  readonly objectCount: number;

  /**
   * 获取所有 packfile 中的对象哈希列表
   *
   * 保留此方法作为更明确的命名别名。
   */
  listHashes(): SHA1[];
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建基于 Packfile 的对象存储
 *
 * 扫描 .git/objects/pack/ 目录，加载所有 .idx 文件。
 * packfile 数据按需加载（首次读取时才加载）。
 *
 * @param gitDir - .git 目录的路径
 * @returns 基于 Packfile 的对象存储
 *
 * @example
 * ```ts
 * const store = createPackObjectStore("/path/to/.git");
 *
 * // 读取对象
 * const obj = store.read(hash);
 *
 * // 检查对象是否存在
 * if (store.exists(hash)) {
 *   console.log("对象在 packfile 中");
 * }
 * ```
 */
export function createPackObjectStore(gitDir: string): PackObjectStore {
  const packDir = join(gitDir, "objects", "pack");
  const pairs: PackPair[] = [];
  let loaded = false;

  function ensureLoaded(): void {
    if (loaded) return;
    loaded = true;
    pairs.push(...loadPackPairs(packDir));
  }

  function read(hash: SHA1): GitObject {
    ensureLoaded();

    for (const pair of pairs) {
      const entry = pair.index.lookup(hash);
      if (entry) {
        const reader = getPackReader(packDir, pair);
        const obj = reader.readObject(hash);
        if (obj) return obj;
      }
    }

    throw new ObjectNotFoundError(hash);
  }

  function exists(hash: SHA1): boolean {
    ensureLoaded();

    for (const pair of pairs) {
      if (pair.index.has(hash)) return true;
    }

    return false;
  }

  function list(): SHA1[] {
    ensureLoaded();

    const hashes: SHA1[] = [];
    for (const pair of pairs) {
      hashes.push(...pair.index.listHashes());
    }
    return hashes;
  }

  function listHashes(): SHA1[] {
    return list();
  }

  function listPacks(): PackFileInfo[] {
    ensureLoaded();
    return pairs.map((pair) => toPackFileInfo(packDir, pair));
  }

  function refresh(): void {
    loaded = false;
    pairs.length = 0;
  }

  return {
    read,
    exists,
    list,
    listHashes,
    listPacks,
    refresh,
    get packCount(): number {
      ensureLoaded();
      return pairs.length;
    },
    get objectCount(): number {
      ensureLoaded();
      let count = 0;
      for (const pair of pairs) {
        count += pair.index.objectCount;
      }
      return count;
    },
  };
}
````

**Verify**: `bun test tests/units/odb/pack/pack-store.test.ts tests/units/odb/pack/composite-store.test.ts` → 全部通过。

### Step 5: 修复 re-export 链

四级 re-export 链需要拆分——`PackIndexReader`、`PackIndexWriter`、`PackBuilder`、`PackObjectStore` 现在是 interface（type-only），不能作为 runtime value 再导出。

**pack/index.ts** 修改：

原来的 51-59 行改为：

```ts
// line 49-50: PackReader 仍是 class，保持不变
export { createPackReader, PackReader } from "./pack-reader.ts";
export { createPackWriter, PackWriter } from "./pack-writer.ts";

// line 51-56: 索引模块——拆分为 value + type
export { createPackIndexReader, createPackIndexWriter } from "./pack-index.ts";
export type { PackIndexReader, PackIndexWriter } from "./pack-index.ts";

// line 57: PackObjectStore——拆分为 value + type
export { createPackObjectStore } from "./pack-store.ts";
export type { PackObjectStore } from "./pack-store.ts";

// line 58: CompositeObjectStore 仍是 class，保持不变
export { createCompositeObjectStore, CompositeObjectStore } from "./composite-store.ts";

// line 59: PackBuilder——拆分为 value + type
export { createPackBuilder } from "./pack-builder.ts";
export type { PackBuilder } from "./pack-builder.ts";
```

**odb/index.ts** 修改：

把 41-50 行的单个 `export { ... }` block 拆分为两个：

```ts
// 原有的 value 导出（保留）
export {
  OBJ_COMMIT,
  OBJ_TREE,
  OBJ_BLOB,
  OBJ_TAG,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  PACK_SIGNATURE,
  PACK_VERSION,
  PACK_HEADER_SIZE,
  PACK_CHECKSUM_SIZE,
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
  objectTypeToNumber,
  numberToObjectType,
  isDeltaType,
  decodeObjectHeader,
  encodeObjectHeader,
  decodeOfsDeltaOffset,
  encodeOfsDeltaOffset,
  decodeVarint,
  encodeVarint,
  applyDelta,
  createDelta,
  createPackReader,
  PackReader,
  createPackWriter,
  PackWriter,
  createPackIndexReader,
  createPackIndexWriter,
  createPackObjectStore,
  createCompositeObjectStore,
  CompositeObjectStore,
  createPackBuilder,
} from "./pack/index.ts";

// 新增：type-only 导出
export type {
  PackIndexReader,
  PackIndexWriter,
  PackObjectStore,
  PackBuilder,
} from "./pack/index.ts";
```

**src/index.ts** 修改：

119-156 行的 `export { ... }` block 中，将 `PackIndexReader`、`PackIndexWriter`、`PackObjectStore`、`PackBuilder` 改为带 `type` 前缀：

```ts
export {
  // 常量和工具
  OBJ_COMMIT,
  OBJ_TREE,
  OBJ_BLOB,
  OBJ_TAG,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  objectTypeToNumber,
  numberToObjectType,
  isDeltaType,
  // Delta 编解码
  applyDelta,
  createDelta,
  // Packfile 读取
  createPackReader,
  PackReader,
  type PackObject,
  // Packfile 写入
  createPackWriter,
  PackWriter,
  // Packfile 索引
  createPackIndexReader,
  createPackIndexWriter,
  type PackIndexReader, // ← 原来是 PackIndexReader（无 type）
  type PackIndexWriter, // ← 原来是 PackIndexWriter（无 type）
  type PackIndexEntry,
  // Packfile 存储
  createPackObjectStore,
  type PackObjectStore, // ← 原来是 PackObjectStore（无 type）
  // 组合存储
  createCompositeObjectStore,
  CompositeObjectStore,
  // Packfile 构建器
  createPackBuilder,
  type PackBuilder, // ← 原来是 PackBuilder（无 type）
  type PackBuildResult,
} from "./odb/index.ts";
```

**Verify**: `bun run lint` → exit 0（`verbatimModuleSyntax` 检查通过）。

### Step 6: 运行全部测试和格式检查

```bash
bun test tests/units/
bun run lint
bun run format:check
```

**Verify**: 全部测试通过，lint 无错误，格式检查通过。

## Test plan

已有 29 个测试通过所有步骤验证。重构后这些测试应保持通过，无需新增测试。

### 手动功能测试（可选）

可以用 demo 脚本端到端验证：

```bash
bun run examples/demo.ts
```

## Done criteria

- [ ] `bun test tests/units/odb/pack/` — 29 pass, 0 fail
- [ ] `bun test tests/units/` — all pass
- [ ] `bun run lint` — exit 0（`verbatimModuleSyntax` 无错误）
- [ ] `bun run format:check` — exit 0
- [ ] 仅 scope 内的文件被修改（`git diff --name-only` 确认）
- [ ] `plans/README.md` 状态行更新为 DONE

## STOP conditions

- 任何步骤的验证在两次合理修复尝试后仍失败 → 停止并报告，说明失败步骤和错误信息
- 需要修改任何测试文件才能通过测试 → 停止（重构不应改变外部行为）
- `git diff --stat 8897004..HEAD` 显示 scope 内文件在计划编写后有变化 → 对比当前代码，不一致则 STOP
- `bun run lint` 报告 verbatimModuleSyntax 相关错误且无法通过修改 re-export 解决 → 停止（可能遗漏了调用方）
- 意外发现 `pack-builder.ts`、`pack-index-reader.ts`、`pack-index-writer.ts`、`pack-store.ts` 以外的文件仍需 import PackIndexReader/PackIndexWriter/PackBuilder/PackObjectStore 作为 value → 停止，这些文件也需要加入 scope

## Maintenance notes

- `PackObjectStore.refresh()` 通过闭包 `pairs.length = 0` 清空数组（`const pairs` 引用不变，仅清空内容）——与 class 版本行为一致。
- `PackIndexReader` 在工厂函数中完成全部计算（替代 constructor），不支持延迟初始化。与 class 版本行为一致。
- `PackIndexWriter` 的 6 个 private 方法以 `entries` 为参数，转换时未修改函数体——将来如果新增直接引用实例状态的方法，需改为闭包引用。
- 将来新的 pack 模块代码应直接使用工厂函数 + 接口模式编写。
- `pack-reader.ts`、`pack-writer.ts`、`composite-store.ts` 仍使用 class，留待后续单独 plan 处理——这些 class 有更多调用方和更复杂的 `implements` 关系。
