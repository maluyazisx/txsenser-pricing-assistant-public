"""Chinese internal presentation of the existing C1 ReadEnvelope; pure reads.

No lookup defaults, matching rules, price calculation, publication or execution
permission are added here. Missing data stays missing; five result slots remain
separate. Call with a result from ProductPricingReadService.
"""
from __future__ import annotations

import json
from typing import Any

from txsenser_pricing.product_pricing_contracts import CONTRACT_VERSION, ReadEnvelope

_MATCH = {"exact": "精确匹配", "partial": "部分匹配", "ambiguous": "存在多个匹配",
          "not_found": "未找到适用记录", "blocked": "查询受阻"}
_PUBLICATION = {"published": "已发布的知识快照（不替代执行价格权威）",
                "candidate": "候选尚未发布", "none": "未提供发布状态"}
_FIELDS = {"product_id": "产品身份", "configuration_id": "配置身份", "model": "型号",
           "pn": "PN", "market": "市场", "application": "应用", "customer_role": "客户角色",
           "sales_mode": "销售模式", "quantity": "数量", "quantity_positive": "有效正整数数量",
           "quantity_unit": "数量单位", "currency": "币种", "commercial_terms": "关键商务条款"}
_REASONS = {
    "input_missing": "必要查询条件未齐", "no_record": "返回范围内未找到记录",
    "no_authoritative_current_price": "未找到适用的当前权威价格",
    "no_admitted_standard": "未找到已准入的标准价格",
    "pricing_evidence_building": "定价依据仍在形成中",
    "scope_mismatch": "适用范围不匹配", "not_effective": "查询时间不在有效范围内",
    "reconciliation_required": "需要核对来源或冲突", "dependency_invalid": "依赖依据无效",
    "unreleased": "发布条件未通过", "ambiguous": "存在多个匹配，不能自行选定",
    "publication_unpublished": "候选尚未发布，不能作为正式报价执行价格",
    "shared_identity_link_unresolved": "客户或项目身份关联尚未确认",
    "retracted": "相关历史事实已撤回", "no_confirmed_customer_exposure": "未找到已确认的客户报价记录",
}
_STAGES = {"quote_issued": "已报价", "customer_exposed": "已向客户呈现",
           "quote_revised": "报价已修订", "customer_accepted": "客户接受",
           "contract_signed": "已签合同", "transaction_agreed": "已确认成交",
           "business_completed": "业务完成", "payment_received": "已收款",
           "invoice_issued": "已开票", "shipment": "已发货", "receipt": "已收货",
           "historical_fact_corrected": "历史更正", "historical_fact_retracted": "历史撤回",
           "applicability_superseded": "适用性已被替代"}


def _text(value: Any) -> str:
    if value is None or value == "":
        return "未提供"
    # Escape Unicode line separators in strings and nested JSON values.
    rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, str):
        rendered = rendered[1:-1]
    return (rendered.replace(chr(0x85), r"\u0085")
                    .replace(chr(0x2028), r"\u2028")
                    .replace(chr(0x2029), r"\u2029"))


def _label(value: str, labels: dict[str, str]) -> str:
    return labels.get(value, "未识别（原值：" + _text(value) + "）")


def _scope(scope: dict[str, Any]) -> list[str]:
    lines = ["  " + label + "：" + _text(scope.get(key)) for key, label in (
        ("market", "市场"), ("application", "应用"), ("customer_role", "客户角色（原值）"),
        ("sales_mode", "销售模式（原值）"), ("customer_restriction", "客户限定"),
        ("project_restriction", "项目限定"), ("commercial_terms", "关键条款（原文）"))]
    tier = scope.get("quantity_tier")
    if isinstance(tier, dict):
        def boundary(key: str) -> str:
            v = tier.get(key)
            return "包含" if v is True else "不包含" if v is False else "未提供"
        lines.append("  数量档：起点 " + _text(tier.get("min")) + "（" + boundary("min_inclusive")
                     + "）；终点 " + _text(tier.get("max")) + "（" + boundary("max_inclusive")
                     + "）；单位 " + _text(tier.get("unit")))
    else:
        lines.append("  数量档：未提供")
    return lines


