// 发布治理服务：在事件存储之上编排业务规则。
//
// 治理原则：
// - 意见绑定“具体稿件版本 + 该版本引用的元素版本快照”，新意见不能套到已发布旧稿；
// - 冲突意见只能进入联合裁定，裁定结论不自动改写设计内容；
// - 发布必须研究、权利两条审校线分别有效签署；
// - 市场范围或素材授权变化只波引用该元素的未发布稿件，已上线包只能追加暂停/更正；
// - 并修订以基线版本检测分叉，防止静默覆盖；
// - 签署请求按 request_id 幂等：完全重放返回原结果，内容变化拒绝；
// - 一切结论都可沿事件溯源到元素版本、证据、意见与批准记录。

import { canonicalHash } from "./hashing.js";
import { TRACKS, STANCES, ARBITRATION_DECISIONS } from "./projection.js";

export class GovernanceError extends Error {}

function assert(condition, message) {
  if (!condition) throw new GovernanceError(message);
}

export class GovernanceService {
  constructor(store) {
    this.store = store;
  }

  get state() {
    return this.store.state;
  }

  // ---- 元素：提案与修订 -------------------------------------------------

  proposeMotif(input) {
    assert(input?.motif_id, "motif_id 必填");
    assert(!this.state.motifs.has(input.motif_id), `元素已存在：${input.motif_id}`);
    this._requireMotifContent(input);
    return this.store.append("MOTIF_PROPOSED", input.motif_id, this._motifPayload(input)).payload;
  }

  reviseMotif(motifId, changes) {
    const motif = this.state.motifs.get(motifId);
    assert(motif, `元素不存在：${motifId}`);
    const current = motif.versions.get(motif.currentNo);
    const next = {
      motif_id: motifId,
      source_evidence: changes.source_evidence ?? current.source_evidence,
      transformation_bounds: changes.transformation_bounds ?? current.transformation_bounds,
      rights_conditions: changes.rights_conditions ?? current.rights_conditions,
      markets: changes.markets ?? current.markets,
      note: changes.note ?? null,
    };
    this._requireMotifContent(next);
    assert(canonicalHash(this._motifContent(next)) !== current.content_hash, "修订内容与当前版本完全相同，未产生新版本");

    const changed = this._diffMotif(current, next);
    // 找出所有“未发布且引用该元素”的稿件；已上线包不受影响（只能追加暂停/更正）。
    const impacts = this._findUnpublishedReferences(motifId);

    const records = [
      { kind: "MOTIF_REVISED", subjectId: motifId, payload: this._motifPayload(next) },
    ];
    for (const impact of impacts) {
      const tracks = [];
      if (changed.includes("markets") || changed.includes("rights_conditions")) tracks.push(TRACKS.RIGHTS);
      if (changed.includes("source_evidence") || changed.includes("transformation_bounds")) tracks.push(TRACKS.RESEARCH);
      if (tracks.length === 0) continue;
      const dep = impact.version.deps.find((d) => d.motif_id === motifId);
      records.push({
        kind: "SIGN_OFFS_INVALIDATED",
        subjectId: impact.pkg.id,
        payload: {
          package_id: impact.pkg.id,
          version_id: impact.version.id,
          tracks,
          reason: `元素 ${motifId} 由 v${dep.motif_version} 更新至 v${motif.currentNo + 1}：${changed.join("、")}发生变化，未发布稿件需重新引用并签署`,
          stale: {
            motif_id: motifId,
            from_version: dep.motif_version,
            to_version: motif.currentNo + 1,
            changes: changed,
          },
        },
      });
    }
    this.store.appendMany(records);
    return { motif_version: motif.currentNo + 1, changed, impacted_versions: impacts.map((i) => i.version.id) };
  }

  _requireMotifContent(input) {
    assert(input.source_evidence != null && input.source_evidence !== "", "来源证据 source_evidence 必填");
    assert(input.transformation_bounds != null, "可变形边界 transformation_bounds 必填");
    assert(input.rights_conditions != null, "权利条件 rights_conditions 必填");
    assert(Array.isArray(input.markets) && input.markets.length > 0, "适用市场 markets 至少一个");
  }

  _motifContent(input) {
    return {
      source_evidence: input.source_evidence ?? null,
      transformation_bounds: input.transformation_bounds ?? null,
      rights_conditions: input.rights_conditions ?? null,
      markets: [...input.markets].sort(),
    };
  }

  _motifPayload(input) {
    return {
      motif_id: input.motif_id,
      source_evidence: input.source_evidence,
      transformation_bounds: input.transformation_bounds,
      rights_conditions: input.rights_conditions,
      markets: [...input.markets],
      note: input.note ?? null,
    };
  }

