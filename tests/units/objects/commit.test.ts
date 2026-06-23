/**
 * Git Commit 对象序列化/反序列化测试
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { deserializeCommit, serializeCommit } from "@/objects/commit.ts";
import { serialize, deserialize } from "@/objects/index.ts";

import type { GitCommit, GitAuthor } from "@/core/types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("Commit 序列化", () => {
  test("序列化无父节点的 commit", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("1111111111111111111111111111111111111111"),
      parents: [],
      author: testAuthor,
      committer: testAuthor,
      message: "Initial commit",
    };

    const serialized = serialize(commit);
    const text = serialized.toString("utf-8");

    expect(text).toContain("tree 1111111111111111111111111111111111111111");
    expect(text).toContain("author Test User <test@example.com>");
    expect(text).toContain("committer Test User <test@example.com>");
    expect(text).toContain("Initial commit");
    expect(text).not.toContain("parent");
  });

  test("序列化有父节点的 commit", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("1111111111111111111111111111111111111111"),
      parents: [sha1("2222222222222222222222222222222222222222")],
      author: testAuthor,
      committer: testAuthor,
      message: "Second commit",
    };

    const serialized = serialize(commit);
    const text = serialized.toString("utf-8");
    expect(text).toContain("parent 2222222222222222222222222222222222222222");
  });

  test("序列化 merge commit（多个父节点）", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("1111111111111111111111111111111111111111"),
      parents: [
        sha1("2222222222222222222222222222222222222222"),
        sha1("3333333333333333333333333333333333333333"),
      ],
      author: testAuthor,
      committer: testAuthor,
      message: "Merge branch",
    };

    const serialized = serialize(commit);
    const text = serialized.toString("utf-8");
    expect(text).toContain("parent 2222222222222222222222222222222222222222");
    expect(text).toContain("parent 3333333333333333333333333333333333333333");
  });

  test("序列化/反序列化往返保持一致", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      parents: [sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
      author: {
        name: "Author Name",
        email: "author@example.com",
        timestamp: 1600000000,
        timezone: "+0000",
      },
      committer: {
        name: "Committer Name",
        email: "committer@example.com",
        timestamp: 1600000001,
        timezone: "-0500",
      },
      message: "Test commit message\n\nWith body",
    };

    const deserialized = deserialize(serialize(commit));
    expect(deserialized.type).toBe("commit");
    if (deserialized.type === "commit") {
      expect(deserialized.tree).toBe(commit.tree);
      expect(deserialized.parents).toEqual(commit.parents);
      expect(deserialized.author.name).toBe("Author Name");
      expect(deserialized.author.email).toBe("author@example.com");
      expect(deserialized.author.timestamp).toBe(1600000000);
      expect(deserialized.author.timezone).toBe("+0000");
      expect(deserialized.committer.name).toBe("Committer Name");
      expect(deserialized.message).toBe("Test commit message\n\nWith body");
    }
  });

  test("应解析 gpgsig、mergetag 与自定义 header", () => {
    const raw = Buffer.from(
      [
        "tree be0788944df13c5d170e050f2fe178360c3df5a5",
        "parent 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
        "parent 553c2077f0edc3d5dc5d17262f6aa498e69d6f8e",
        "author The Octocat <support+octocat@github.com> 1525974919 -0500",
        "encoding ISO-8859-1",
        "x-demo alpha",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        " wsBcBAABCAAQBQJa9IeHCRBK7hj4Ov3rIwAAdHIIAAnRg/7YgUcfUSSyF3DD7y9d",
        " =N2y5",
        " -----END PGP SIGNATURE-----",
        "committer GitHub <noreply@github.com> 1525974919 -0500",
        "mergetag object 553c2077f0edc3d5dc5d17262f6aa498e69d6f8e",
        " type commit",
        " tag merged-pr",
        " tagger Merge Bot <merge@example.com> 1234567890 +0000",
        " ",
        " merge tag body",
        "",
        "subject",
        "",
        "body",
        "",
      ].join("\n"),
      "utf-8",
    );

    const commit = deserializeCommit(raw);

    expect(commit.encoding).toBe("ISO-8859-1");
    expect(commit.gpgsig).toBe(
      [
        "-----BEGIN PGP SIGNATURE-----",
        "",
        "wsBcBAABCAAQBQJa9IeHCRBK7hj4Ov3rIwAAdHIIAAnRg/7YgUcfUSSyF3DD7y9d",
        "=N2y5",
        "-----END PGP SIGNATURE-----",
      ].join("\n"),
    );
    expect(commit.mergetag).toEqual([
      [
        "object 553c2077f0edc3d5dc5d17262f6aa498e69d6f8e",
        "type commit",
        "tag merged-pr",
        "tagger Merge Bot <merge@example.com> 1234567890 +0000",
        "",
        "merge tag body",
      ].join("\n"),
    ]);
    expect(commit.extraHeaders).toEqual([{ name: "x-demo", value: "alpha" }]);
    expect(commit.message).toBe("subject\n\nbody");
  });

  test("序列化时应使用稳定 canonical 顺序", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("be0788944df13c5d170e050f2fe178360c3df5a5"),
      parents: [
        sha1("7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"),
        sha1("553c2077f0edc3d5dc5d17262f6aa498e69d6f8e"),
      ],
      author: {
        name: "Alice",
        email: "alice@example.com",
        timestamp: 123,
        timezone: "+0800",
      },
      committer: {
        name: "Bob",
        email: "bob@example.com",
        timestamp: 456,
        timezone: "+0800",
      },
      encoding: "UTF-8",
      gpgsig: ["-----BEGIN PGP SIGNATURE-----", "sig", "-----END PGP SIGNATURE-----"].join("\n"),
      mergetag: [
        ["object 553c2077f0edc3d5dc5d17262f6aa498e69d6f8e", "type commit"].join("\n"),
        ["object be0788944df13c5d170e050f2fe178360c3df5a5", "type commit"].join("\n"),
      ],
      extraHeaders: [
        { name: "x-zeta", value: "last" },
        { name: "x-alpha", value: "first" },
      ],
      message: "hello",
    };

    const serialized = serializeCommit(commit).toString("utf-8");

    expect(serialized).toBe(
      [
        "tree be0788944df13c5d170e050f2fe178360c3df5a5",
        "parent 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
        "parent 553c2077f0edc3d5dc5d17262f6aa498e69d6f8e",
        "author Alice <alice@example.com> 123 +0800",
        "committer Bob <bob@example.com> 456 +0800",
        "encoding UTF-8",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " sig",
        " -----END PGP SIGNATURE-----",
        "mergetag object 553c2077f0edc3d5dc5d17262f6aa498e69d6f8e",
        " type commit",
        "mergetag object be0788944df13c5d170e050f2fe178360c3df5a5",
        " type commit",
        "x-zeta last",
        "x-alpha first",
        "",
        "hello",
        "",
      ].join("\n"),
    );
  });

  test("反序列化后的 commit 重新序列化时会归一化为 canonical 顺序", () => {
    const raw = Buffer.from(
      [
        "tree be0788944df13c5d170e050f2fe178360c3df5a5",
        "x-extra middle",
        "parent 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
        "author Alice <alice@example.com> 123 +0800",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " sig",
        " -----END PGP SIGNATURE-----",
        "committer Bob <bob@example.com> 456 +0800",
        "",
        "msg",
        "",
      ].join("\n"),
      "utf-8",
    );

    const commit = deserializeCommit(raw);

    expect(serializeCommit(commit).toString("utf-8")).toBe(
      [
        "tree be0788944df13c5d170e050f2fe178360c3df5a5",
        "parent 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
        "author Alice <alice@example.com> 123 +0800",
        "committer Bob <bob@example.com> 456 +0800",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " sig",
        " -----END PGP SIGNATURE-----",
        "x-extra middle",
        "",
        "msg",
        "",
      ].join("\n"),
    );
  });

  test("应拒绝与内建字段重名的自定义 header", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("be0788944df13c5d170e050f2fe178360c3df5a5"),
      parents: [],
      author: {
        name: "Alice",
        email: "alice@example.com",
        timestamp: 123,
        timezone: "+0800",
      },
      committer: {
        name: "Bob",
        email: "bob@example.com",
        timestamp: 456,
        timezone: "+0800",
      },
      extraHeaders: [{ name: "encoding", value: "UTF-8" }],
      message: "hello",
    };

    expect(() => serializeCommit(commit)).toThrow('commit extra header "encoding" 与内建字段冲突');
  });
});
