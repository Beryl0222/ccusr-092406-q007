// 艺术元素发布治理服务：元素提案、审校意见、联合裁定与发布签署的领域逻辑。
//
// 治理规则概览：
// - 元素保存来源证据、可变形边界、权利条件与适用市场，修改产生新版本并保留历史快照；
// - 专家意见绑定具体稿件版本与依赖版本快照，已发布或过期版本拒收新意见；
// - 冲突意见自动进入联合裁定，裁定只记录结论，不自动覆盖设计稿；
// - 发布包需研究审校与权利审校分别签署，签署请求幂等：完全重放返回原结果，内容变化拒绝；
// - 市场范围或素材授权变化只标记引用它的未发布版本，已上线包追加暂停或更正记录；
// - 所有修改携带基线版本（乐观并发），防止并行修改静默覆盖；
// - 状态经 StateStore 原子落盘，重启后待裁定议题与暂停通知保持一致。
import { createHash } from "node:crypto";
import { ERROR_CODES, GovernanceError } from "./errors.js";
import { StateStore } from "./store.js";

export const SIGNOFF_ROLES = Object.freeze(["research", "rights"]);
export const OPINION_STANCES = Object.freeze(["endorse", "object", "comment"]);
export const NOTICE_KINDS = Object.freeze(["suspension", "correction"]);

