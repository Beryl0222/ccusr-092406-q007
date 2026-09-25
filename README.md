# 艺术元素时代化审校

本项目用于整理艺术元素时代化审校领域中的事件名称、交换字段与脱敏样例，方便业务、运营和研发人员在同一套术语下讨论后续服务。资料只包含领域约定，不包含真实个人信息、生产连接或外部账号。

## 目录

- `src/`：事件种类与最小字段校验。
- `data/sample.json`：用于核对资料格式的虚构事件。
- `tests/`：保证样例与领域约定保持一致。

## 发布治理服务

`src/governance_service.js` 在领域资料之上提供发布治理服务（内存运行 + JSON 快照落盘，无需外部服务），覆盖内容总监提出的治理要求：

- **元素提案**：每个元素保存来源证据、可变形边界、权利条件与适用市场；修改产生新版本并保留历史快照。
- **意见绑定**：专家意见绑定具体稿件版本与依赖版本快照；已发布或已过期的版本拒收新意见，避免新意见套到旧稿上。
- **联合裁定**：立场冲突的意见自动进入待裁定议题，裁定只记录结论，不自动覆盖设计稿；待裁定期间禁止发布。
- **分别签署**：发布包需研究审校与权利审校分别签署；签署请求幂等——完全重放返回原结果，内容变化则拒绝。
- **依赖传播**：市场范围或素材授权变化只标记引用它的未发布稿件/发布包（签署作废，需对齐后重新签署）；已上线包追加暂停或更正记录，内容本体不被改写。
- **并行控制**：所有修改携带基线版本，版本不匹配即拒绝，防止并行修改静默覆盖。
- **重启一致**：状态原子写入快照文件，重启后待裁定议题与暂停通知保持一致。
- **全程追溯**：`traceArtifact(package_id)` 返回成品采用的元素钉住版本、来源证据、意见、裁定与批准版本。

### 最小示例

```js
import { GovernanceService } from "./src/governance_service.js";

const service = await GovernanceService.open({ storagePath: "state.json" });
const motif = await service.proposeMotif({
  title: "云纹",
  provenance: [{ source: "某博物馆藏纹样拓片", evidence_id: "ev-0001" }],
  deform_bounds: { max_stretch_ratio: 0.15 },
  rights: { license: "博物馆授权-2026-031", conditions: ["保留署名"] },
  markets: ["CN", "JP"],
});
const draft = await service.createDraft({
  motif_refs: [{ motif_id: motif.motif_id, motif_version: 1 }],
  content: { layout: "banner-v1" },
});
const pkg = await service.assemblePackage({ draft_id: draft.draft_id, draft_version: 1, markets: ["CN"] });
await service.signPackage({ package_id: pkg.package_id, base_version: 1, role: "research", signer: "研究审校-林", request_id: "req-1" });
await service.signPackage({ package_id: pkg.package_id, base_version: 2, role: "rights", signer: "权利审校-周", request_id: "req-2" });
await service.publishPackage({ package_id: pkg.package_id, base_version: 3 });
console.log(service.traceArtifact(pkg.package_id));
```

## 本地核对

```bash
npm test
```

## 本地运行

测试命令：

```bash
npm test
```

编译或构建命令：

```bash
npm run build
```

所有测试和构建均在单个 Linux 应用容器内完成，不需要另行启动数据库或外部服务。
