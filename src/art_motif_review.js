// art_motif_review 领域资料的基础结构。

export const EVENT_KINDS = Object.freeze([
  "MOTIF_PROPOSED",
  "MOTIF_UPDATED",
  "RIGHTS_CONDITION_SET",
  "DRAFT_CREATED",
  "DRAFT_REVISED",
  "REVIEW_OPINION_ADDED",
  "OPINION_ADJUDICATION_OPENED",
  "OPINION_ADJUDICATION_RESOLVED",
  "RELEASE_PACKAGE_ASSEMBLED",
  "RELEASE_PACKAGE_SIGNED",
  "RELEASE_PACKAGE_APPROVED",
  "PACKAGE_NOTICE_APPENDED",
  "DEPENDENCY_ALERT_RAISED",
  "VERSION_SUSPENDED",
]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
