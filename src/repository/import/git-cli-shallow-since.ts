/**
 * `repo.fetch({ shallowSince })` 到 git CLI `deepen-since` 发包值的对齐工具
 *
 * 官方 git CLI 会先把 `--shallow-since=@<timestamp>` 交给 approxidate()。
 * 在 `2099-12-31T23:59:59Z` 之后，它会从“直接时间戳”路径退回到
 * approxidate 的数字退化分支，并带出 32 位截断/符号扩展的历史行为。
 *
 * nano-git 的库 API 仍然接收显式 Unix 时间戳秒数，
 * 这里只在真正下发 wire `deepen-since` 参数时复刻 CLI 行为。
 */

/** git `parse_date_basic()` 能稳定按绝对 Unix 时间戳处理的上界（2099-12-31T23:59:59Z） */
const GIT_DIRECT_UNIX_TIMESTAMP_MAX = 4_102_444_799;

const UINT64_MOD = 1n << 64n;

interface GitCliApproxidateNow {
  readonly epochSeconds: number;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

function captureGitCliApproxidateNow(date = new Date()): GitCliApproxidateNow {
  return {
    epochSeconds: Math.floor(date.getTime() / 1000),
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds(),
  };
}

function toUint64DecimalFromSignedInt32(value: number): string {
  const normalized = value | 0;
  if (normalized >= 0) {
    return String(normalized);
  }

  return (UINT64_MOD + BigInt(normalized)).toString();
}

function emulateGitApproxidateNumericFallback(
  timestamp: number,
  now: GitCliApproxidateNow,
): string {
  // git approxidate_str() 里用于缓存“最后一个数字”的临时变量是 int，
  // 因此这里需要先按 int32 截断。
  let pendingNumber = timestamp | 0;
  let resolvedYear = -1;
  let resolvedMonth = -1;
  let resolvedDay = -1;

  if (pendingNumber !== 0) {
    if (resolvedDay < 0 && pendingNumber < 32) {
      resolvedDay = pendingNumber;
    } else if (resolvedMonth < 0 && pendingNumber < 13) {
      resolvedMonth = pendingNumber - 1;
    } else if (resolvedYear < 0) {
      if (pendingNumber > 1969 && pendingNumber < 2100) {
        resolvedYear = pendingNumber - 1900;
      } else if (pendingNumber > 69 && pendingNumber < 100) {
        resolvedYear = pendingNumber;
      } else if (pendingNumber < 38) {
        resolvedYear = 100 + pendingNumber;
      }
    }

    pendingNumber = 0;
  }

  let relativeSeconds = 0;
  if (resolvedDay < 0) {
    const offset = (resolvedDay + 1) | 0;
    if (offset < 0) {
      // 对齐 git 这里的 int 乘法溢出行为，再让结果参与后续时间计算。
      relativeSeconds = Math.imul(-offset, 24 * 60 * 60);
    }
    resolvedDay = now.day;
  }

  if (resolvedMonth < 0) {
    resolvedMonth = now.month;
  }

  if (resolvedYear < 0) {
    resolvedYear = now.year - 1900;
    if (resolvedMonth > now.month) {
      resolvedYear--;
    }
  }

  const baseEpochSeconds =
    resolvedYear + 1900 === now.year && resolvedMonth === now.month && resolvedDay === now.day
      ? now.epochSeconds
      : Math.floor(
          new Date(
            resolvedYear + 1900,
            resolvedMonth,
            resolvedDay,
            now.hours,
            now.minutes,
            now.seconds,
          ).getTime() / 1000,
        );
  const aligned = (baseEpochSeconds - relativeSeconds) | 0;
  return toUint64DecimalFromSignedInt32(aligned);
}

/**
 * 将库 API 里的 `shallowSince` 映射为与官方 git CLI 一致的 wire `deepen-since` 值
 *
 * 常规时间戳会原样透传。
 * 超过 `2099-12-31T23:59:59Z` 的极端 future 时间戳，
 * 会复刻 git CLI 对 `--shallow-since=@<timestamp>` 的 approxidate 退化行为。
 *
 * @param timestamp - Unix 时间戳秒数
 * @param now - 可选的“当前本地时间”快照，仅用于测试
 * @returns 用于 wire `deepen-since` 的十进制字符串
 *
 * @example
 * ```ts
 * const wireValue = formatGitCliShallowSince(1700000001);
 * // "1700000001"
 * ```
 */
export function formatGitCliShallowSince(
  timestamp: number,
  now: GitCliApproxidateNow = captureGitCliApproxidateNow(),
): string {
  if (timestamp <= GIT_DIRECT_UNIX_TIMESTAMP_MAX) {
    return String(timestamp);
  }

  return emulateGitApproxidateNumericFallback(timestamp, now);
}