def _record(item: dict[str, Any]) -> list[str]:
    lines = ["  记录：" + _text(item.get("record_id")),
             "  版本：" + _text(item.get("revision_id")) + "；版本摘要：" + _text(item.get("revision_digest"))]
    product = item.get("product_ref", {})
    config = item.get("baseline_configuration_ref", {})
    lines.extend(["  产品：" + _text(product.get("record_id")),
                  "  配置：" + _text(config.get("configuration_id")), "  PN：" + _text(item.get("pn"))])
    if item.get("record_kind") == "product":
        # Preserve actual product/configuration declarations; do not select a default PN.
        lines.append("  产品信息（返回原文）：" + _text(item.get("product")))
    value = item.get("value")
    if isinstance(value, dict):
        lines.append("  价格性质（原值）：" + _text(item.get("price_nature")))
        lines.append("  金额（原值）：" + _text(value.get("amount")) + "；币种："
                     + _text(value.get("currency")) + "；计价单位：" + _text(value.get("unit")))
        lines.append("  价格值（返回原文）：" + _text(value))
    scope = item.get("pricing_scope")
    if isinstance(scope, dict):
        lines.extend(_scope(scope))
    for key, label in (("customer_link", "客户关联"), ("opportunity_link", "商机/项目关联"),
                       ("product_links", "历史产品关联"),
                       ("commercial_classification", "历史价格性质"),
                       ("comparison_limitations", "比较限制")):
        if key in item:
            lines.append("  " + label + "（原文）：" + _text(item[key]))
    for fact in item.get("stage_facts", []):
        lines.append("  历史阶段：" + _label(fact.get("stage_kind"), _STAGES)
                     + "；原始事实：" + _text(fact))
    lines.append("  来源引用：" + _text(item.get("source_refs")))
    if "canonical_version" in item:
        lines.append("  权威价格版本线索：" + _text(item["canonical_version"]))
    lines.append("  批准线索：结果未提供批准人/完整批准记录；不从来源或版本推断。")
    return lines


def present_read_result_zh(result: ReadEnvelope) -> str:
    """Render one existing envelope as internal text, without mutation or I/O."""
    if not isinstance(result, ReadEnvelope) or result.contract_version != CONTRACT_VERSION:
        raise ValueError("unsupported_read_envelope_contract")
    lines = ["只读查价结果（内部参考）", "正式对外执行价格仍以已批准Excel为准。",
             "本查询结果不授权正式报价，不修改价格、审批或发布状态。",
             "查询时间：" + _text(result.as_of), "知识截至：" + _text(result.knowledge_as_of),
             "匹配情况：" + _label(result.match_status, _MATCH),
             "发布状态：" + _label(result.publication_status, _PUBLICATION),
             "数据时效标记（原值）：" + _text(result.freshness),
             "原结果执行许可标记：" + _text(result.execution_allowed),
             "原结果执行权威标记：" + _text(result.execution_authority),
             "返回的匹配范围（未返回的字段不补默认）："]
    lines.extend(_scope(result.matched_scope))
    lines.append("需补充条件：" + ("、".join(_label(k, _FIELDS) for k in result.missing_inputs)
                                  if result.missing_inputs else "结果未列出缺项，不代表批准报价。"))
    published = result.publication_status == "published" and result.freshness == "published_snapshot"
    for title, items in (
        ("当前权威记录（仅内部参考）" if published else "当前记录槽位（发布状态未确认，仅内部参考）", result.current_canonical),
        ("候选记录（尚未发布，不能作为正式报价执行价格）", result.pending_candidate),
        ("历史依据（不覆盖当前正式价格）", result.historical),
        ("客户专项/战略依据（不成为公司通用现行价格）", result.customer_specific_strategic),
    ):
        lines.append(title + "：")
        if not items:
            lines.append("  无返回记录")
        for item in items:
            lines.extend(_record(item))
    lines.append("阻断/未知原因：")
    if not result.unknown:
        lines.append("  结果未列出原因，不推断已获执行许可。")
    for item in result.unknown:
        for reason in item.get("reasons", []):
            lines.append("  " + _label(reason, _REASONS) + "（原码：" + _text(reason) + "）")
        if "detail" in item:
            lines.append("  详情（原文）：" + _text(item["detail"]))
    lines.extend(["待核对引用：" + _text(result.reconciliation_refs),
                  "发布引用：" + _text(result.brain_publication_id) + "；摘要：" + _text(result.brain_publication_digest),
                  "下一步：补齐列出的必要条件，核对适用范围、来源/批准记录与已批准Excel；"
                  "候选或历史仅供内部审阅，本层不执行报价。"])
    return "\n".join(lines)
