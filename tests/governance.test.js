import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../src/event_store.js";
import { GovernanceService, GovernanceError } from "../src/governance.js";
import { TRACKS, STANCES, ARBITRATION_DECISIONS } from "../src/projection.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "art-gov-"));
  const path = join(dir, "events.jsonl");
  const svc = () => new GovernanceService(openStore(path));
  const reopen = () => new GovernanceService(openStore(path));
  return { path, dir, svc, reopen, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const MOTIF = {
  motif_id: "m-cloud",
  source_evidence: { collection: "国家图书馆纹样档案", ref: "MS-1887-云纹-03", custodian: "公有领域核对单" },
  transformation_bounds: { allowed: ["换色", "等比缩放"], forbidden: ["打散重构", "用于宗教仿冒"], max_deviation: 0.15 },
  rights_conditions: { license: "CC-BY-4.0", attribution: "馆藏数字化件", territory: ["CN", "SG"], expiry: null },
  markets: ["CN", "SG"],
};

function seedMotif(gov, motif = MOTIF) {
  gov.proposeMotif(motif);
}

function seedPackageWithVersion(gov, { packageId = "pkg-cn-sg", versionId = "v1", motifVersion } = {}) {
  gov.createPackage({ package_id: packageId, name: "祥云主视觉", markets: ["CN", "SG"] });
  gov.proposeVersion({
    package_id: packageId,
    version_id: versionId,
    design_content: { title: "祥云海报", layers: ["cloud-main", "palette-indigo"] },
    deps: [{ motif_id: "m-cloud", motif_version: motifVersion }],
  });
  return packageId;
}

test("元素提案保存来源证据、可变形边界、权利条件与适用市场", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const motif = gov.state.motifs.get("m-cloud");
    assert.equal(motif.currentNo, 1);
    const v1 = motif.versions.get(1);
    assert.equal(v1.source_evidence.ref, "MS-1887-云纹-03");
    assert.deepEqual(v1.transformation_bounds.allowed, ["换色", "等比缩放"]);
    assert.equal(v1.rights_conditions.license, "CC-BY-4.0");
    assert.deepEqual(v1.markets, ["CN", "SG"]);
    assert.match(v1.content_hash, /^[0-9a-f]{64}$/);

    assert.throws(() => gov.proposeMotif({ ...MOTIF, source_evidence: "" }), GovernanceError);
  } finally {
    h.cleanup();
  }
});

test("稿件只能引用覆盖本发布包市场的元素版本", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    gov.createPackage({ package_id: "pkg-eu", name: "欧盟版", markets: ["DE"] });
    assert.throws(
      () => gov.proposeVersion({
        package_id: "pkg-eu",
        version_id: "v1",
        design_content: { title: "x" },
        deps: [{ motif_id: "m-cloud" }],
      }),
      /未覆盖发布包市场：DE/,
    );
  } finally {
    h.cleanup();
  }
});

test("新意见绑定具体稿件与依赖版本快照，且不能套到已发布旧稿", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov);

    const opinion = gov.addOpinion({
      package_id: pkgId, version_id: "v1", opinion_id: "op-1",
      author: "researcher-lin", role: "民俗研究", stance: STANCES.APPROVE,
      content: "云纹结构符合晚清江南样式",
    });
    assert.deepEqual(opinion.deps_snapshot, [{ motif_id: "m-cloud", motif_version: 1, content_hash: opinion.deps_snapshot[0].content_hash }]);

    // 双签后上线
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r-head", request_id: "req-r-1" });
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l-head", request_id: "req-l-1" });
    gov.releasePackage({ package_id: pkgId });

    // 关键防护：上线后新来的研究意见不能套到 v1 旧稿
    assert.throws(
      () => gov.addOpinion({
        package_id: pkgId, version_id: "v1", opinion_id: "op-late",
        author: "researcher-new", stance: STANCES.OBJECT, content: "事后发现问题",
      }),
      /已发布，不能把新意见套到旧稿/,
    );
    // 正确路径：对上线包追加暂停或更正
    const susp = gov.suspendReleased({ package_id: pkgId, reason: "新研究意见需复核", notice: "暂停 CN/SG 投放" });
    assert.equal(susp.version_id, "v1");
  } finally {
    h.cleanup();
  }
});