  _diffMotif(current, next) {
    const changed = [];
    if (canonicalHash(next.source_evidence) !== canonicalHash(current.source_evidence)) changed.push("source_evidence");
    if (canonicalHash(next.transformation_bounds) !== canonicalHash(current.transformation_bounds)) changed.push("transformation_bounds");
    if (canonicalHash(next.rights_conditions) !== canonicalHash(current.rights_conditions)) changed.push("rights_conditions");
    if (canonicalHash([...next.markets].sort()) !== canonicalHash([...current.markets].sort())) changed.push("markets");
    return changed;
  }

  _findUnpublishedReferences(motifId) {
    const hits = [];
    for (const pkg of this.state.packages.values()) {
      if (pkg.release) continue; // 已上线包不回改
      for (const versionId of pkg.versionOrder) {
        const version = pkg.versions.get(versionId);
        if (version.status === "RELEASED") continue;
        if (version.deps.some((d) => d.motif_id === motifId)) hits.push({ pkg, version });
      }
    }
    return hits;
  }

  // ---- 发布包与稿件版本 -------------------------------------------------

  createPackage({ package_id, name, markets }) {
    assert(package_id, "package_id 必填");
    assert(Array.isArray(markets) && markets.length > 0, "发布包必须声明适用市场");
    assert(!this.state.packages.has(package_id), `发布包已存在：${package_id}`);
    this.store.append("PACKAGE_CREATED", package_id, {
      package_id,
      name: name ?? package_id,
      markets: [...markets],
    });
  }

  proposeVersion(input) {
    const pkg = this.state.packages.get(input.package_id);
    assert(pkg, `发布包不存在：${input.package_id}`);
    assert(input.version_id, "version_id 必填");
    assert(!pkg.versions.has(input.version_id), `稿件版本已存在：${input.version_id}`);
    assert(input.design_content != null && Object.keys(input.design_content).length > 0, "设计内容 design_content 必填");
    assert(Array.isArray(input.deps) && input.deps.length > 0, "稿件必须声明引用的元素版本");

    // 基线并发控制：base 必须是当前最新稿件，分叉修改被拒绝以防静默覆盖。
    const headId = pkg.versionOrder[pkg.versionOrder.length - 1] ?? null;
    const baseId = input.base_version_id ?? null;
    if (!headId) {
      assert(baseId === null, "首个稿件版本不能声明基线");
    } else {
      assert(baseId, `并行修改必须携带基线版本，当前最新版本为 ${headId}`);
      assert(pkg.versions.has(baseId), `基线版本不存在：${baseId}`);
      assert(baseId === headId, `基线 ${baseId} 已过期：存在更新的稿件 ${headId}，请基于最新版本重新修改，禁止静默覆盖`);
    }

    const deps = input.deps.map((dep) => {
      const motif = this.state.motifs.get(dep.motif_id);
      assert(motif, `元素不存在：${dep.motif_id}`);
      const no = dep.motif_version ?? motif.currentNo;
      const mv = motif.versions.get(no);
      assert(mv, `元素版本不存在：${dep.motif_id}@${no}`);
      // 新稿件只能引用元素最新版本：旧版本被取代后，继续钉用会绕过
      // “未发布稿件受影响、需重新出稿”的约束。历史版本仍随已发布成品保留溯源。
      assert(no === motif.currentNo, `元素 ${dep.motif_id} 的 v${no} 已被 v${motif.currentNo} 取代，新稿件必须引用最新版本`);
      const uncovered = pkg.markets.filter((market) => !mv.markets.includes(market));
      assert(uncovered.length === 0, `元素 ${dep.motif_id}@v${no} 未覆盖发布包市场：${uncovered.join(",")}`);
      return { motif_id: dep.motif_id, motif_version: no, content_hash: mv.content_hash };
    });
    const uniqueMotifs = new Set(deps.map((d) => d.motif_id));
    assert(uniqueMotifs.size === deps.length, "同一元素在一个稿件中只能引用一个版本");

    this.store.append("VERSION_PROPOSED", input.package_id, {
      package_id: input.package_id,
      version_id: input.version_id,
      base_version_id: baseId,
      design_content: input.design_content,
      deps,
    });
  }

  // ---- 审校意见与联合裁定 -----------------------------------------------