const MOTIF_PATCH_FIELDS = Object.freeze(["title", "provenance", "deform_bounds", "rights", "markets"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function fingerprintOf(payload) {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

function deepCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function requirePresent(values, fields) {
  const missing = fields.filter(
    (field) =>
      values[field] === undefined || values[field] === null || (typeof values[field] === "string" && values[field].trim() === ""),
  );
  if (missing.length > 0) {
    throw new GovernanceError(ERROR_CODES.VALIDATION, `缺少必填字段: ${missing.join(", ")}`, { missing });
  }
}

function assertVersion(entity, baseVersion, label) {
  if (baseVersion !== entity.version) {
    throw new GovernanceError(
      ERROR_CODES.VERSION_CONFLICT,
      `${label}基线版本不匹配: 当前 ${entity.version}, 请求基于 ${baseVersion}`,
      { expected: entity.version, received: baseVersion },
    );
  }
}

function validateMarkets(markets) {
  if (!Array.isArray(markets) || markets.length === 0 || markets.some((m) => typeof m !== "string" || m.trim() === "")) {
    throw new GovernanceError(ERROR_CODES.VALIDATION, "markets 必须是非空字符串数组");
  }
  if (new Set(markets).size !== markets.length) {
    throw new GovernanceError(ERROR_CODES.VALIDATION, "markets 存在重复项");
  }
}

function validateRights(rights) {
  if (!rights || typeof rights !== "object" || Array.isArray(rights)) {
    throw new GovernanceError(ERROR_CODES.VALIDATION, "rights 必须是对象");
  }
  if (typeof rights.license !== "string" || rights.license.trim() === "") {
    throw new GovernanceError(ERROR_CODES.VALIDATION, "rights.license 必填");
  }
  if (rights.conditions !== undefined && !Array.isArray(rights.conditions)) {
    throw new GovernanceError(ERROR_CODES.VALIDATION, "rights.conditions 必须是数组");
  }
}

function validateProvenance(provenance) {
  if (!Array.isArray(provenance)) {
    throw new GovernanceError(ERROR_CODES.VALIDATION, "provenance 必须是数组");
  }
  for (const item of provenance) {
    if (!item || typeof item !== "object" || typeof item.source !== "string" || item.source.trim() === "") {
      throw new GovernanceError(ERROR_CODES.VALIDATION, "provenance 每项都需要非空 source");
    }
  }
}

function validatePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GovernanceError(ERROR_CODES.VALIDATION, `${field} 必须是对象`);
  }
}

function normalizeRights(rights) {
  return { conditions: [], ...deepCopy(rights) };
}

function stanceConflicts(left, right) {
  return (left === "endorse" && right === "object") || (left === "object" && right === "endorse");
}

export class GovernanceService {
  #store;
  #now;

  constructor({ store, now }) {
    this.#store = store;
    this.#now = now;
    this.state = null;
  }

  static async open({ storagePath = null, now = () => new Date().toISOString() } = {}) {
    const store = new StateStore(storagePath);
    const service = new GovernanceService({ store, now });
    service.state = await store.load();
    return service;
  }

  // ---- 内部工具 ----

  #nextId(prefix) {
    const next = (this.state.counters[prefix] ?? 0) + 1;
    this.state.counters[prefix] = next;
    return `${prefix}-${String(next).padStart(6, "0")}`;
  }

  #emit(kind, subjectId, payload) {
    const event = {
      event_id: this.#nextId("event"),
      kind,
      occurred_at: this.#now(),
      subject_id: subjectId,
      payload: deepCopy(payload) ?? {},
    };
    this.state.events.push(event);
    return event;
  }

  async #persist() {
    await this.#store.save(this.state);
  }

  #requireEntry(collection, id, label) {
    const entry = this.state[collection][id];
    if (!entry) {
      throw new GovernanceError(ERROR_CODES.NOT_FOUND, `${label}不存在: ${id}`, { id });
    }
    return entry;
  }

  #motifSnapshot(motif, version) {
    if (version === motif.version) {
      return deepCopy({
        motif_id: motif.motif_id,
        version: motif.version,
        title: motif.title,
        provenance: motif.provenance,
        deform_bounds: motif.deform_bounds,
        rights: motif.rights,
        markets: motif.markets,
        status: motif.status,
      });
    }
    const past = motif.history.find((entry) => entry.version === version);
    if (!past) {
      throw new GovernanceError(ERROR_CODES.NOT_FOUND, `元素 ${motif.motif_id} 没有版本 ${version}`, {
        motif_id: motif.motif_id,
        version,
      });
    }
    return deepCopy({ motif_id: motif.motif_id, ...past });
  }

  #validateMotifRefs(motifRefs, { requireCurrent }) {
    if (!Array.isArray(motifRefs)) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, "motif_refs 必须是数组");
    }
    const seen = new Set();
    return motifRefs.map((ref) => {
      requirePresent(ref ?? {}, ["motif_id", "motif_version"]);
      if (seen.has(ref.motif_id)) {
        throw new GovernanceError(ERROR_CODES.VALIDATION, `motif_refs 重复引用元素: ${ref.motif_id}`);
      }
      seen.add(ref.motif_id);
      const motif = this.#requireEntry("motifs", ref.motif_id, "元素");
      this.#motifSnapshot(motif, ref.motif_version);
      if (requireCurrent && ref.motif_version !== motif.version) {
        throw new GovernanceError(
          ERROR_CODES.STALE_TARGET,
          `元素 ${ref.motif_id} 当前版本为 ${motif.version}，新稿件须引用最新版本`,
          { motif_id: ref.motif_id, current: motif.version, requested: ref.motif_version },
        );
      }
      return { motif_id: ref.motif_id, motif_version: ref.motif_version };
    });
  }

  // ---- 元素提案 ----

  async proposeMotif({ motif_id: requestedId, title, provenance = [], deform_bounds = {}, rights, markets, actor = "system" } = {}) {
    requirePresent({ title, rights, markets }, ["title", "rights", "markets"]);
    validateProvenance(provenance);
    validatePlainObject(deform_bounds, "deform_bounds");
    validateRights(rights);
    validateMarkets(markets);
    const motifId = requestedId ?? this.#nextId("motif");
    if (this.state.motifs[motifId]) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, `元素已存在: ${motifId}`, { motif_id: motifId });
    }
    const timestamp = this.#now();
    const motif = {
      motif_id: motifId,
      version: 1,
      title,
      provenance: deepCopy(provenance),
      deform_bounds: deepCopy(deform_bounds),
      rights: normalizeRights(rights),
      markets: [...markets],
      status: "active",
      history: [],
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.state.motifs[motifId] = motif;
    this.#emit("MOTIF_PROPOSED", motifId, { title, markets: [...markets], actor });
    this.#emit("RIGHTS_CONDITION_SET", motifId, { rights: deepCopy(motif.rights), actor });
    await this.#persist();
    return deepCopy(motif);
  }

  async updateMotif({ motif_id: motifId, base_version: baseVersion, patch = {}, actor = "system" } = {}) {
    requirePresent({ motif_id: motifId, base_version: baseVersion }, ["motif_id", "base_version"]);
    const motif = this.#requireEntry("motifs", motifId, "元素");
    assertVersion(motif, baseVersion, "元素");
    const unknown = Object.keys(patch).filter((key) => !MOTIF_PATCH_FIELDS.includes(key));
    if (unknown.length > 0) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, `不支持的元素字段: ${unknown.join(", ")}`, { unknown });
    }
    if (Object.keys(patch).length === 0) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, "patch 不能为空");
    }
    if (patch.title !== undefined) requirePresent({ title: patch.title }, ["title"]);
    if (patch.provenance !== undefined) validateProvenance(patch.provenance);
    if (patch.deform_bounds !== undefined) validatePlainObject(patch.deform_bounds, "deform_bounds");
    if (patch.rights !== undefined) validateRights(patch.rights);
    if (patch.markets !== undefined) validateMarkets(patch.markets);

    const marketsChanged = patch.markets !== undefined && !deepEqual(patch.markets, motif.markets);
    const rightsChanged = patch.rights !== undefined && !deepEqual(normalizeRights(patch.rights), motif.rights);

    motif.history.push({
      version: motif.version,
      title: motif.title,
      provenance: deepCopy(motif.provenance),
      deform_bounds: deepCopy(motif.deform_bounds),
      rights: deepCopy(motif.rights),
      markets: [...motif.markets],
      recorded_at: motif.updated_at,
    });
    if (patch.title !== undefined) motif.title = patch.title;
    if (patch.provenance !== undefined) motif.provenance = deepCopy(patch.provenance);
    if (patch.deform_bounds !== undefined) motif.deform_bounds = deepCopy(patch.deform_bounds);
    if (patch.rights !== undefined) motif.rights = normalizeRights(patch.rights);
    if (patch.markets !== undefined) motif.markets = [...patch.markets];
    motif.version += 1;
    motif.updated_at = this.#now();

    this.#emit("MOTIF_UPDATED", motifId, { version: motif.version, fields: Object.keys(patch), actor });
    if (rightsChanged) {
      this.#emit("RIGHTS_CONDITION_SET", motifId, { rights: deepCopy(motif.rights), actor });
    }
    if (marketsChanged || rightsChanged) {
      this.#propagateMotifChange(motif, { markets: marketsChanged, rights: rightsChanged });
    }
    await this.#persist();
    return deepCopy(motif);
  }

  // 市场范围或素材授权变化：未发布稿件/发布包标记依赖告警（签署作废），已上线包追加暂停或更正记录。
  #propagateMotifChange(motif, changes) {
    const fields = [];
    if (changes.markets) fields.push("markets");
    if (changes.rights) fields.push("rights");

    const buildAlert = (fromVersion) => ({
      alert_id: this.#nextId("alert"),
      motif_id: motif.motif_id,
      from_version: fromVersion,
      to_version: motif.version,
      fields: [...fields],
      acknowledged: false,
      raised_at: this.#now(),
    });

    for (const draft of Object.values(this.state.drafts)) {
      if (draft.status !== "open") continue;
      const ref = draft.motif_refs.find((item) => item.motif_id === motif.motif_id);
      if (!ref) continue;
      draft.dependency_alerts.push(buildAlert(ref.motif_version));
      this.#emit("DEPENDENCY_ALERT_RAISED", draft.draft_id, {
        target: "draft",
        motif_id: motif.motif_id,
        from_version: ref.motif_version,
        to_version: motif.version,
        fields,
      });
    }

    for (const pkg of Object.values(this.state.packages)) {
      const ref = pkg.motif_refs.find((item) => item.motif_id === motif.motif_id);
      if (!ref) continue;
      if (pkg.status === "published" || pkg.status === "suspended") {
        const uncovered = changes.markets ? pkg.markets.filter((m) => !motif.markets.includes(m)) : [];
        const kind = uncovered.length > 0 ? "suspension" : "correction";
        const notice = {
          notice_id: this.#nextId("notice"),
          kind,
          reason:
            kind === "suspension"
              ? `元素 ${motif.motif_id} 市场范围收缩，不再覆盖: ${uncovered.join(", ")}`
              : `元素 ${motif.motif_id} ${changes.rights ? "权利条件" : "市场范围"}更新（v${ref.motif_version} → v${motif.version}），需更正备案`,
          motif_id: motif.motif_id,
          from_version: ref.motif_version,
          to_version: motif.version,
          fields: [...fields],
          created_at: this.#now(),
        };
        pkg.notices.push(notice);
        pkg.version += 1;
        pkg.updated_at = this.#now();
        if (kind === "suspension") {
          pkg.status = "suspended";
          this.#emit("VERSION_SUSPENDED", pkg.package_id, {
            notice_id: notice.notice_id,
            motif_id: motif.motif_id,
            reason: notice.reason,
          });
        } else {
          this.#emit("PACKAGE_NOTICE_APPENDED", pkg.package_id, {
            notice_id: notice.notice_id,
            kind,
            motif_id: motif.motif_id,
          });
        }
      } else {
        pkg.dependency_alerts.push(buildAlert(ref.motif_version));
        pkg.signoffs = { research: null, rights: null };
        pkg.status = "assembling";
        pkg.version += 1;
        pkg.updated_at = this.#now();
        this.#emit("DEPENDENCY_ALERT_RAISED", pkg.package_id, {
          target: "package",
          motif_id: motif.motif_id,
          from_version: ref.motif_version,
          to_version: motif.version,
          fields,
        });
      }
    }
  }

  // ---- 设计稿件 ----

  async createDraft({ draft_id: requestedId, motif_refs: motifRefs = [], content, actor = "system" } = {}) {
    requirePresent({ content }, ["content"]);
    validatePlainObject(content, "content");
    const refs = this.#validateMotifRefs(motifRefs, { requireCurrent: true });
    const draftId = requestedId ?? this.#nextId("draft");
    if (this.state.drafts[draftId]) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, `稿件已存在: ${draftId}`, { draft_id: draftId });
    }
    const timestamp = this.#now();
    const draft = {
      draft_id: draftId,
      version: 1,
      motif_refs: refs,
      content: deepCopy(content),
      status: "open",
      dependency_alerts: [],
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.state.drafts[draftId] = draft;
    this.#emit("DRAFT_CREATED", draftId, { motif_refs: deepCopy(refs), actor });
    await this.#persist();
    return deepCopy(draft);
  }

  async reviseDraft({ draft_id: draftId, base_version: baseVersion, content, motif_refs: motifRefs, actor = "system" } = {}) {
    requirePresent({ draft_id: draftId, base_version: baseVersion }, ["draft_id", "base_version"]);
    const draft = this.#requireEntry("drafts", draftId, "稿件");
    assertVersion(draft, baseVersion, "稿件");
    if (content === undefined && motifRefs === undefined) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, "content 与 motif_refs 至少提供一项");
    }
    if (content !== undefined) {
      validatePlainObject(content, "content");
      draft.content = deepCopy(content);
    }
    if (motifRefs !== undefined) {
      draft.motif_refs = this.#validateMotifRefs(motifRefs, { requireCurrent: false });
    }
    draft.version += 1;
    draft.status = "open";
    draft.updated_at = this.#now();
    // 引用已对齐元素当前版本的告警视为解除
    draft.dependency_alerts = draft.dependency_alerts.filter((alert) => {
      const ref = draft.motif_refs.find((item) => item.motif_id === alert.motif_id);
      const motif = this.state.motifs[alert.motif_id];
      return !(ref && motif && ref.motif_version === motif.version);
    });
    this.#emit("DRAFT_REVISED", draftId, { version: draft.version, actor });
    await this.#persist();
    return deepCopy(draft);
  }

  // ---- 专家意见与联合裁定 ----

  async addOpinion({
    opinion_id: requestedId,
    draft_id: draftId,
    draft_version: draftVersion,
    dependency_versions: dependencyVersions,
    expert,
    kind = "research",
    stance,
    body = "",
  } = {}) {
    requirePresent(
      { draft_id: draftId, draft_version: draftVersion, dependency_versions: dependencyVersions, expert, stance },
      ["draft_id", "draft_version", "dependency_versions", "expert", "stance"],
    );
    if (!OPINION_STANCES.includes(stance)) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, `未知意见立场: ${stance}`, { stance });
    }
    const draft = this.#requireEntry("drafts", draftId, "稿件");
    if (draft.status !== "open") {
      throw new GovernanceError(ERROR_CODES.STATE_CONFLICT, `稿件 ${draftId} 当前版本已发布，意见只能针对未发布的最新版本`, {
        draft_id: draftId,
      });
    }
    if (draftVersion !== draft.version) {
      throw new GovernanceError(
        ERROR_CODES.STALE_TARGET,
        `意见绑定的稿件版本 ${draftVersion} 与当前版本 ${draft.version} 不一致`,
        { expected: draft.version, received: draftVersion },
      );
    }
    const currentDeps = Object.fromEntries(draft.motif_refs.map((ref) => [ref.motif_id, ref.motif_version]));
    if (!deepEqual(dependencyVersions, currentDeps)) {
      throw new GovernanceError(ERROR_CODES.STALE_TARGET, "意见绑定的依赖版本与稿件当前依赖不一致", {
        expected: currentDeps,
        received: dependencyVersions,
      });
    }
    const opinionId = requestedId ?? this.#nextId("opinion");
    if (this.state.opinions[opinionId]) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, `意见已存在: ${opinionId}`, { opinion_id: opinionId });
    }
    const opinion = {
      opinion_id: opinionId,
      draft_id: draftId,
      draft_version: draftVersion,
      dependency_versions: deepCopy(dependencyVersions),
      expert,
      kind,
      stance,
      body,
      status: "open",
      created_at: this.#now(),
    };
    this.state.opinions[opinionId] = opinion;
    this.#emit("REVIEW_OPINION_ADDED", draftId, {
      opinion_id: opinionId,
      draft_version: draftVersion,
      expert,
      kind,
      stance,
    });

    let adjudication = null;
    const opponents = Object.values(this.state.opinions).filter(
      (other) =>
        other.opinion_id !== opinionId &&
        other.draft_id === draftId &&
        other.draft_version === draftVersion &&
        (other.status === "open" || other.status === "in_adjudication") &&
        stanceConflicts(other.stance, stance),
    );
    if (opponents.length > 0) {
      adjudication =
        Object.values(this.state.adjudications).find(
          (item) => item.draft_id === draftId && item.draft_version === draftVersion && item.status === "pending",
        ) ?? null;
      if (!adjudication) {
        adjudication = {
          adjudication_id: this.#nextId("adjudication"),
          draft_id: draftId,
          draft_version: draftVersion,
          opinion_ids: [],
          status: "pending",
          resolution: null,
          created_at: this.#now(),
        };
        this.state.adjudications[adjudication.adjudication_id] = adjudication;
        this.#emit("OPINION_ADJUDICATION_OPENED", adjudication.adjudication_id, {
          draft_id: draftId,
          draft_version: draftVersion,
        });
      }
      adjudication.opinion_ids = [...new Set([...adjudication.opinion_ids, opinionId, ...opponents.map((item) => item.opinion_id)])];
      opinion.status = "in_adjudication";
      for (const other of opponents) other.status = "in_adjudication";
    }
    await this.#persist();
    return { opinion: deepCopy(opinion), adjudication: deepCopy(adjudication) };
  }

  async resolveAdjudication({
    adjudication_id: adjudicationId,
    decided_by: decidedBy,
    outcome,
    rationale = "",
    adopted_opinion_ids: adopted = [],
  } = {}) {
    requirePresent({ adjudication_id: adjudicationId, decided_by: decidedBy, outcome }, ["adjudication_id", "decided_by", "outcome"]);
    const adjudication = this.#requireEntry("adjudications", adjudicationId, "裁定议题");
    if (adjudication.status !== "pending") {
      throw new GovernanceError(ERROR_CODES.STATE_CONFLICT, `裁定议题 ${adjudicationId} 已结案`, {
        adjudication_id: adjudicationId,
      });
    }
    for (const opinionId of adopted) {
      if (!adjudication.opinion_ids.includes(opinionId)) {
        throw new GovernanceError(ERROR_CODES.VALIDATION, `采纳意见 ${opinionId} 不属于议题 ${adjudicationId}`, {
          opinion_id: opinionId,
        });
      }
    }
    adjudication.status = "resolved";
    adjudication.resolution = {
      decided_by: decidedBy,
      outcome,
      rationale,
      adopted_opinion_ids: [...adopted],
      decided_at: this.#now(),
    };
    for (const opinionId of adjudication.opinion_ids) {
      const opinion = this.state.opinions[opinionId];
      if (opinion) opinion.status = "adjudicated";
    }
    this.#emit("OPINION_ADJUDICATION_RESOLVED", adjudicationId, { outcome, decided_by: decidedBy });
    // 裁定只记录结论，不改动稿件内容；设计变更必须显式走 reviseDraft。
    await this.#persist();
    return deepCopy(adjudication);
  }

  // ---- 发布包与签署 ----

  async assemblePackage({ package_id: requestedId, draft_id: draftId, draft_version: draftVersion, markets, actor = "system" } = {}) {
    requirePresent({ draft_id: draftId, draft_version: draftVersion, markets }, ["draft_id", "draft_version", "markets"]);
    validateMarkets(markets);
    const draft = this.#requireEntry("drafts", draftId, "稿件");
    if (draftVersion !== draft.version) {
      throw new GovernanceError(
        ERROR_CODES.STALE_TARGET,
        `组装基于的稿件版本 ${draftVersion} 与当前版本 ${draft.version} 不一致`,
        { expected: draft.version, received: draftVersion },
      );
    }
    if (draft.status !== "open") {
      throw new GovernanceError(ERROR_CODES.STATE_CONFLICT, `稿件 ${draftId} 当前版本已发布，组装前请先修订出新版本`, {
        draft_id: draftId,
      });
    }
    this.#assertMarketCoverage(draft.motif_refs, markets);
    const packageId = requestedId ?? this.#nextId("package");
    if (this.state.packages[packageId]) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, `发布包已存在: ${packageId}`, { package_id: packageId });
    }
    const timestamp = this.#now();
    const pkg = {
      package_id: packageId,
      version: 1,
      draft_id: draftId,
      draft_version: draftVersion,
      motif_refs: deepCopy(draft.motif_refs),
      markets: [...markets],
      signoffs: { research: null, rights: null },
      dependency_alerts: deepCopy(draft.dependency_alerts),
      notices: [],
      status: "assembling",
      created_at: timestamp,
      updated_at: timestamp,
      published_at: null,
    };
    this.state.packages[packageId] = pkg;
    this.#emit("RELEASE_PACKAGE_ASSEMBLED", packageId, {
      draft_id: draftId,
      draft_version: draftVersion,
      markets: [...markets],
      actor,
    });
    await this.#persist();
    return deepCopy(pkg);
  }

  async reassemblePackage({ package_id: packageId, base_version: baseVersion, actor = "system" } = {}) {
    requirePresent({ package_id: packageId, base_version: baseVersion }, ["package_id", "base_version"]);
    const pkg = this.#requireEntry("packages", packageId, "发布包");
    assertVersion(pkg, baseVersion, "发布包");
    if (pkg.status === "published" || pkg.status === "suspended") {
      throw new GovernanceError(ERROR_CODES.STATE_CONFLICT, `发布包 ${packageId} 已上线，不可重新组装`, {
        package_id: packageId,
      });
    }
    const draft = this.#requireEntry("drafts", pkg.draft_id, "稿件");
    this.#assertMarketCoverage(draft.motif_refs, pkg.markets);
    pkg.draft_version = draft.version;
    pkg.motif_refs = deepCopy(draft.motif_refs);
    pkg.dependency_alerts = deepCopy(draft.dependency_alerts);
    pkg.signoffs = { research: null, rights: null };
    pkg.status = "assembling";
    pkg.version += 1;
    pkg.updated_at = this.#now();
    this.#emit("RELEASE_PACKAGE_ASSEMBLED", packageId, {
      draft_id: pkg.draft_id,
      draft_version: draft.version,
      markets: [...pkg.markets],
      reassembled: true,
      actor,
    });
    await this.#persist();
    return deepCopy(pkg);
  }

  #assertMarketCoverage(motifRefs, markets) {
    for (const ref of motifRefs) {
      const motif = this.#requireEntry("motifs", ref.motif_id, "元素");
      const snapshot = this.#motifSnapshot(motif, ref.motif_version);
      const missing = markets.filter((market) => !snapshot.markets.includes(market));
      if (missing.length > 0) {
        throw new GovernanceError(
          ERROR_CODES.VALIDATION,
          `元素 ${ref.motif_id} v${ref.motif_version} 的适用市场不覆盖: ${missing.join(", ")}`,
          { motif_id: ref.motif_id, motif_version: ref.motif_version, missing },
        );
      }
    }
  }

  async signPackage({ package_id: packageId, base_version: baseVersion, role, signer, request_id: requestId, statement = {} } = {}) {
    requirePresent(
      { package_id: packageId, base_version: baseVersion, role, signer, request_id: requestId },
      ["package_id", "base_version", "role", "signer", "request_id"],
    );
    if (!SIGNOFF_ROLES.includes(role)) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, `未知签署角色: ${role}`, { role });
    }
    const pkg = this.#requireEntry("packages", packageId, "发布包");
    const fingerprint = fingerprintOf({ package_id: packageId, base_version: baseVersion, role, signer, statement });
    const prior = this.state.idempotency[requestId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new GovernanceError(ERROR_CODES.IDEMPOTENCY_CONFLICT, `签署请求 ${requestId} 已存在且内容不一致`, {
          request_id: requestId,
        });
      }
      return deepCopy(prior.response);
    }
    assertVersion(pkg, baseVersion, "发布包");
    if (pkg.status === "published" || pkg.status === "suspended") {
      throw new GovernanceError(ERROR_CODES.STATE_CONFLICT, `发布包 ${packageId} 已上线，不可再签署`, {
        package_id: packageId,
      });
    }
    if (pkg.dependency_alerts.length > 0) {
      throw new GovernanceError(ERROR_CODES.DEPENDENCY_ALERTS, "发布包存在未解除的依赖告警，需对齐后重新组装", {
        alerts: deepCopy(pkg.dependency_alerts),
      });
    }
    if (pkg.signoffs[role]) {
      throw new GovernanceError(ERROR_CODES.STATE_CONFLICT, `发布包 ${packageId} 的 ${role} 审校已签署`, {
        package_id: packageId,
        role,
      });
    }
    const signoff = { role, signed_by: signer, signed_at: this.#now(), request_id: requestId, statement: deepCopy(statement) };
    pkg.signoffs[role] = signoff;
    pkg.version += 1;
    pkg.updated_at = this.#now();
    if (pkg.signoffs.research && pkg.signoffs.rights) pkg.status = "ready";
    this.#emit("RELEASE_PACKAGE_SIGNED", packageId, { role, signer, package_version: pkg.version });
    const response = { package_id: packageId, role, status: pkg.status, package_version: pkg.version, signoff: deepCopy(signoff) };
    this.state.idempotency[requestId] = { fingerprint, response: deepCopy(response) };
    await this.#persist();
    return response;
  }

  async publishPackage({ package_id: packageId, base_version: baseVersion, actor = "system" } = {}) {
    requirePresent({ package_id: packageId, base_version: baseVersion }, ["package_id", "base_version"]);
    const pkg = this.#requireEntry("packages", packageId, "发布包");
    assertVersion(pkg, baseVersion, "发布包");
    if (pkg.status === "published" || pkg.status === "suspended") {
      throw new GovernanceError(ERROR_CODES.STATE_CONFLICT, `发布包 ${packageId} 状态为 ${pkg.status}，不可重复发布`, {
        package_id: packageId,
      });
    }
    if (pkg.dependency_alerts.length > 0) {
      throw new GovernanceError(ERROR_CODES.DEPENDENCY_ALERTS, "发布包存在未解除的依赖告警", {
        alerts: deepCopy(pkg.dependency_alerts),
      });
    }
    const pending = Object.values(this.state.adjudications).find(
      (item) => item.draft_id === pkg.draft_id && item.draft_version === pkg.draft_version && item.status === "pending",
    );
    if (pending) {
      throw new GovernanceError(ERROR_CODES.PENDING_ADJUDICATION, `稿件存在待裁定议题 ${pending.adjudication_id}，不得发布`, {
        adjudication_id: pending.adjudication_id,
      });
    }
    if (!pkg.signoffs.research || !pkg.signoffs.rights) {
      throw new GovernanceError(ERROR_CODES.SIGNOFF_INCOMPLETE, "发布包需要研究审校与权利审校分别签署后才能发布", {
        research: Boolean(pkg.signoffs.research),
        rights: Boolean(pkg.signoffs.rights),
      });
    }
    pkg.status = "published";
    pkg.published_at = this.#now();
    pkg.version += 1;
    pkg.updated_at = this.#now();
    const draft = this.state.drafts[pkg.draft_id];
    if (draft && draft.version === pkg.draft_version) {
      draft.status = "published";
      draft.updated_at = this.#now();
    }
    this.#emit("RELEASE_PACKAGE_APPROVED", packageId, {
      draft_id: pkg.draft_id,
      draft_version: pkg.draft_version,
      package_version: pkg.version,
      actor,
    });
    await this.#persist();
    return deepCopy(pkg);
  }

  // 已上线包追加暂停或更正记录（运营动作，内容本体不被改写）。
  async appendNotice({ package_id: packageId, kind, reason, actor = "system" } = {}) {
    requirePresent({ package_id: packageId, kind, reason }, ["package_id", "kind", "reason"]);
    if (!NOTICE_KINDS.includes(kind)) {
      throw new GovernanceError(ERROR_CODES.VALIDATION, `未知通知类型: ${kind}`, { kind });
    }
    const pkg = this.#requireEntry("packages", packageId, "发布包");
    if (pkg.status !== "published" && pkg.status !== "suspended") {
      throw new GovernanceError(ERROR_CODES.STATE_CONFLICT, `发布包 ${packageId} 尚未上线，不能追加暂停或更正记录`, {
        package_id: packageId,
      });
    }
    const notice = { notice_id: this.#nextId("notice"), kind, reason, actor, created_at: this.#now() };
    pkg.notices.push(notice);
    pkg.version += 1;
    pkg.updated_at = this.#now();
    if (kind === "suspension") {
      pkg.status = "suspended";
      this.#emit("VERSION_SUSPENDED", packageId, { notice_id: notice.notice_id, reason });
    } else {
      this.#emit("PACKAGE_NOTICE_APPENDED", packageId, { notice_id: notice.notice_id, kind });
    }
    await this.#persist();
    return deepCopy(notice);
  }

  // ---- 查询与追溯 ----

  getMotif(motifId, { version } = {}) {
    const motif = this.#requireEntry("motifs", motifId, "元素");
    if (version === undefined) return deepCopy(motif);
    return this.#motifSnapshot(motif, version);
  }

  getDraft(draftId) {
    return deepCopy(this.#requireEntry("drafts", draftId, "稿件"));
  }

  getPackage(packageId) {
    return deepCopy(this.#requireEntry("packages", packageId, "发布包"));
  }

  getAdjudication(adjudicationId) {
    return deepCopy(this.#requireEntry("adjudications", adjudicationId, "裁定议题"));
  }

  listPendingAdjudications() {
    return Object.values(this.state.adjudications)
      .filter((item) => item.status === "pending")
      .map(deepCopy)
      .sort((left, right) => left.adjudication_id.localeCompare(right.adjudication_id));
  }

  listNotices() {
    const all = [];
    for (const pkg of Object.values(this.state.packages)) {
      for (const notice of pkg.notices) {
        all.push({ package_id: pkg.package_id, ...deepCopy(notice) });
      }
    }
    return all.sort((left, right) => left.notice_id.localeCompare(right.notice_id));
  }

  listEvents() {
    return deepCopy(this.state.events);
  }

  // 任一成品可追到采用的元素（钉住版本）、来源证据、意见、裁定与批准版本。
  traceArtifact(packageId) {
    const pkg = this.#requireEntry("packages", packageId, "发布包");
    const motifs = pkg.motif_refs.map((ref) => {
      const motif = this.#requireEntry("motifs", ref.motif_id, "元素");
      return this.#motifSnapshot(motif, ref.motif_version);
    });
    const opinions = Object.values(this.state.opinions)
      .filter((item) => item.draft_id === pkg.draft_id && item.draft_version === pkg.draft_version)
      .map(deepCopy);
    const adjudications = Object.values(this.state.adjudications)
      .filter((item) => item.draft_id === pkg.draft_id && item.draft_version === pkg.draft_version)
      .map(deepCopy);
    return {
      package: deepCopy(pkg),
      draft: { draft_id: pkg.draft_id, draft_version: pkg.draft_version },
      motifs,
      opinions,
      adjudications,
      approvals: {
        research: deepCopy(pkg.signoffs.research),
        rights: deepCopy(pkg.signoffs.rights),
        published_at: pkg.published_at ?? null,
        package_version: pkg.version,
      },
      notices: deepCopy(pkg.notices),
      events: this.state.events.filter((event) => event.subject_id === packageId).map(deepCopy),
    };
  }
}
