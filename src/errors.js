// 发布治理服务的错误码与异常类型。

export const ERROR_CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  STALE_TARGET: "STALE_TARGET",
  STATE_CONFLICT: "STATE_CONFLICT",
  SIGNOFF_INCOMPLETE: "SIGNOFF_INCOMPLETE",
  PENDING_ADJUDICATION: "PENDING_ADJUDICATION",
  DEPENDENCY_ALERTS: "DEPENDENCY_ALERTS",
});

export class GovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
    this.details = details;
  }
}