  addOpinion(input) {
    const pkg = this.state.packages.get(input.package_id);
    assert(pkg, `发布包不存在：${input.package_id}`);
    const version = pkg.versions.get(input.version_id);
    assert(version, `稿件版本不存在：${input.version_id}`);
    // 核心防护：意见永远绑定具体稿件；已发布旧稿不接受新意见，只能追加暂停/更正。
    assert(version.status !== "RELEASED", `稿件 ${input.version_id} 已发布，不能把新意见套到旧稿；请对上线包追加暂停或更正记录`);
    assert(input.opinion_id, "opinion_id 必填");
    assert(!pkg.opinions.some((o) => o.id === input.opinion_id), `意见编号重复：${input.opinion_id}`);
    assert(Object.values(STANCES).includes(input.stance), `意见立场必须是 ${Object.values(STANCES).join("/")}`);
    assert(input.author, "意见作者 author 必填");

    this.store.append("REVIEW_OPINION_ADDED", input.package_id, {
      package_id: input.package_id,
      version_id: input.version_id,
      opinion_id: input.opinion_id,
      author: input.author,
      role: input.role ?? null,
      stance: input.stance,
      content: input.content ?? "",
    });
    return pkg.opinions[pkg.opinions.length - 1];
  }

  openArbitration(input) {
    const pkg = this.state.packages.get(input.package_id);
    assert(pkg, `发布包不存在：${input.package_id}`);
    assert(pkg.versions.get(input.version_id), `稿件版本不存在：${input.version_id}`);
    assert(Array.isArray(input.opinion_ids) && input.opinion_ids.length >= 2, "议题至少绑定两条意见");
    assert(input.arbitration_id, "arbitration_id 必填");
    assert(!pkg.arbitrations.has(input.arbitration_id), `议题编号重复：${input.arbitration_id}`);
    const opinions = input.opinion_ids.map((id) => {
      const opinion = pkg.opinions.find((o) => o.id === id);
      assert(opinion, `意见不存在：${id}`);
      assert(opinion.version_id === input.version_id, `意见 ${id} 不属于稿件 ${input.version_id}`);
      assert(!opinion.arbitration_id, `意见 ${id} 已进入议题 ${opinion.arbitration_id}`);
      return opinion;
    });
    const stances = new Set(opinions.map((o) => o.stance));
    assert(
      stances.has(STANCES.OBJECT) && (stances.has(STANCES.APPROVE) || stances.has(STANCES.NEEDS_CHANGES)),
      "议题必须绑定相互冲突的意见（异议 对 赞同/修改）",
    );
    this.store.append("ARBITRATION_OPENED", input.package_id, {
      package_id: input.package_id,
      version_id: input.version_id,
      arbitration_id: input.arbitration_id,
      opinion_ids: [...input.opinion_ids],
      reason: input.reason ?? "",
    });
  }

  resolveArbitration(input) {
    const pkg = this.state.packages.get(input.package_id);
    assert(pkg, `发布包不存在：${input.package_id}`);
    const arbitration = pkg.arbitrations.get(input.arbitration_id);
    assert(arbitration, `议题不存在：${input.arbitration_id}`);
    assert(!arbitration.resolution, `议题已裁定：${input.arbitration_id}`);
    assert(Object.values(ARBITRATION_DECISIONS).includes(input.decision), `裁定结论必须是 ${Object.values(ARBITRATION_DECISIONS).join("/")}`);
    assert(Array.isArray(input.panel_ids) && input.panel_ids.length >= 2, "联合裁定需至少两名裁定人");
    this.store.append("ARBITRATION_RESOLVED", input.package_id, {
      package_id: input.package_id,
      arbitration_id: input.arbitration_id,
      decision: input.decision,
      rationale: input.rationale ?? "",
      panel_ids: [...input.panel_ids],
    });
    // 注意：即使结论是 CHANGE_DESIGN，也只在稿件上打“待修订”标记；
    // design_content 只能由设计者通过新版本修改，裁定不会自动覆盖设计。
  }

  // ---- 双轨签署（幂等） -------------------------------------------------

