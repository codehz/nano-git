/**
 * pack/constants.ts 单元测试
 *
 * 覆盖 objectTypeToNumber / numberToObjectType / isDeltaType 及常量
 */

import { describe, test, expect } from "bun:test";

import {
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
  IDX_V2_HEADER_SIZE,
  IDX_V2_FANOUT_SIZE,
  objectTypeToNumber,
  numberToObjectType,
  isDeltaType,
} from "@/pack/constants.ts";

describe("对象类型常量", () => {
  test("OBJ_COMMIT 应为 1", () => expect(OBJ_COMMIT).toBe(1));
  test("OBJ_TREE 应为 2", () => expect(OBJ_TREE).toBe(2));
  test("OBJ_BLOB 应为 3", () => expect(OBJ_BLOB).toBe(3));
  test("OBJ_TAG 应为 4", () => expect(OBJ_TAG).toBe(4));
  test("OBJ_OFS_DELTA 应为 6", () => expect(OBJ_OFS_DELTA).toBe(6));
  test("OBJ_REF_DELTA 应为 7", () => expect(OBJ_REF_DELTA).toBe(7));
});

describe("Packfile 格式常量", () => {
  test("PACK_SIGNATURE 应为 'PACK'", () => {
    expect(PACK_SIGNATURE.toString()).toBe("PACK");
  });
  test("PACK_VERSION 应为 2", () => expect(PACK_VERSION).toBe(2));
  test("PACK_HEADER_SIZE 应为 12", () => expect(PACK_HEADER_SIZE).toBe(12));
  test("PACK_CHECKSUM_SIZE 应为 20", () => expect(PACK_CHECKSUM_SIZE).toBe(20));
});

describe("Index v2 格式常量", () => {
  test("IDX_V2_SIGNATURE 应为 \\xfftOc", () => {
    expect(IDX_V2_SIGNATURE).toEqual(Buffer.from([0xff, 0x74, 0x4f, 0x63]));
  });
  test("IDX_V2_VERSION 应为 2", () => expect(IDX_V2_VERSION).toBe(2));
  test("IDX_V2_HEADER_SIZE 应为 8", () => expect(IDX_V2_HEADER_SIZE).toBe(8));
  test("IDX_V2_FANOUT_SIZE 应为 1024", () => expect(IDX_V2_FANOUT_SIZE).toBe(1024));
});

describe("objectTypeToNumber()", () => {
  test("commit → 1", () => expect(objectTypeToNumber("commit")).toBe(1));
  test("tree → 2", () => expect(objectTypeToNumber("tree")).toBe(2));
  test("blob → 3", () => expect(objectTypeToNumber("blob")).toBe(3));
  test("tag → 4", () => expect(objectTypeToNumber("tag")).toBe(4));
});

describe("numberToObjectType()", () => {
  test("1 → commit", () => expect(numberToObjectType(1)).toBe("commit"));
  test("2 → tree", () => expect(numberToObjectType(2)).toBe("tree"));
  test("3 → blob", () => expect(numberToObjectType(3)).toBe("blob"));
  test("4 → tag", () => expect(numberToObjectType(4)).toBe("tag"));
  test("未知编号抛出异常", () => {
    expect(() => numberToObjectType(5)).toThrow("Unknown object type number: 5");
  });
  test("delta 类型编号抛出异常", () => {
    expect(() => numberToObjectType(6)).toThrow("Unknown object type number: 6");
    expect(() => numberToObjectType(7)).toThrow("Unknown object type number: 7");
  });
  test("负数抛出异常", () => {
    expect(() => numberToObjectType(-1)).toThrow();
  });
});

describe("isDeltaType()", () => {
  test("OBJ_OFS_DELTA (6) 是 delta", () => expect(isDeltaType(6)).toBe(true));
  test("OBJ_REF_DELTA (7) 是 delta", () => expect(isDeltaType(7)).toBe(true));
  test("commit (1) 不是 delta", () => expect(isDeltaType(1)).toBe(false));
  test("tree (2) 不是 delta", () => expect(isDeltaType(2)).toBe(false));
  test("blob (3) 不是 delta", () => expect(isDeltaType(3)).toBe(false));
  test("tag (4) 不是 delta", () => expect(isDeltaType(4)).toBe(false));
  test("未知编号 0 不是 delta", () => expect(isDeltaType(0)).toBe(false));
});