test("冲突意见进入联合裁定，裁定不自动覆盖设计", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov);
    gov.addOpinion({ package_id: pkgId, version_id: "v1", opinion_id: "op-a", author: "lin", stance: STANCES.APPROVE, content: "可以用" });
    gov.addOpinion({ package_id: pkgId, version_id: "v1", opinion_id: "op-b", author: "wang", stance: STANCES.OBJECT, content: "变形超出边界" });

    // 立场不冲突的意见组不能开议题
    gov.addOpinion({ package_id: pkgId, version_id: "v1", opinion_id: "op-c", author: "zhao", stance: STANCES.APPROVE, content: "也赞同" });
    assert.throws(() => gov.openArbitration({ package_id: pkgId, version_id: "v1", arbitration_id: "arb-bad", opinion_ids: ["op-a", "op-c"] }), GovernanceError);

    gov.openArbitration({ package_id: pkgId, version_id: "v1", arbitration_id: "arb-1", opinion_ids: ["op-a", "op-b"], reason: "研究意见冲突" });
    assert.equal(gov.listOpenArbitrations(pkgId).length, 1);
    // 有未裁定议题时不能签署、不能发布
    assert.throws(() => gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "req-x" }), /未裁定议题/);

    const before = JSON.stringify(gov.state.packages.get(pkgId).versions.get("v1").design_content);
    gov.resolveArbitration({ package_id: pkgId, arbitration_id: "arb-1", decision: ARBITRATION_DECISIONS.CHANGE_DESIGN, rationale: "需回调变形幅度", panel_ids: ["p1", "p2"] });
    const after = JSON.stringify(gov.state.packages.get(pkgId).versions.get("v1").design_content);
    assert.equal(before, after, "裁定不得自动改写设计内容");
    assert.equal(gov.state.packages.get(pkgId).versions.get("v1").awaiting_revision, true);
    assert.equal(gov.listOpenArbitrations(pkgId).length, 0);
    // 被要求改稿后，旧稿仍不能直接签署
    assert.throws(() => gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "req-x" }), /要求改稿/);

    // 设计者基于最新基线提交新版本，流程继续
    gov.proposeVersion({ package_id: pkgId, version_id: "v2", base_version_id: "v1", design_content: { title: "祥云海报", layers: ["cloud-main", "palette-indigo", "bounds-clamped"] }, deps: [{ motif_id: "m-cloud" }] });
    gov.signOff({ package_id: pkgId, version_id: "v2", track: TRACKS.RESEARCH, signer_id: "r-head", request_id: "req-r-2" });
    gov.signOff({ package_id: pkgId, version_id: "v2", track: TRACKS.RIGHTS, signer_id: "l-head", request_id: "req-l-2" });
    const release = gov.releasePackage({ package_id: pkgId, version_id: "v2" });
    assert.equal(release.version_id, "v2");
  } finally {
    h.cleanup();
  }
});

test("发布需要研究审校与权利审校分别签署，缺一条线即拒绝", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov);
    assert.throws(() => gov.releasePackage({ package_id: pkgId }), /缺少 RESEARCH/);
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "req-r" });
    assert.throws(() => gov.releasePackage({ package_id: pkgId }), /缺少 RIGHTS/);
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "req-l" });
    assert.equal(gov.releasePackage({ package_id: pkgId }).version_id, "v1");
    // 已上线不能重复发布
    assert.throws(() => gov.releasePackage({ package_id: pkgId, version_id: "v1" }), /已上线/);
  } finally {
    h.cleanup();
  }
});