  signOff(input) {
    const pkg = this.state.packages.get(input.package_id);
    assert(pkg, `发布包不存在：${input.package_id}`);
    const version = pkg.versions.get(input.version_id);
    assert(version, `稿件版本不存在：${input.version_id}`);
    assert(version.status !== "RELEASED", `稿件 ${input.version_id} 已发布，签署只针对待发布版本`);
    assert(Object.values(TRACKS).includes(input.track), `审校线必须是 ${Object.values(TRACKS).join("/")}`);
    assert(input.signer_id, "signer_id 必填");
    assert(input.request_id, "签署请求 request_id 必填（用于幂等重放）");

    const fingerprint = {
      package_id: input.package_id,
      version_id: input.version_id,
      track: input.track,
      signer_id: input.signer_id,
      content_hash: version.content_hash,
      deps_hash: version.deps_hash,
    };

    // 重放优先：同一请求编号必须原样返回首次结果（即使该签署后来因依赖变化失效）。
    // 放在 stale/改稿等业务校验之前，保证“完全重放返回原结果”不被后续状态变化干扰。
    const existing = pkg.signOffs.find((s) => s.request_id === input.request_id);
    if (existing) {
      const same =
        existing.package_id === fingerprint.package_id &&
        existing.version_id === fingerprint.version_id &&
        existing.track === fingerprint.track &&
        existing.signer_id === fingerprint.signer_id &&
        existing.content_hash === fingerprint.content_hash &&
        existing.deps_hash === fingerprint.deps_hash;
      assert(same, `签署请求 ${input.request_id} 的内容与首次提交不一致，拒绝重放；请使用新的请求编号`);
      return { replayed: true, valid: !existing.invalidated, sign_off: existing };
    }

    const staleDeps = this._staleDeps(version);
    assert(staleDeps.length === 0, `稿件引用的元素已更新（${staleDeps.map((d) => d.motif_id).join(",")}），请基于新版本重新出稿后再签署`);
    assert(!version.awaiting_revision, `稿件 ${input.version_id} 被裁定要求改稿，请提交修订后的新稿件版本再签署`);
    const openArbitration = [...pkg.arbitrations.values()].some(
      (a) => a.version_id === version.id && !a.resolution,
    );
    assert(!openArbitration, `稿件 ${input.version_id} 尚有未裁定议题，不能签署`);
    assert(
      !pkg.signOffs.some((s) => s.version_id === version.id && s.track === input.track && !s.invalidated),
      `稿件 ${input.version_id} 的 ${input.track} 审校线已签署`,
    );

    const signOffId = input.sign_off_id ?? `so-${input.request_id}`;
    this.store.append("SIGN_OFF_RECORDED", input.package_id, {
      sign_off_id: signOffId,
      request_id: input.request_id,
      package_id: input.package_id,
      version_id: input.version_id,
      track: input.track,
      signer_id: input.signer_id,
      content_hash: version.content_hash,
      deps_hash: version.deps_hash,
    });
    return { replayed: false, valid: true, sign_off: pkg.signOffs[pkg.signOffs.length - 1] };
  }

  // 稿件引用的元素是否已出现新版本（元素版本不可变，当前版本号更大即过期）。
  _staleDeps(version) {
    return version.deps.filter((dep) => {
      const motif = this.state.motifs.get(dep.motif_id);
      const mv = motif?.versions.get(dep.motif_version);
      return !mv || mv.content_hash !== dep.content_hash || motif.currentNo !== dep.motif_version;
    });
  }

  _validSignOffs(pkg, version) {
    return pkg.signOffs.filter((s) => s.version_id === version.id && !s.invalidated);
  }

  // ---- 发布上线 ---------------------------------------------------------

  releasePackage(input) {
    const pkg = this.state.packages.get(input.package_id);
    assert(pkg, `发布包不存在：${input.package_id}`);
    assert(!pkg.release, `发布包 ${input.package_id} 已上线，变化只能以暂停/更正记录追加`);
    const versionId = input.version_id ?? pkg.versionOrder[pkg.versionOrder.length - 1];
    const version = pkg.versions.get(versionId);
    assert(version, `稿件版本不存在：${versionId}`);
    assert(!version.awaiting_revision, `稿件 ${versionId} 被裁定要求改稿，不能发布`);
    const open = [...pkg.arbitrations.values()].filter((a) => a.version_id === versionId && !a.resolution);
    assert(open.length === 0, `稿件 ${versionId} 尚有 ${open.length} 个未裁定议题，不能发布`);

    // 先核对双签覆盖：缺哪条线给出精确原因（失效签署不算有效签署）。
    const valid = this._validSignOffs(pkg, version);
    for (const track of Object.values(TRACKS)) {
      const match = valid.find((s) => s.track === track && s.content_hash === version.content_hash && s.deps_hash === version.deps_hash);
      assert(match, `稿件 ${versionId} 缺少 ${track} 审校线的有效签署`);
    }
    // 双签齐备时的最后防线：依赖必须仍为元素最新版本（正常流程下失效事件已先行阻止）。
    const staleDeps = this._staleDeps(version);
    assert(staleDeps.length === 0, `稿件 ${versionId} 引用的元素已更新，需重新出稿引用最新版本`);

    this.store.append("RELEASE_PACKAGE_APPROVED", input.package_id, {
      package_id: input.package_id,
      version_id: versionId,
      released_at: input.released_at,
    });
    return pkg.release;
  }

