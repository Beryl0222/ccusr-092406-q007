// art_motif_review 领域资料的基础结构。
//
// 发布治理沿用事件溯源：所有状态变化都以不可变事件落盘，
// 重启后通过重放事件重建元素、稿件、意见、议题、签署与发布包。

export const EVENT_KINDS = Object.freeze([
  // 基线事件
  "MOTIF_PROPOSED", // 元素提案：来源证据、可变形边界、权利条件、适用市场
  "REVIEW_OPINION_ADDED", // 审校意见：绑定具体稿件版本与依赖元素版本
  "RIGHTS_CONDITION_SET", // 权利条件单独设定（兼容旧事件）
  "RELEASE_PACKAGE_APPROVED", // 发布包经双签后上线
  "VERSION_SUSPENDED", // 已上线版本追加暂停记录
  // 治理事件
  "MOTIF_REVISED", // 元素修订，产生新的元素版本
  "PACKAGE_CREATED", // 创建发布包
  "VERSION_PROPOSED", // 提出设计稿版本，携带基线与依赖版本
  "ARBITRATION_OPENED", // 冲突意见进入联合裁定
  "ARBITRATION_RESOLVED", // 联合裁定结论（不会自动改写设计）
  "SIGN_OFF_RECORDED", // 研究审校或权利审校签署
  "SIGN_OFFS_INVALIDATED", // 依赖变化导致未发布稿件上的既有签署失效
  "CORRECTION_RECORDED", // 已上线包追加更正记录
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
