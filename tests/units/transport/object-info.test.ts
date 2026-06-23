/**
 * v2 object-info 解析单元测试
 */

import { describe, test, expect } from "bun:test";

import { parseObjectInfoResponse } from "@/transport/client/upload-pack/object-info.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/protocol/pkt-line.ts";

describe("parseObjectInfoResponse()", () => {
  test("解析单条对象 size", () => {
    const data = Buffer.concat([
      encodePktLine("size\n"),
      encodePktLine("95d09f2b10159347eece71399a7e2e907ea3df4f 42\n"),
      encodeFlushPkt(),
    ]);

    const result = parseObjectInfoResponse(data);

    expect(result.attrs).toEqual(["size"]);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]!.oid).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(result.objects[0]!.size).toBe(42);
  });

  test("解析多条对象 size", () => {
    const data = Buffer.concat([
      encodePktLine("size\n"),
      encodePktLine("95d09f2b10159347eece71399a7e2e907ea3df4f 100\n"),
      encodePktLine("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 200\n"),
      encodeFlushPkt(),
    ]);

    const result = parseObjectInfoResponse(data);

    expect(result.objects).toHaveLength(2);
    expect(result.objects[0]!.size).toBe(100);
    expect(result.objects[1]!.size).toBe(200);
  });

  test("解析空响应", () => {
    const data = Buffer.concat([encodeFlushPkt()]);
    const result = parseObjectInfoResponse(data);
    expect(result.objects).toHaveLength(0);
  });

  test("无 size 字段的场景（仅 oid）", () => {
    const data = Buffer.concat([
      encodePktLine("size\n"),
      encodePktLine("95d09f2b10159347eece71399a7e2e907ea3df4f\n"),
      encodeFlushPkt(),
    ]);

    const result = parseObjectInfoResponse(data);

    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]!.oid).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(result.objects[0]!.size).toBeUndefined();
  });
});
