// art_motif_review 领域资料的基础结构。

export const EVENT_KINDS = Object.freeze(["MOTIF_PROPOSED", "REVIEW_OPINION_ADDED", "RIGHTS_CONDITION_SET", "RELEASE_PACKAGE_APPROVED", "VERSION_SUSPENDED"]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
