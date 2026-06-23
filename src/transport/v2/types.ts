/**
 * Git Wire 协议 v2 类型定义
 *
 * 定义了协议 v2 特有的类型：能力广告、命令式传输接口等。
 * 协议无关的共享类型见 shared/types.ts。
 */

// ============================================================================
// 能力广告
// ============================================================================

/**
 * v2 能力广告中的单个命令条目
 *
 * 表示服务端广告的 v2 命令及附加特性。
 *
 * @example
 * ```ts
 * const cmd: V2CommandEntry = {
 *   name: "fetch",
 *   features: ["shallow", "ref-in-want"],
 * };
 * ```
 */
export interface V2CommandEntry {
  /** 命令名称，如 "ls-refs"、"fetch"、"push"、"object-info" */
  readonly name: string;
  /** 命令附加特性列表（在 capability 值中声明） */
  readonly features: string[];
}

/**
 * v2 能力广告（服务端响应）
 *
 * 对应协议 v2 的能力广告格式：
 * ```
 * version 2\n
 * ls-refs\n
 * fetch=shallow ref-in-want\n
 * push\n
 * object-info\n
 * agent=nano-git/0.1\n
 * 0000
 * ```
 */
export interface V2CapabilityAdvertisement {
  /** 服务端能力键值对 */
  readonly capabilities: Record<string, string | true>;
  /** 服务端支持的 v2 命令列表 */
  readonly commands: V2CommandEntry[];
  /** 服务端 agent 字符串 */
  readonly agent?: string;
}

// ============================================================================
// v2 传输接口
// ============================================================================

/**
 * v2 Git 服务传输接口
 *
 * 与 v1 的 GitServiceTransport 不同，v2 是命令式的。
 * - advertise() 只返回能力广告，不含 refs
 * - command() 发送单个命令并返回原始响应
 */
export interface V2GitServiceTransport {
  /** 获取能力广告 */
  advertise(): Promise<V2CapabilityAdvertisement>;
  /**
   * 执行 v2 命令
   *
   * @param command - 命令名称，如 "ls-refs"、"fetch"
   * @param args - 命令参数列表
   * @param capabilities - 本次请求携带的能力列表（不含 agent）
   * @param body - 额外的原始 body 数据（如 push 的 packfile）
   */
  command(
    command: string,
    args?: string[],
    capabilities?: string[],
    body?: Buffer,
  ): Promise<Buffer>;
}

// ============================================================================
// ls-refs 相关类型
// ============================================================================

/**
 * ls-refs 输出条目
 *
 * 对应 v2 ls-refs 响应中的单行 ref。
 * ```
 * <obj-id> SP <refname> [SP <ref-attribute> ...] LF
 * ```
 */
export interface LsRefsEntry {
  /** 对象哈希，unborn 分支时为 "unborn" */
  readonly oid: string;
  /** 引用全名 */
  readonly refname: string;
  /** 符号引用目标（如有） */
  readonly symrefTarget?: string;
  /** peeled 对象哈希（如有） */
  readonly peeled?: string;
}

// ============================================================================
// v2 fetch 相关类型
// ============================================================================

/**
 * v2 fetch 请求参数
 */
export interface V2FetchRequest {
  readonly wants: string[];
  readonly haves?: string[];
  readonly done?: boolean;
  readonly wantRefs?: string[];
  readonly thinPack?: boolean;
  readonly noProgress?: boolean;
  readonly includeTag?: boolean;
  readonly ofsDelta?: boolean;
  readonly shallow?: string[];
  readonly deepen?: number;
  readonly deepenRelative?: boolean;
  readonly deepenSince?: number;
  readonly deepenNot?: string[];
  readonly filter?: string;
  readonly sidebandAll?: boolean;
  readonly waitForDone?: boolean;
}

/**
 * v2 fetch 响应
 *
 * 响应包含多个由 delimiter (0001) 分隔的节。
 */
export interface V2FetchResponse {
  /** acknowledgments 节 */
  readonly acknowledgments?: {
    readonly nak?: boolean;
    readonly acks: string[];
    readonly ready?: boolean;
  };
  /** shallow-info 节 */
  readonly shallowInfo?: {
    readonly shallow: string[];
    readonly unshallow: string[];
  };
  /** wanted-refs 节 */
  readonly wantedRefs?: Array<{ oid: string; refname: string }>;
  /** packfile-uris 节 */
  readonly packfileUris?: Array<{ oid: string; uri: string }>;
  /** 原始 packfile buffer */
  readonly packfile?: Buffer;
}

// ============================================================================
// v2 push 相关类型
// ============================================================================

/**
 * v2 push 命令参数
 */
export interface V2PushRequest {
  readonly capabilities?: string[];
  readonly pushOptions?: string[];
  readonly packfile: Buffer;
}

// ============================================================================
// object-info 相关类型
// ============================================================================

/**
 * object-info 结果条目
 */
export interface ObjectInfoEntry {
  readonly oid: string;
  readonly size?: number;
}

/**
 * object-info 响应
 */
export interface ObjectInfoResponse {
  readonly attrs: string[];
  readonly objects: ObjectInfoEntry[];
}