test("素材授权变化只影响引用它的未发布版本：权利签署失效，研究签署保留；已上线包不动", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    // 包 A：未发布，已完成双签
    const pkgA = "pkg-a";
    seedPackageWithVersion(gov, { packageId: pkgA });
    gov.signOff({ package_id: pkgA, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "a-r" });
    gov.signOff({ package_id: pkgA, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "a-l" });
    // 包 B：走完发布已上线
    const pkgB = "pkg-b";
    seedPackageWithVersion(gov, { packageId: pkgB });
    gov.signOff({ package_id: pkgB, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "b-r" });
    gov.signOff({ package_id: pkgB, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "b-l" });
    gov.releasePackage({ package_id: pkgB });

    // 授权条款变化
    const result = gov.reviseMotif("m-cloud", { rights_conditions: { license: "CC-BY-NC-4.0", attribution: "馆藏数字化件", territory: ["CN", "SG"], expiry: null } });
    assert.deepEqual(result.changed, ["rights_conditions"]);
    assert.deepEqual(result.impacted_versions, ["v1"], "只影响未发布包 A 的稿件；已上线包 B 不出现");

    const aPkg = gov.state.packages.get(pkgA);
    const soResearch = aPkg.signOffs.find((s) => s.track === TRACKS.RESEARCH);
    const soRights = aPkg.signOffs.find((s) => s.track === TRACKS.RIGHTS);
    assert.equal(soResearch.invalidated, false, "研究签署不受授权变化影响");
    assert.equal(soRights.invalidated, true, "权利签署应失效");
    // 失效签署不能放行发布
    assert.throws(() => gov.releasePackage({ package_id: pkgA }), /缺少 RIGHTS/);
    // 引用过期元素版本的旧稿也不能直接补签
    assert.throws(() => gov.signOff({ package_id: pkgA, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l2", request_id: "a-l-2" }), /引用的元素已更新/);

    // 已上线包 B 完全不受修订影响，也不在受影响列表中
    assert.equal(gov.state.packages.get(pkgB).release.version_id, "v1");
    assert.equal(gov.state.packages.get(pkgB).signOffs.every((s) => !s.invalidated), true);
  } finally {
    h.cleanup();
  }
});

test("市场范围收缩只波未发布版本；须以覆盖范围内的新包引用新元素版本重新出稿签署", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov);
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "r1" });
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "l1" });

    // 元素市场收缩至 CN，产生 v2
    gov.reviseMotif("m-cloud", { markets: ["CN"] });
    // 原 CN/SG 包的权利签署失效，不能带过期签署发布
    assert.equal(gov.state.packages.get(pkgId).signOffs.filter((s) => s.track === TRACKS.RIGHTS)[0].invalidated, true);
    // 新稿钉用已被取代的 v1 → 拒绝
    assert.throws(
      () => gov.proposeVersion({ package_id: pkgId, version_id: "v2-pin-old", base_version_id: "v1", design_content: { title: "x" }, deps: [{ motif_id: "m-cloud", motif_version: 1 }] }),
      /已被 v2 取代/,
    );
    // 新稿引用最新 v2，但 v2 不覆盖 SG → 仍拒绝
    assert.throws(
      () => gov.proposeVersion({ package_id: pkgId, version_id: "v2-uncov", base_version_id: "v1", design_content: { title: "x" }, deps: [{ motif_id: "m-cloud", motif_version: 2 }] }),
      /未覆盖发布包市场：SG/,
    );

    // 正确路径：市场收缩后的新包声明 CN 范围，引用元素 v2 走完整双签发布
    const pkgCn = "pkg-cn";
    gov.createPackage({ package_id: pkgCn, name: "祥云主视觉-CN", markets: ["CN"] });
    gov.proposeVersion({ package_id: pkgCn, version_id: "v1", design_content: { title: "CN 版" }, deps: [{ motif_id: "m-cloud", motif_version: 2 }] });
    gov.signOff({ package_id: pkgCn, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "cn-r" });
    gov.signOff({ package_id: pkgCn, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "cn-l" });
    assert.equal(gov.releasePackage({ package_id: pkgCn }).version_id, "v1");
  } finally {
    h.cleanup();
  }
});

test("并行修改以基线版本检测分叉，防止静默覆盖", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov); // v1 是当前头版本
    // 设计者甲基于 v1 提交 v2
    gov.proposeVersion({ package_id: pkgId, version_id: "v2", base_version_id: "v1", design_content: { title: "甲的修改" }, deps: [{ motif_id: "m-cloud" }] });
    // 设计者乙仍基于过期的 v1 提交 → 拒绝
    assert.throws(
      () => gov.proposeVersion({ package_id: pkgId, version_id: "v3-stale", base_version_id: "v1", design_content: { title: "乙的修改" }, deps: [{ motif_id: "m-cloud" }] }),
      /基线 v1 已过期/,
    );
    // 乙基于最新基线 v2 重做后成功
    gov.proposeVersion({ package_id: pkgId, version_id: "v3", base_version_id: "v2", design_content: { title: "乙合入后的修改" }, deps: [{ motif_id: "m-cloud" }] });
    assert.deepEqual(gov.state.packages.get(pkgId).versionOrder, ["v1", "v2", "v3"]);
    // 无基线的并行首稿也被拒绝
    assert.throws(() => gov.proposeVersion({ package_id: pkgId, version_id: "v4", design_content: { title: "漏带基线" }, deps: [{ motif_id: "m-cloud" }] }), /必须携带基线/);
  } finally {
    h.cleanup();
  }
});

