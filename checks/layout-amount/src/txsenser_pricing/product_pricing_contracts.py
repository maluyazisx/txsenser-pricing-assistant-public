"""Stable public contracts for Product / Pricing runtime reads.

The response shape deliberately keeps all five semantic slots present.  A
missing numeric price is represented by an ``unknown`` item, never by zero or
by borrowing historical evidence.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

CONTRACT_VERSION = "pricing-assistant-read.c1.v1"
PROJECTION_VERSION = "product-pricing-projection.v1"

MatchStatus = Literal["exact", "partial", "ambiguous", "not_found", "blocked"]
Purpose = Literal[
    "product_lookup",
    "current_price",
    "internal_history",
    "customer_exposure",
    "audit",
    "review",
]


@dataclass(frozen=True, slots=True)
class ProductLookupQuery:
    as_of: str
    product_id: str | None = None
    model: str | None = None
    pn: str | None = None
    market: str | None = None
    application: str | None = None


@dataclass(frozen=True, slots=True)
class CurrentPriceQuery:
    as_of: str
    product_id: str | None
    configuration_id: str | None
    market: str | None
    customer_role: str | None
    sales_mode: str | None
    quantity: int | None
    quantity_unit: str | None
    currency: str | None
    commercial_terms: dict[str, str] = field(default_factory=dict)
    pn: str | None = None
    application: str | None = None
    customer_id: str | None = None
    project_id: str | None = None


@dataclass(frozen=True, slots=True)
class HistoricalPricingQuery:
    as_of: str
    pe_id: str | None = None
    customer_id: str | None = None
    customer_literal: str | None = None
    product_id: str | None = None
    configuration_id: str | None = None
    opportunity_id: str | None = None
    stage_kinds: tuple[str, ...] = ()
    audit: bool = False


@dataclass(frozen=True, slots=True)
class CustomerExposureQuery:
    as_of: str
    customer_id: str
    product_id: str | None = None
    configuration_id: str | None = None
    market: str | None = None
    opportunity_id: str | None = None
    episode_ref: str | None = None


@dataclass(frozen=True, slots=True)
class ReadEnvelope:
    query_id: str
    as_of: str
    knowledge_as_of: str | None
    brain_publication_id: str | None
    brain_publication_digest: str | None
    freshness: str
    match_status: MatchStatus
    matched_scope: dict[str, Any]
    missing_inputs: tuple[str, ...]
    reconciliation_refs: tuple[str, ...]
    purpose: Purpose
    external_use: str
    current_canonical: tuple[dict[str, Any], ...] = ()
    historical: tuple[dict[str, Any], ...] = ()
    customer_specific_strategic: tuple[dict[str, Any], ...] = ()
    unknown: tuple[dict[str, Any], ...] = ()
    pending_candidate: tuple[dict[str, Any], ...] = ()
    publication_status: str = "none"
    execution_allowed: bool = False
    execution_authority: str = "approved_excel"
    contract_version: str = CONTRACT_VERSION
    projection_version: str = PROJECTION_VERSION

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def unknown_item(*reasons: str, detail: str | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {
        "record_kind": "unknown",
        "price_nature": "unknown",
        "temporal_status": "unknown",
        "allowed_uses": [],
        "reasons": list(dict.fromkeys(reasons)),
    }
    if detail is not None:
        item["detail"] = detail
    return item
