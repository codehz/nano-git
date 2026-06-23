/**
 * Push packfile 解包（raw-first）
 *
 * 将 receive-pack push 请求中的 packfile 解包，
 * 将对象以 RawGitObject 形式摄入对象数据库，处理 ofs_delta 和 ref_delta。
 *
 * 所有对象按 canonical raw object 直接写入，不经过语义序列化/反序列化。
 */

import { hashObject } from "../../../core/hash.ts";
import { sha1 } from "../../../core/types.ts";
import {
  PACK_HEADER_SIZE,
  PACK_CHECKSUM_SIZE,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  numberToObjectType,
} from "../../../pack/constants.ts";
import { applyDelta } from "../../../pack/delta.ts";
import { readCompressedData, parsePackHeader } from "../../../pack/pack-reader-utils.ts";
import { decodeObjectHeader, decodeOfsDeltaOffset } from "../../../pack/utils.ts";
import { ReceivePackServiceError } from "./types.ts";

import type { ObjectType, RawGitObject } from "../../../core/types.ts";
import type { ObjectDatabase } from "../../../odb/types.ts";

/**
 * 将 push packfile 中的对象解包到对象数据库中
 *
 * 处理非 delta、ofs_delta 和 ref_delta 三种对象类型。
 * 对于 ref_delta，如果 base 不在当前 packfile 中，则从已存在的数据库查找。
 * 所有对象通过 db.ingest() 以 RawGitObject 形式直接写入。
 *
 * @param db - 对象数据库
 * @param packfile - push 请求中的 packfile 数据
 * @throws {ReceivePackServiceError} 当解包失败时
 */
export function unpackPackfile(db: ObjectDatabase, packfile: Buffer): void {
  if (packfile.length < PACK_HEADER_SIZE + PACK_CHECKSUM_SIZE) {
    throw new ReceivePackServiceError("Packfile too small to contain any objects");
  }

  const objectCount = parsePackHeader(packfile);

  if (objectCount === 0) return;

  // 已解析对象缓存：offset → { type, data }（用于 ofs_delta 解析）
  const resolvedByOffset = new Map<number, { type: ObjectType; data: Buffer }>();
  // 已解析对象缓存：hash → { type, data }（用于 ref_delta 解析）
  const resolvedByHash = new Map<string, { type: ObjectType; data: Buffer }>();

  let offset = PACK_HEADER_SIZE;

  for (let i = 0; i < objectCount; i++) {
    const objOffset = offset;
    const [typeNum, , headerBytes] = decodeObjectHeader(packfile, offset);
    offset += headerBytes;

    if (typeNum === OBJ_OFS_DELTA) {
      const [negOffset, offsetBytes] = decodeOfsDeltaOffset(packfile, offset);
      offset += offsetBytes;

      // 读取压缩的 delta 数据
      const [deltaData, compressedBytes] = readCompressedData(packfile, offset);
      offset += compressedBytes;

      // 查找 base 对象
      const baseOffset = objOffset - negOffset;
      const base = resolvedByOffset.get(baseOffset);
      if (!base) {
        throw new ReceivePackServiceError(`ofs_delta base not found at offset ${baseOffset}`);
      }

      // 应用 delta 生成完整内容
      const resolvedData = applyDelta(base.data, deltaData);
      const hash = hashObject(base.type, resolvedData);

      // 直接 ingest raw object
      const raw: RawGitObject = { hash, type: base.type, content: resolvedData };
      db.ingest(raw);

      resolvedByOffset.set(objOffset, { type: base.type, data: resolvedData });
      resolvedByHash.set(hash, { type: base.type, data: resolvedData });
    } else if (typeNum === OBJ_REF_DELTA) {
      const baseHash = packfile.subarray(offset, offset + 20).toString("hex");
      offset += 20;

      // 读取压缩的 delta 数据
      const [deltaData, compressedBytes] = readCompressedData(packfile, offset);
      offset += compressedBytes;

      // 查找 base：先在已解析缓存中查找，再在已有数据库中查找
      let base: { type: ObjectType; data: Buffer } | undefined;
      const cachedBase = resolvedByHash.get(baseHash);

      if (cachedBase) {
        base = cachedBase;
      } else if (db.exists(sha1(baseHash))) {
        // 从已有数据库中直接读取 raw content
        const raw = db.read(sha1(baseHash));
        base = {
          type: raw.type,
          data: raw.content,
        };
      }

      if (!base) {
        throw new ReceivePackServiceError(`ref_delta base not found: ${baseHash}`);
      }

      // 应用 delta
      const resolvedData = applyDelta(base.data, deltaData);
      const resolvedHash = hashObject(base.type, resolvedData);

      // 直接 ingest raw object
      const raw: RawGitObject = { hash: resolvedHash, type: base.type, content: resolvedData };
      db.ingest(raw);

      resolvedByOffset.set(objOffset, { type: base.type, data: resolvedData });
      resolvedByHash.set(resolvedHash, { type: base.type, data: resolvedData });
    } else {
      // 非 delta 对象
      const [compressedData, compressedBytes] = readCompressedData(packfile, offset);
      offset += compressedBytes;

      const type = numberToObjectType(typeNum);
      const hash = hashObject(type, compressedData);

      // 直接 ingest raw object
      const raw: RawGitObject = { hash, type, content: compressedData };
      db.ingest(raw);

      resolvedByOffset.set(objOffset, { type, data: compressedData });
      resolvedByHash.set(hash, { type, data: compressedData });
    }
  }
}
