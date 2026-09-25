import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateEvent } from "../src/art_motif_review.js";
import { GovernanceService } from "../src/governance_service.js";

async function boot(t) {
  const dir = await mkdtemp(join(tmpdir(), "motif-governance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storagePath = join(dir, "state.json");
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 25, 9, 0, 0) + tick++ * 1000).toISOString();
  const service = await GovernanceService.open({ storagePath, now });
  return { service, storagePath, now };
}

function motifInput(overrides = {}) {
  return {
    title: "云纹",
    provenance: [
      { source: "某博物馆藏明清织物纹样拓片", evidence_id: "ev-0001", note: "馆藏编号 F-221" },
      { source: "《传统纹样谱》第三章", evidence_id: "ev-0002" },
    ],
    deform_bounds: { max_stretch_ratio: 0.15, allow_recolor: true, forbidden_transforms: ["镜像翻转"] },
    rights: { license: "博物馆授权-2026-031", holder: "某博物馆", conditions: ["保留署名", "禁止商标注册"] },
    markets: ["CN", "JP", "US"],
    ...overrides,
  };
}

async function seedMotifAndDraft(service) {
  const motif = await service.proposeMotif(motifInput());
  const draft = await service.createDraft({
    motif_refs: [{ motif_id: motif.motif_id, motif_version: 1 }],
    content: { layout: "banner-v1", palette: ["朱红", "石青"] },
  });
  return { motif, draft };
}

async function signBothAndPublish(service, packageId) {
  await service.signPackage({ package_id: packageId, base_version: 1, role: "research", signer: "研究审校-林", request_id: `req-${packageId}-r` });
  await service.signPackage({ package_id: packageId, base_version: 2, role: "rights", signer: "权利审校-周", request_id: `req-${packageId}-l` });
  return service.publishPackage({ package_id: packageId, base_version: 3 });
}

test("元素提案保存来源证据、可变形边界、权利条件与适用市场", async (t) => {
  const { service } = await boot(t);
  const motif = await service.proposeMotif(motifInput());
  assert.equal(motif.version, 1);
  assert.equal(motif.provenance.length, 2);
  assert.equal(motif.provenance[0].source, "某博物馆藏明清织物纹样拓片");
  assert.deepEqual(motif.deform_bounds.forbidden_transforms, ["镜像翻转"]);
  assert.equal(motif.rights.license, "博物馆授权-2026-031");
  assert.deepEqual(motif.rights.conditions, ["保留署名", "禁止商标注册"]);
  assert.deepEqual(motif.markets, ["CN", "JP", "US"]);
});

test("并行修改以基线版本防止静默覆盖", async (t) => {
  const { service } = await boot(t);
  const { motif, draft } = await seedMotifAndDraft(service);

  const updated = await service.updateMotif({ motif_id: motif.motif_id, base_version: 1, patch: { title: "云纹·变体" } });
  assert.equal(updated.version, 2);
  await assert.rejects(
    service.updateMotif({ motif_id: motif.motif_id, base_version: 1, patch: { title: "并行修改" } }),
    (error) => error.code === "VERSION_CONFLICT" && error.details.expected === 2,
  );

  const revised = await service.reviseDraft({ draft_id: draft.draft_id, base_version: 1, content: { layout: "banner-v2" } });
  assert.equal(revised.version, 2);
  await assert.rejects(
    service.reviseDraft({ draft_id: draft.draft_id, base_version: 1, content: { layout: "banner-v3" } }),
    (error) => error.code === "VERSION_CONFLICT",
  );
});

