"""因子对账证据的独立性和双向覆盖合约。"""
from __future__ import annotations


INDEPENDENT_WORD_V2_CODES = {
    "CAPEXGROWTH",
    "LIMITUPDAYS",
    "MARGINBUYRATIO",
    "SURVEYCNT",
    "UNLOCKPRESS",
}


def verification_contract(code: str, method: str | None) -> tuple[str, str]:
    """返回（独立性等级，可以证明的范围）。"""
    if method == "numpy_recompute":
        return "independent_reference", "sampled_value_and_key_recompute"
    if method == "word_v2_source_recompute" and code in INDEPENDENT_WORD_V2_CODES:
        return "independent_reference", "sampled_value_and_key_recompute"
    if method == "source_recheck":
        return "same_source_mapping", "stored_vs_current_source_mapping"
    if method in {"word_v2_source_recompute", "derived_recompute"}:
        return "same_production_path", "stored_vs_current_production_code"
    return "unclassified", "implementation_consistency_only"


def overall_reconcile_status(recon: dict) -> str:
    """共同键数值与双向覆盖都通过才称为 exact_match。"""
    if recon.get("status") != "match":
        return str(recon.get("status") or "unknown")
    coverage_status = recon.get("coverage_status")
    n_stored_only = int(recon.get("n_stored_only") or 0)
    n_ref_only = int(recon.get("n_ref_only") or 0)
    if coverage_status not in {None, "exact", "match"} or n_stored_only or n_ref_only:
        return "coverage_difference"
    return "exact_match"


def annotate_reconciliation(code: str, recon: dict) -> dict:
    truth_level, scope = verification_contract(code, recon.get("method"))
    return {
        **recon,
        "overall_status": overall_reconcile_status(recon),
        "truth_level": truth_level,
        "verification_scope": scope,
    }
