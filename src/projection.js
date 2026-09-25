// 投影：把不可变事件流重放成可查询状态。
// applyEvent 是纯函数（除 Map 引用更新外不产生外部效果），
// 重启恢复与在线追加走同一条路径，保证两边状态一致。

import { canonicalHash } from "./hashing.js";

export const TRACKS = Object.freeze({ RESEARCH: "RESEARCH", RIGHTS: "RIGHTS" });
export const STANCES = Object.freeze({ APPROVE: "APPROVE", OBJECT: "OBJECT", NEEDS_CHANGES: "NEEDS_CHANGES" });
export const ARBITRATION_DECISIONS = Object.freeze({
  REJECT_OBJECTION: "REJECT_OBJECTION", // 异议不成立，维持现稿
  CHANGE_DESIGN: "CHANGE_DESIGN", // 要求改稿（只做标记，不自动覆盖设计）
  HOLD: "HOLD", // 搁置，等待新材料
});

export function createInitialState() {
  return {
    events: new Map(), // event_id -> event
    motifs: new Map(), // motif_id -> 聚合
    packages: new Map(), // package_id -> 聚合
  };
}

function requireMotif(state, motifId) {
  const motif = state.motifs.get(motifId);
  if (!motif) throw new Error(`元素不存在：${motifId}`);
  return motif;
}

function requirePackage(state, packageId) {
  const pkg = state.packages.get(packageId);
  if (!pkg) throw new Error(`发布包不存在：${packageId}`);
  return pkg;
}

function motifVersionContent(payload) {
  return {
    source_evidence: payload.source_evidence ?? null,
    transformation_bounds: payload.transformation_bounds ?? null,
    rights_conditions: payload.rights_conditions ?? null,
    markets: [...(payload.markets ?? [])].sort(),
  };
}

function putMotifVersion(motif, payload, event) {
  const no = motif.currentNo + 1;
  const version = {
    motif_id: motif.id,
    no,
    event_id: event.event_id,
    source_evidence: payload.source_evidence ?? null,
    transformation_bounds: payload.transformation_bounds ?? null,
    rights_conditions: payload.rights_conditions ?? null,
    markets: [...(payload.markets ?? [])],
    note: payload.note ?? null,
    content_hash: canonicalHash(motifVersionContent(payload)),
  };
  motif.versions.set(no, version);
  motif.currentNo = no;
  return version;
}

function snapshotDeps(pkg, version) {
  return version.deps.map((dep) => ({
    motif_id: dep.motif_id,
    motif_version: dep.motif_version,
    content_hash: dep.content_hash,
  }));
}