test("专家意见绑定具体稿件与依赖版本，拒绝套到已发布旧稿", async (t) => {
  const { service } = await boot(t);
  const { motif, draft } = await seedMotifAndDraft(service);
  const deps = { [motif.motif_id]: 1 };

  await assert.rejects(
    service.addOpinion({ draft_id: draft.draft_id, draft_version: 9, dependency_versions: deps, expert: "专家甲", stance: "endorse" }),
    (error) => error.code === "STALE_TARGET",
  );
  await assert.rejects(
    service.addOpinion({
      draft_id: draft.draft_id,
      draft_version: 1,
      dependency_versions: { [motif.motif_id]: 7 },
      expert: "专家甲",
      stance: "endorse",
    }),
    (error) => error.code === "STALE_TARGET",
  );

  const { opinion, adjudication } = await service.addOpinion({
    draft_id: draft.draft_id,
    draft_version: 1,
    dependency_versions: deps,
    expert: "专家甲",
    stance: "comment",
    body: "建议补充出处说明",
  });
  assert.equal(opinion.status, "open");
  assert.equal(adjudication, null);

  const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN"] });
  await signBothAndPublish(service, pkg.package_id);

  await assert.rejects(
    service.addOpinion({ draft_id: draft.draft_id, draft_version: 1, dependency_versions: deps, expert: "专家乙", stance: "object" }),
    (error) => error.code === "STATE_CONFLICT",
  );
});

test("冲突意见进入联合裁定，裁定不自动覆盖设计", async (t) => {
  const { service } = await boot(t);
  const { motif, draft } = await seedMotifAndDraft(service);
  const deps = { [motif.motif_id]: 1 };

  await service.addOpinion({ draft_id: draft.draft_id, draft_version: 1, dependency_versions: deps, expert: "专家甲", stance: "endorse" });
  const second = await service.addOpinion({
    draft_id: draft.draft_id,
    draft_version: 1,
    dependency_versions: deps,
    expert: "专家乙",
    stance: "object",
    body: "市场授权链存疑",
  });
  assert.equal(second.opinion.status, "in_adjudication");
  assert.equal(second.adjudication.status, "pending");
  assert.equal(second.adjudication.opinion_ids.length, 2);

  const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN"] });
  await service.signPackage({ package_id: pkg.package_id, base_version: 1, role: "research", signer: "研究审校-林", request_id: "req-adj-r" });
  await service.signPackage({ package_id: pkg.package_id, base_version: 2, role: "rights", signer: "权利审校-周", request_id: "req-adj-l" });
  await assert.rejects(
    service.publishPackage({ package_id: pkg.package_id, base_version: 3 }),
    (error) => error.code === "PENDING_ADJUDICATION",
  );

  const resolved = await service.resolveAdjudication({
    adjudication_id: second.adjudication.adjudication_id,
    decided_by: "联合裁定组",
    outcome: "uphold",
    rationale: "授权链完整，反对意见不成立",
    adopted_opinion_ids: [second.adjudication.opinion_ids[0]],
  });
  assert.equal(resolved.status, "resolved");

  const after = service.getDraft(draft.draft_id);
  assert.equal(after.version, 1);
  assert.deepEqual(after.content, { layout: "banner-v1", palette: ["朱红", "石青"] });

  const published = await service.publishPackage({ package_id: pkg.package_id, base_version: 3 });
  assert.equal(published.status, "published");
});

test("发布包需要研究审校与权利审校分别签署", async (t) => {
  const { service } = await boot(t);
  const { draft } = await seedMotifAndDraft(service);
  const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN", "JP"] });

  await assert.rejects(
    service.publishPackage({ package_id: pkg.package_id, base_version: 1 }),
    (error) => error.code === "SIGNOFF_INCOMPLETE",
  );

  const research = await service.signPackage({
    package_id: pkg.package_id,
    base_version: 1,
    role: "research",
    signer: "研究审校-林",
    request_id: "req-dual-r",
  });
  assert.equal(research.status, "assembling");
  await assert.rejects(
    service.publishPackage({ package_id: pkg.package_id, base_version: 2 }),
    (error) => error.code === "SIGNOFF_INCOMPLETE",
  );

  await assert.rejects(
    service.signPackage({ package_id: pkg.package_id, base_version: 2, role: "research", signer: "研究审校-林", request_id: "req-dup" }),
    (error) => error.code === "STATE_CONFLICT",
  );
  await assert.rejects(
    service.signPackage({ package_id: pkg.package_id, base_version: 2, role: "marketing", signer: "市场-王", request_id: "req-bad" }),
    (error) => error.code === "VALIDATION",
  );

  const rights = await service.signPackage({
    package_id: pkg.package_id,
    base_version: 2,
    role: "rights",
    signer: "权利审校-周",
    request_id: "req-dual-l",
  });
  assert.equal(rights.status, "ready");

  const published = await service.publishPackage({ package_id: pkg.package_id, base_version: 3 });
  assert.equal(published.status, "published");
  assert.equal(published.signoffs.research.signed_by, "研究审校-林");
  assert.equal(published.signoffs.rights.signed_by, "权利审校-周");
});