test("同一签署请求完全重放返回原结果；内容变化则拒绝", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov);

    const first = gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r-head", request_id: "req-idem" });
    assert.equal(first.replayed, false);
    // 完全相同的请求重放：返回同一签署、不产生新事件
    const eventCount = gov.state.events.size;
    const replay = gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r-head", request_id: "req-idem" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.sign_off.event_id, first.sign_off.event_id);
    assert.equal(gov.state.events.size, eventCount);

    // 同一请求编号换了审校线 → 内容变化，拒绝
    assert.throws(() => gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "r-head", request_id: "req-idem" }), /内容与首次提交不一致/);
    // 同一请求编号挪到另一稿件（内容哈希不同）→ 拒绝
    gov.proposeVersion({ package_id: pkgId, version_id: "v2", base_version_id: "v1", design_content: { title: "改稿" }, deps: [{ motif_id: "m-cloud" }] });
    assert.throws(() => gov.signOff({ package_id: pkgId, version_id: "v2", track: TRACKS.RESEARCH, signer_id: "r-head", request_id: "req-idem" }), /内容与首次提交不一致/);
  } finally {
    h.cleanup();
  }
});

test("元素修订失效的签署，在重新签署后重放仍如实返回失效状态", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov);
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "req-l" });
    gov.reviseMotif("m-cloud", { rights_conditions: { license: "CC-BY-NC-4.0", attribution: "x", territory: ["CN", "SG"], expiry: null } });
    const replay = gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "req-l" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.valid, false, "重放返回原签署记录，但标注其已失效");
  } finally {
    h.cleanup();
  }
});

test("服务重启后待裁定议题与暂停通知保持一致，成品溯源完整", () => {
  const h = harness();
  try {
    let gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov);
    gov.addOpinion({ package_id: pkgId, version_id: "v1", opinion_id: "op-a", author: "lin", stance: STANCES.APPROVE, content: "可用" });
    gov.addOpinion({ package_id: pkgId, version_id: "v1", opinion_id: "op-b", author: "wang", stance: STANCES.OBJECT, content: "越界" });
    gov.openArbitration({ package_id: pkgId, version_id: "v1", arbitration_id: "arb-1", opinion_ids: ["op-a", "op-b"], reason: "冲突" });
    // 另一个包走完上线并暂停、更正
    const pkg2 = "pkg-live";
    seedPackageWithVersion(gov, { packageId: pkg2 });
    gov.signOff({ package_id: pkg2, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "p2-r" });
    gov.signOff({ package_id: pkg2, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "p2-l" });
    gov.releasePackage({ package_id: pkg2 });
    gov.suspendReleased({ package_id: pkg2, reason: "授权方发起复核", notice: "暂停全部市场投放" });
    gov.correctReleased({ package_id: pkg2, reason: "署名遗漏", correction: "补充馆藏数字化署名" });

    // 重启：重新加载事件文件
    gov = h.reopen();
    assert.equal(gov.listOpenArbitrations().length, 1);
    assert.equal(gov.listOpenArbitrations()[0].id, "arb-1");
    const notices = gov.listSuspensionNotices();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].notice, "暂停全部市场投放");

    const trace = gov.provenance(pkg2);
    assert.equal(trace.released_version.version_id, "v1");
    assert.equal(trace.motifs.length, 1);
    assert.equal(trace.motifs[0].source_evidence.ref, "MS-1887-云纹-03");
    assert.equal(trace.motifs[0].rights_conditions.license, "CC-BY-4.0");
    assert.deepEqual(trace.sign_offs.map((s) => s.track).sort(), [TRACKS.RESEARCH, TRACKS.RIGHTS]);
    assert.ok(trace.sign_offs.every((s) => s.valid));
    assert.equal(trace.suspensions[0].reason, "授权方发起复核");
    assert.equal(trace.corrections[0].correction, "补充馆藏数字化署名");
    // 溯源中的每个环节都带事件编号，可一路回查原始事件
    for (const motif of trace.motifs) assert.ok(motif.proposed_event_id);
    for (const so of trace.sign_offs) assert.ok(so.event_id);
    assert.ok(trace.released_version.release_event_id);
    assert.ok(trace.suspensions[0].event_id && trace.corrections[0].event_id);
  } finally {
    h.cleanup();
  }
});

test("源证据修订影响研究签署线而非权利签署线", () => {
  const h = harness();
  try {
    const gov = h.svc();
    seedMotif(gov);
    const pkgId = seedPackageWithVersion(gov);
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RESEARCH, signer_id: "r", request_id: "r1" });
    gov.signOff({ package_id: pkgId, version_id: "v1", track: TRACKS.RIGHTS, signer_id: "l", request_id: "l1" });
    gov.reviseMotif("m-cloud", { source_evidence: { collection: "省级档案馆", ref: "ZJ-云纹-11", custodian: "授权核对" } });
    const pkg = gov.state.packages.get(pkgId);
    assert.equal(pkg.signOffs.find((s) => s.track === TRACKS.RESEARCH).invalidated, true);
    assert.equal(pkg.signOffs.find((s) => s.track === TRACKS.RIGHTS).invalidated, false);
  } finally {
    h.cleanup();
  }
});