  // ---- 上线后：暂停与更正（只追加） -------------------------------------

  suspendReleased(input) {
    const pkg = this.state.packages.get(input.package_id);
    assert(pkg, `发布包不存在：${input.package_id}`);
    assert(pkg.release, `发布包 ${input.package_id} 尚未上线，不能暂停`);
    assert(input.reason, "暂停原因 reason 必填");
    this.store.append("VERSION_SUSPENDED", input.package_id, {
      package_id: input.package_id,
      version_id: pkg.release.version_id,
      reason: input.reason,
      notice: input.notice ?? input.reason,
      effective_at: input.effective_at,
    });
    return pkg.suspensions[pkg.suspensions.length - 1];
  }

  correctReleased(input) {
    const pkg = this.state.packages.get(input.package_id);
    assert(pkg, `发布包不存在：${input.package_id}`);
    assert(pkg.release, `发布包 ${input.package_id} 尚未上线，不能更正`);
    assert(input.correction, "更正内容 correction 必填");
    this.store.append("CORRECTION_RECORDED", input.package_id, {
      package_id: input.package_id,
      version_id: pkg.release.version_id,
      reason: input.reason ?? "",
      correction: input.correction,
      corrected_at: input.corrected_at,
    });
    return pkg.corrections[pkg.corrections.length - 1];
  }

  // ---- 查询：待裁定议题与暂停通知（重启后与事件一致） -------------------

  listOpenArbitrations(packageId = null) {
    const result = [];
    for (const pkg of this.state.packages.values()) {
      if (packageId && pkg.id !== packageId) continue;
      for (const arbitration of pkg.arbitrations.values()) {
        if (!arbitration.resolution) result.push(arbitration);
      }
    }
    return result;
  }

  listSuspensionNotices(packageId = null) {
    const result = [];
    for (const pkg of this.state.packages.values()) {
      if (packageId && pkg.id !== packageId) continue;
      result.push(...pkg.suspensions);
    }
    return result;
  }

  // ---- 成品溯源：元素、证据、意见、批准版本一路可追 ---------------------

  provenance(packageId) {
    const pkg = this.state.packages.get(packageId);
    assert(pkg, `发布包不存在：${packageId}`);
    assert(pkg.release, `发布包 ${packageId} 尚未上线，无成品溯源`);
    const version = pkg.versions.get(pkg.release.version_id);
    return {
      package_id: pkg.id,
      name: pkg.name,
      markets: [...pkg.markets],
      released_version: {
        version_id: version.id,
        content_hash: version.content_hash,
        deps_hash: version.deps_hash,
        release_event_id: pkg.release.event_id,
        released_at: pkg.release.released_at,
      },
      motifs: version.deps.map((dep) => {
        const motif = this.state.motifs.get(dep.motif_id);
        const mv = motif.versions.get(dep.motif_version);
        return {
          motif_id: dep.motif_id,
          motif_version: dep.motif_version,
          content_hash: mv.content_hash,
          source_evidence: mv.source_evidence,
          transformation_bounds: mv.transformation_bounds,
          rights_conditions: mv.rights_conditions,
          markets: [...mv.markets],
          proposed_event_id: mv.event_id,
        };
      }),
      opinions: pkg.opinions
        .filter((o) => o.version_id === version.id)
        .map((o) => ({
          opinion_id: o.id,
          author: o.author,
          role: o.role,
          stance: o.stance,
          content: o.content,
          deps_snapshot: o.deps_snapshot,
          event_id: o.created_event,
          arbitration_id: o.arbitration_id,
          resolution: o.resolved,
        })),
      arbitrations: [...pkg.arbitrations.values()]
        .filter((a) => a.version_id === version.id)
        .map((a) => ({
          arbitration_id: a.id,
          opinion_ids: [...a.opinion_ids],
          resolution: a.resolution,
        })),
      sign_offs: pkg.signOffs
        .filter((s) => s.version_id === version.id)
        .map((s) => ({
          track: s.track,
          signer_id: s.signer_id,
          request_id: s.request_id,
          valid: !s.invalidated,
          event_id: s.event_id,
        })),
      suspensions: pkg.suspensions.map((s) => ({ reason: s.reason, notice: s.notice, effective_at: s.effective_at, event_id: s.event_id })),
      corrections: pkg.corrections.map((c) => ({ reason: c.reason, correction: c.correction, corrected_at: c.corrected_at, event_id: c.event_id })),
    };
  }
}
