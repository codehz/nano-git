/**
 * Fetch 传输计划补正 —— 已废弃
 *
 * 职责已合并到 fetch-ref-plan.ts::planRefUpdates()。
 * planRefUpdates() 直接产出 FetchPlan（含 wants），
 * 不再需要独立的两段式设计。
 *
 * 保留此文件仅用于过渡期引用检查，请迁移到 planRefUpdates()。
 *
 * @deprecated 使用 fetch-ref-plan.ts 的 planRefUpdates() 替代
 */

export { planRefUpdates } from "./fetch-ref-plan.ts";