export function applyEvent(state, event) {
  if (state.events.has(event.event_id)) throw new Error(`事件编号重复：${event.event_id}`);
  state.events.set(event.event_id, event);
  const p = event.payload ?? {};

  switch (event.kind) {
    case "MOTIF_PROPOSED": {
      if (state.motifs.has(p.motif_id)) throw new Error(`元素已存在：${p.motif_id}`);
      const motif = { id: p.motif_id, currentNo: 0, versions: new Map() };
      state.motifs.set(p.motif_id, motif);
      putMotifVersion(motif, p, event);
      break;
    }

    case "MOTIF_REVISED": {
      const motif = requireMotif(state, p.motif_id);
      putMotifVersion(motif, p, event);
      break;
    }

    // 兼容基线事件：存在目标元素时把权利条件变化登记为新版本。
    case "RIGHTS_CONDITION_SET": {
      const motif = p.motif_id ? state.motifs.get(p.motif_id) : null;
      if (motif) {
        const current = motif.versions.get(motif.currentNo);
        putMotifVersion(
          motif,
          {
            source_evidence: current.source_evidence,
            transformation_bounds: current.transformation_bounds,
            rights_conditions: p.rights_conditions ?? current.rights_conditions,
            markets: p.markets ?? current.markets,
            note: p.note ?? current.note,
          },
          event,
        );
      }
      break;
    }

    case "PACKAGE_CREATED": {
      if (state.packages.has(p.package_id)) throw new Error(`发布包已存在：${p.package_id}`);
      state.packages.set(p.package_id, {
        id: p.package_id,
        name: p.name ?? p.package_id,
        markets: [...(p.markets ?? [])],
        created_event: event.event_id,
        versions: new Map(), // version_id -> 稿件版本
        versionOrder: [],
        opinions: [],
        arbitrations: new Map(),
        signOffs: [],
        release: null,
        suspensions: [],
        corrections: [],
      });
      break;
    }

    case "VERSION_PROPOSED": {
      const pkg = requirePackage(state, p.package_id);
      if (pkg.versions.has(p.version_id)) throw new Error(`稿件版本已存在：${p.version_id}`);
      if (p.base_version_id && !pkg.versions.has(p.base_version_id)) {
        throw new Error(`基线版本不存在：${p.base_version_id}`);
      }
      const deps = (p.deps ?? []).map((dep) => {
        const motif = requireMotif(state, dep.motif_id);
        const mv = motif.versions.get(dep.motif_version);
        if (!mv) throw new Error(`元素版本不存在：${dep.motif_id}@${dep.motif_version}`);
        const uncovered = pkg.markets.filter((market) => !mv.markets.includes(market));
        if (uncovered.length) {
          throw new Error(`元素 ${dep.motif_id}@${dep.motif_version} 未覆盖发布包市场：${uncovered.join(",")}`);
        }
        return { motif_id: dep.motif_id, motif_version: dep.motif_version, content_hash: mv.content_hash };
      });
      const designContent = p.design_content ?? {};
      const version = {
        id: p.version_id,
        seq: pkg.versionOrder.length + 1,
        package_id: p.package_id,
        base_version_id: p.base_version_id ?? null,
        design_content: designContent,
        content_hash: canonicalHash(designContent),
        deps,
        deps_hash: canonicalHash(deps),
        status: "PROPOSED",
        awaiting_revision: false,
        proposed_event: event.event_id,
      };
      pkg.versions.set(version.id, version);
      pkg.versionOrder.push(version.id);
      break;
    }

    case "REVIEW_OPINION_ADDED": {
      const pkg = requirePackage(state, p.package_id);
      const version = pkg.versions.get(p.version_id);
      if (!version) throw new Error(`稿件版本不存在：${p.version_id}`);
      if (pkg.opinions.some((o) => o.id === p.opinion_id)) throw new Error(`意见编号重复：${p.opinion_id}`);
      pkg.opinions.push({
        id: p.opinion_id,
        package_id: p.package_id,
        version_id: p.version_id,
        deps_snapshot: snapshotDeps(pkg, version),
        author: p.author,
        role: p.role ?? null,
        stance: p.stance,
        content: p.content ?? "",
        content_hash: canonicalHash({ stance: p.stance, content: p.content ?? "", author: p.author }),
        created_event: event.event_id,
        created_at: event.occurred_at,
        arbitration_id: null,
        resolved: null,
      });
      break;
    }

    case "ARBITRATION_OPENED": {
      const pkg = requirePackage(state, p.package_id);
      if (pkg.arbitrations.has(p.arbitration_id)) throw new Error(`议题编号重复：${p.arbitration_id}`);
      const opinions = p.opinion_ids.map((opinionId) => {
        const opinion = pkg.opinions.find((o) => o.id === opinionId);
        if (!opinion) throw new Error(`意见不存在：${opinionId}`);
        if (opinion.version_id !== p.version_id) throw new Error(`意见 ${opinionId} 不属于稿件 ${p.version_id}`);
        if (opinion.arbitration_id) throw new Error(`意见 ${opinionId} 已进入议题 ${opinion.arbitration_id}`);
        return opinion;
      });
      const stances = new Set(opinions.map((o) => o.stance));
      if (!(stances.has(STANCES.OBJECT) && (stances.has(STANCES.APPROVE) || stances.has(STANCES.NEEDS_CHANGES)))) {
        throw new Error("议题必须绑定相互冲突的意见（至少一条异议与一条赞同/修改意见）");
      }
      pkg.arbitrations.set(p.arbitration_id, {
        id: p.arbitration_id,
        package_id: p.package_id,
        version_id: p.version_id,
        opinion_ids: [...p.opinion_ids],
        reason: p.reason ?? "",
        opened_at: event.occurred_at,
        opened_event: event.event_id,
        resolution: null,
      });
      for (const opinion of opinions) opinion.arbitration_id = p.arbitration_id;
      break;
    }

    case "ARBITRATION_RESOLVED": {
      const pkg = requirePackage(state, p.package_id);
      const arbitration = pkg.arbitrations.get(p.arbitration_id);
      if (!arbitration) throw new Error(`议题不存在：${p.arbitration_id}`);
      if (arbitration.resolution) throw new Error(`议题已裁定：${p.arbitration_id}`);
      arbitration.resolution = {
        decision: p.decision,
        rationale: p.rationale ?? "",
        panel_ids: [...(p.panel_ids ?? [])],
        decided_at: event.occurred_at,
        event_id: event.event_id,
      };
      for (const opinion of pkg.opinions.filter((o) => arbitration.opinion_ids.includes(o.id))) {
        opinion.resolved = { arbitration_id: arbitration.id, decision: p.decision };
      }
      // 只做“需要改稿”标记；design_content 永远不被裁定自动改写。
      if (p.decision === ARBITRATION_DECISIONS.CHANGE_DESIGN) {
        const version = pkg.versions.get(arbitration.version_id);
        version.awaiting_revision = true;
      }
      break;
    }

    case "SIGN_OFF_RECORDED": {
      const pkg = requirePackage(state, p.package_id);
      if (!pkg.versions.get(p.version_id)) throw new Error(`稿件版本不存在：${p.version_id}`);
      if (pkg.signOffs.some((s) => s.request_id === p.request_id)) {
        throw new Error(`签署请求编号重复：${p.request_id}`);
      }
      pkg.signOffs.push({
        id: p.sign_off_id,
        request_id: p.request_id,
        package_id: p.package_id,
        version_id: p.version_id,
        track: p.track,
        signer_id: p.signer_id,
        content_hash: p.content_hash,
        deps_hash: p.deps_hash,
        created_at: event.occurred_at,
        event_id: event.event_id,
        invalidated: false,
        invalidated_reason: null,
      });
      break;
    }

    case "SIGN_OFFS_INVALIDATED": {
      const pkg = requirePackage(state, p.package_id);
      for (const signOff of pkg.signOffs) {
        if (signOff.version_id !== p.version_id || signOff.invalidated) continue;
        if (p.tracks && !p.tracks.includes(signOff.track)) continue;
        signOff.invalidated = true;
        signOff.invalidated_reason = p.reason ?? "依赖的元素版本发生变化";
      }
      break;
    }

    case "RELEASE_PACKAGE_APPROVED": {
      const pkg = requirePackage(state, p.package_id);
      const version = pkg.versions.get(p.version_id);
      if (!version) throw new Error(`稿件版本不存在：${p.version_id}`);
      if (pkg.release) throw new Error(`发布包已上线：${p.package_id}`);
      version.status = "RELEASED";
      pkg.release = {
        package_id: p.package_id,
        version_id: p.version_id,
        content_hash: version.content_hash,
        deps_hash: version.deps_hash,
        released_at: p.released_at ?? event.occurred_at,
        event_id: event.event_id,
      };
      break;
    }

    case "VERSION_SUSPENDED": {
      const pkg = requirePackage(state, p.package_id);
      if (!pkg.release) throw new Error(`发布包尚未上线，不能暂停：${p.package_id}`);
      pkg.suspensions.push({
        package_id: p.package_id,
        version_id: p.version_id ?? pkg.release.version_id,
        reason: p.reason ?? "",
        notice: p.notice ?? p.reason ?? "",
        effective_at: p.effective_at ?? event.occurred_at,
        event_id: event.event_id,
      });
      break;
    }

    case "CORRECTION_RECORDED": {
      const pkg = requirePackage(state, p.package_id);
      if (!pkg.release) throw new Error(`发布包尚未上线，不能更正：${p.package_id}`);
      pkg.corrections.push({
        package_id: p.package_id,
        version_id: p.version_id ?? pkg.release.version_id,
        reason: p.reason ?? "",
        correction: p.correction ?? "",
        corrected_at: p.corrected_at ?? event.occurred_at,
        event_id: event.event_id,
      });
      break;
    }

    default:
      throw new Error(`未知事件种类：${event.kind}`);
  }

  return state;
}
