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

  test("含 gpgsig 的 tag 往返保持一致", () => {
    const tag: GitTag = {
      type: "tag",
      object: sha1("2222222222222222222222222222222222222222"),
      objectType: "commit",
      tag: "v1.0.0",
      tagger: testAuthor,
      gpgsig: `-----BEGIN PGP SIGNATURE-----\nVersion: GnuPG v1\n\niQEcBAABAgAGBQJ...\n-----END PGP SIGNATURE-----`,
      message: "Signed release",
    };

    const deserialized = deserialize(serialize(tag));
    expect(deserialized.type).toBe("tag");
    if (deserialized.type === "tag") {
      expect(deserialized.object).toBe(tag.object);
      expect(deserialized.gpgsig).toBe(tag.gpgsig);
    }
  });

  test("含 extraHeaders 的 tag 往返保持一致", () => {
    const tag: GitTag = {
      type: "tag",
      object: sha1("3333333333333333333333333333333333333333"),
      objectType: "commit",
      tag: "v2.0.0",
      tagger: testAuthor,
      extraHeaders: [
        { name: "foo", value: "bar" },
        { name: "multiline", value: "line1\nline2" },
      ],
      message: "Tag with extra headers",
    };

    const deserialized = deserialize(serialize(tag));
    expect(deserialized.type).toBe("tag");
    if (deserialized.type === "tag") {
      expect(deserialized.extraHeaders).toEqual(tag.extraHeaders);
    }
  });

  test("含 gpgsig 和 extraHeaders 的 tag 往返保持一致", () => {
    const tag: GitTag = {
      type: "tag",
      object: sha1("4444444444444444444444444444444444444444"),
      objectType: "commit",
      tag: "v3.0.0",
      tagger: testAuthor,
      gpgsig: "-----BEGIN PGP SIGNATURE-----\n\niQEcBAABAgAGBQJ...\n-----END PGP SIGNATURE-----",
      extraHeaders: [{ name: "comment", value: "some comment" }],
      message: "Tag with everything",
    };

    const deserialized = deserialize(serialize(tag));
    expect(deserialized.type).toBe("tag");
    if (deserialized.type === "tag") {
      expect(deserialized.object).toBe(tag.object);
      expect(deserialized.gpgsig).toBe(tag.gpgsig);
      expect(deserialized.extraHeaders).toEqual(tag.extraHeaders);
    }
  });

  test("无 gpgsig/extraHeaders 时输出字段为 undefined", () => {
    const tag: GitTag = {
      type: "tag",
      object: sha1("5555555555555555555555555555555555555555"),
      objectType: "commit",
      tag: "v4.0.0",
      tagger: testAuthor,
      message: "Plain tag",
    };

    const deserialized = deserialize(serialize(tag));
    expect(deserialized.type).toBe("tag");
    if (deserialized.type === "tag") {
      expect(deserialized.gpgsig).toBeUndefined();
      expect(deserialized.extraHeaders).toBeUndefined();
    }
  });
});