test("组装发布包校验元素市场覆盖", async (t) => {
  const { service } = await boot(t);
  const { draft } = await seedMotifAndDraft(service);
  await assert.rejects(
    service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN", "FR"] }),
    (error) => error.code === "VALIDATION" && error.details.missing.includes("FR"),
  );
  const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN", "JP"] });
  assert.equal(pkg.status, "assembling");
});

test("同一签署请求完全重放返回原结果，内容变化则拒绝", async (t) => {
  const { service, storagePath, now } = await boot(t);
  const { draft } = await seedMotifAndDraft(service);
  const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN"] });

  const request = {
    package_id: pkg.package_id,
    base_version: 1,
    role: "research",
    signer: "研究审校-林",
    request_id: "req-sign-1",
    statement: { scope: "全部市场" },
  };
  const first = await service.signPackage(request);
  const eventsBefore = service.listEvents().length;

  const replay = await service.signPackage(request);
  assert.deepEqual(replay, first);
  assert.equal(service.listEvents().length, eventsBefore);
  assert.equal(service.getPackage(pkg.package_id).version, 2);

  await assert.rejects(
    service.signPackage({ ...request, statement: { scope: "仅 CN" } }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  const reopened = await GovernanceService.open({ storagePath, now });
  const afterRestart = await reopened.signPackage(request);
  assert.deepEqual(afterRestart, first);
});

test("市场范围或素材授权变化只影响未发布版本，已上线包追加暂停或更正记录", async (t) => {
  const { service } = await boot(t);
  const motif = await service.proposeMotif(motifInput());

  const draftOpen = await service.createDraft({
    motif_refs: [{ motif_id: motif.motif_id, motif_version: 1 }],
    content: { layout: "wip" },
  });
  const draftLive = await service.createDraft({
    motif_refs: [{ motif_id: motif.motif_id, motif_version: 1 }],
    content: { layout: "live" },
  });
  const pkgLive = await service.assemblePackage({ draft_id: draftLive.draft_id, draft_version: 1, markets: ["CN", "US"] });
  await signBothAndPublish(service, pkgLive.package_id);

  const pkgWip = await service.assemblePackage({ draft_id: draftOpen.draft_id, draft_version: 1, markets: ["CN"] });
  await service.signPackage({ package_id: pkgWip.package_id, base_version: 1, role: "research", signer: "研究审校-林", request_id: "req-wip-r" });
  await service.signPackage({ package_id: pkgWip.package_id, base_version: 2, role: "rights", signer: "权利审校-周", request_id: "req-wip-l" });

  // 市场范围收缩：移除 US
  await service.updateMotif({ motif_id: motif.motif_id, base_version: 1, patch: { markets: ["CN", "JP"] } });

  const openAfter = service.getDraft(draftOpen.draft_id);
  assert.equal(openAfter.dependency_alerts.length, 1);
  assert.deepEqual(openAfter.dependency_alerts[0].fields, ["markets"]);
  assert.equal(openAfter.dependency_alerts[0].to_version, 2);

  const wipAfter = service.getPackage(pkgWip.package_id);
  assert.equal(wipAfter.dependency_alerts.length, 1);
  assert.equal(wipAfter.signoffs.research, null);
  assert.equal(wipAfter.status, "assembling");
  await assert.rejects(
    service.publishPackage({ package_id: pkgWip.package_id, base_version: wipAfter.version }),
    (error) => error.code === "DEPENDENCY_ALERTS",
  );

  const liveAfter = service.getPackage(pkgLive.package_id);
  assert.equal(liveAfter.status, "suspended");
  assert.equal(liveAfter.notices.length, 1);
  assert.equal(liveAfter.notices[0].kind, "suspension");
  assert.deepEqual(liveAfter.motif_refs, [{ motif_id: motif.motif_id, motif_version: 1 }]);
  assert.equal(liveAfter.signoffs.research.signed_by, "研究审校-林");

  // 权利条件变化（市场未变）：已上线包追加更正记录
  await service.updateMotif({
    motif_id: motif.motif_id,
    base_version: 2,
    patch: {
      rights: { license: "博物馆授权-2026-031", holder: "某博物馆", conditions: ["保留署名", "禁止商标注册", "禁止二次授权"] },
    },
  });
  const liveFinal = service.getPackage(pkgLive.package_id);
  assert.equal(liveFinal.notices.length, 2);
  assert.equal(liveFinal.notices[1].kind, "correction");
  assert.equal(service.getDraft(draftOpen.draft_id).dependency_alerts.length, 2);
});

test("未发布版本对齐新依赖后解除告警并可重新签署发布", async (t) => {
  const { service } = await boot(t);
  const motif = await service.proposeMotif(motifInput());
  const draft = await service.createDraft({
    motif_refs: [{ motif_id: motif.motif_id, motif_version: 1 }],
    content: { layout: "wip" },
  });
  const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN", "JP"] });
  await service.signPackage({ package_id: pkg.package_id, base_version: 1, role: "research", signer: "研究审校-林", request_id: "req-al-r" });
  await service.signPackage({ package_id: pkg.package_id, base_version: 2, role: "rights", signer: "权利审校-周", request_id: "req-al-l" });

  await service.updateMotif({ motif_id: motif.motif_id, base_version: 1, patch: { markets: ["CN", "JP"] } });
  const alerted = service.getPackage(pkg.package_id);
  assert.equal(alerted.dependency_alerts.length, 1);

  const revised = await service.reviseDraft({
    draft_id: draft.draft_id,
    base_version: 1,
    motif_refs: [{ motif_id: motif.motif_id, motif_version: 2 }],
    content: { layout: "wip-v2" },
  });
  assert.equal(revised.dependency_alerts.length, 0);

  const reassembled = await service.reassemblePackage({ package_id: pkg.package_id, base_version: alerted.version });
  assert.equal(reassembled.dependency_alerts.length, 0);
  assert.deepEqual(reassembled.motif_refs, [{ motif_id: motif.motif_id, motif_version: 2 }]);
  assert.equal(reassembled.draft_version, 2);

  await service.signPackage({ package_id: pkg.package_id, base_version: reassembled.version, role: "research", signer: "研究审校-林", request_id: "req-al-r2" });
  await service.signPackage({ package_id: pkg.package_id, base_version: reassembled.version + 1, role: "rights", signer: "权利审校-周", request_id: "req-al-l2" });
  const published = await service.publishPackage({ package_id: pkg.package_id, base_version: reassembled.version + 2 });
  assert.equal(published.status, "published");
});

test("服务重启后待裁定议题与暂停通知保持一致", async (t) => {
  const { service, storagePath, now } = await boot(t);
  const { motif, draft } = await seedMotifAndDraft(service);
  const deps = { [motif.motif_id]: 1 };

  await service.addOpinion({ draft_id: draft.draft_id, draft_version: 1, dependency_versions: deps, expert: "专家甲", stance: "endorse" });
  await service.addOpinion({ draft_id: draft.draft_id, draft_version: 1, dependency_versions: deps, expert: "专家乙", stance: "object" });

  const draftLive = await service.createDraft({
    motif_refs: [{ motif_id: motif.motif_id, motif_version: 1 }],
    content: { layout: "live" },
  });
  const pkgLive = await service.assemblePackage({ draft_id: draftLive.draft_id, draft_version: 1, markets: ["CN", "US"] });
  await signBothAndPublish(service, pkgLive.package_id);
  await service.updateMotif({ motif_id: motif.motif_id, base_version: 1, patch: { markets: ["CN", "JP"] } });

  const pendingBefore = service.listPendingAdjudications();
  const noticesBefore = service.listNotices();
  assert.equal(pendingBefore.length, 1);
  assert.equal(noticesBefore.length, 1);
  assert.equal(noticesBefore[0].kind, "suspension");

  const reopened = await GovernanceService.open({ storagePath, now });
  assert.deepEqual(reopened.listPendingAdjudications(), pendingBefore);
  assert.deepEqual(reopened.listNotices(), noticesBefore);
});

test("成品可追到采用的元素、证据、意见和批准版本", async (t) => {
  const { service } = await boot(t);
  const motif = await service.proposeMotif(motifInput());
  const draft = await service.createDraft({
    motif_refs: [{ motif_id: motif.motif_id, motif_version: 1 }],
    content: { layout: "poster" },
  });
  const deps = { [motif.motif_id]: 1 };

  const first = await service.addOpinion({ draft_id: draft.draft_id, draft_version: 1, dependency_versions: deps, expert: "专家甲", stance: "endorse" });
  const second = await service.addOpinion({ draft_id: draft.draft_id, draft_version: 1, dependency_versions: deps, expert: "专家乙", stance: "object" });
  await service.resolveAdjudication({
    adjudication_id: second.adjudication.adjudication_id,
    decided_by: "联合裁定组",
    outcome: "merge",
    rationale: "补充出处标注后通过",
    adopted_opinion_ids: [first.opinion.opinion_id],
  });

  const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN"] });
  await signBothAndPublish(service, pkg.package_id);

  // 元素后续更新不影响钉住的历史版本
  await service.updateMotif({ motif_id: motif.motif_id, base_version: 1, patch: { markets: ["CN", "JP"] } });

  const trace = service.traceArtifact(pkg.package_id);
  assert.equal(trace.draft.draft_version, 1);
  assert.equal(trace.motifs.length, 1);
  assert.equal(trace.motifs[0].version, 1);
  assert.deepEqual(trace.motifs[0].markets, ["CN", "JP", "US"]);
  assert.equal(trace.motifs[0].provenance.length, 2);
  assert.equal(trace.motifs[0].provenance[0].evidence_id, "ev-0001");
  assert.equal(trace.opinions.length, 2);
  assert.equal(trace.adjudications.length, 1);
  assert.equal(trace.adjudications[0].status, "resolved");
  assert.equal(trace.approvals.research.signed_by, "研究审校-林");
  assert.equal(trace.approvals.rights.signed_by, "权利审校-周");
  assert.ok(trace.approvals.published_at);
  assert.equal(trace.notices.length, 1);
  assert.equal(trace.notices[0].kind, "correction");
});

test("服务产生的领域事件符合既有事件契约", async (t) => {
  const { service, storagePath, now } = await boot(t);
  const { motif, draft } = await seedMotifAndDraft(service);
  const deps = { [motif.motif_id]: 1 };
  await service.addOpinion({ draft_id: draft.draft_id, draft_version: 1, dependency_versions: deps, expert: "专家甲", stance: "endorse" });
  await service.addOpinion({ draft_id: draft.draft_id, draft_version: 1, dependency_versions: deps, expert: "专家乙", stance: "object" });
  const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN", "US"] });
  await service.updateMotif({ motif_id: motif.motif_id, base_version: 1, patch: { markets: ["CN"] } });

  const events = service.listEvents();
  assert.ok(events.length >= 8);
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 不符合契约`);
  }

  const reopened = await GovernanceService.open({ storagePath, now });
  assert.equal(reopened.listEvents().length, events.length);
});

test("未知对象返回 NOT_FOUND", async (t) => {
  const { service } = await boot(t);
  assert.throws(() => service.getMotif("motif-999999"), (error) => error.code === "NOT_FOUND");
  await assert.rejects(
    service.updateMotif({ motif_id: "motif-999999", base_version: 1, patch: { title: "x" } }),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    service.signPackage({ package_id: "package-999999", base_version: 1, role: "research", signer: "研究审校-林", request_id: "req-none" }),
    (error) => error.code === "NOT_FOUND",
  );
});
