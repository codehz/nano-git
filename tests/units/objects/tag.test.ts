/**
 * Git Tag 对象序列化/反序列化测试
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { serialize, deserialize } from "@/objects/index.ts";

import type { GitTag, GitAuthor } from "@/core/types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("Tag 序列化", () => {
  test("序列化/反序列化往返保持一致", () => {
    const tag: GitTag = {
      type: "tag",
      object: sha1("1111111111111111111111111111111111111111"),
      objectType: "commit",
      tag: "v1.0.0",
      tagger: testAuthor,
      message: "Release v1.0.0",
    };

    const deserialized = deserialize(serialize(tag));
    expect(deserialized.type).toBe("tag");
    if (deserialized.type === "tag") {
      expect(deserialized.object).toBe(tag.object);
      expect(deserialized.objectType).toBe("commit");
      expect(deserialized.tag).toBe("v1.0.0");
      expect(deserialized.tagger.name).toBe("Test User");
      expect(deserialized.message).toBe("Release v1.0.0");
    }
  });
});
