"""因子体检：覆盖率/覆盖期/退化/离群/方向-IC 一致性。"""
from __future__ import annotations

import math

import polars as pl

COVERAGE_WARN = 0.5
COVERAGE_LATE_AFTER = "2016-01"  # YYYY-MM 字符串，按字典序比较月份前缀
MIN_CS_STOCKS = 30
OUTLIER_ABS = 1e6
OUTLIER_Z = 50.0


def _robust_z_max(values: pl.Series) -> float:
    v = values.drop_nulls()
    if v.len() < 5:
        return 0.0
    med = v.median()
    mad = (v - med).abs().median()
    if mad is None or mad == 0:
        return 0.0
    z = ((v - med).abs() / (1.4826 * mad)).max()
    return float(z) if z is not None else 0.0


def health_check(code: str, meta: dict, factor_raw: pl.DataFrame,
                 eligible_dates: pl.DataFrame, ic_df: pl.DataFrame, recon: dict,
                 eligible_by_date: dict | None = None) -> dict:
    """对单个因子做统计体检，返回 {level, flags, metrics}。

    level ∈ {ok, warn, error}：error = nonfinite 或 recon 不符；outlier(|raw|>1e6) 与 heavy_tail 作为
    观察标签保留在详情中，但单独出现时不把总览行升为 warn；其它任一 actionable flag → warn；否则 ok。
    flags：coverage_low / coverage_late:<YYYY-MM> / degenerate / nonfinite / outlier /
    heavy_tail / direction_ic_flip / recon_<status>。
      - nonfinite：存值含 NaN/inf → 几乎肯定有问题（error）。
      - outlier：|raw|>1e6 → 量级异常/泄漏观察项。
      - heavy_tail：稳健 z>50 → 厚尾观察项，值得看但不一定是错。
    metrics：coverage、coverage_period、abs_max、robust_z_max、n_nonfinite、rank_ic_mean、
    rank_ic_t（视可算情况而定）。

    eligible_by_date（可选）：{trade_date: 可投资股票数} 映射，作为 coverage 分母（按因子有数据
    的月末截面求和）。批量调用时可一次性算好传入，避免对大表逐因子重复 group_by；不传则按
    eligible_dates 现算（行为等价）。
    """
    flags: list[str] = []
    metrics: dict = {}
    sub = factor_raw.filter((pl.col("factor_code") == code) & pl.col("raw_value").is_not_null())

    # coverage：在该因子有数据的那些月末截面上，相对可投资域的覆盖率
    factor_dates = sub.select("trade_date").unique()["trade_date"].to_list()
    if eligible_by_date is None:
        ebd = {r["trade_date"]: r["n"] for r in
               eligible_dates.group_by("trade_date").agg(pl.len().alias("n")).to_dicts()}
    else:
        ebd = eligible_by_date
    n_factor = sub.select(["stock_code", "trade_date"]).unique().height
    n_elig = sum(ebd.get(d, 0) for d in factor_dates)
    coverage = n_factor / n_elig if n_elig else 0.0
    metrics["coverage"] = round(coverage, 4)
    if coverage < COVERAGE_WARN:
        flags.append("coverage_low")

    # coverage_period
    if not sub.is_empty():
        cs_counts = sub.group_by("trade_date").agg(pl.len().alias("n")).filter(pl.col("n") >= MIN_CS_STOCKS)
        if not cs_counts.is_empty():
            first_month = cs_counts.select(pl.col("trade_date").min()).item()
            last_month = cs_counts.select(pl.col("trade_date").max()).item()
            first_key = str(first_month)[:7]
            last_key = str(last_month)[:7]
            metrics["coverage_period"] = str(first_month)
            metrics["coverage_last_period"] = str(last_month)
            try:
                fy, fm = (int(x) for x in first_key.split("-"))
                ly, lm = (int(x) for x in last_key.split("-"))
                metrics["coverage_months"] = max(1, (ly - fy) * 12 + (lm - fm) + 1)
            except Exception:
                metrics["coverage_months"] = None
            if first_key > COVERAGE_LATE_AFTER:
                flags.append(f"coverage_late:{first_key}")

    # degenerate（任一截面常量）
    if not sub.is_empty():
        per_cs = sub.group_by("trade_date").agg(pl.col("raw_value").n_unique().alias("u"))
        if per_cs.filter(pl.col("u") <= 1).height > 0:
            flags.append("degenerate")

    # outlier / nonfinite
    if not sub.is_empty():
        finite = sub.filter(pl.col("raw_value").is_finite())
        n_nonfinite = sub.height - finite.height
        absmax = float(finite["raw_value"].abs().max() or 0.0) if not finite.is_empty() else 0.0
        zmax = _robust_z_max(finite["raw_value"]) if not finite.is_empty() else 0.0
        metrics["abs_max"] = absmax
        metrics["robust_z_max"] = round(zmax, 2)
        metrics["n_nonfinite"] = n_nonfinite
        if n_nonfinite > 0:
            flags.append("nonfinite")          # NaN/inf 存值 → 几乎肯定有问题
        if absmax > OUTLIER_ABS:
            flags.append("outlier")            # |raw|>1e6 → 量级异常/泄漏（如 rank_to_normal 1e9）
        if zmax > OUTLIER_Z:
            flags.append("heavy_tail")         # 稳健 z 过大 → 厚尾，值得看但不一定是错

    # direction_ic
    if "factor_code" in ic_df.columns:
        ic_sub = ic_df.filter(pl.col("factor_code") == code)["rank_ic"].drop_nulls()
    else:
        ic_sub = pl.Series([], dtype=pl.Float64)
    if ic_sub.len() >= 6:
        mean = float(ic_sub.mean())
        std = float(ic_sub.std(ddof=1) or 0.0)
        t = mean / (std / math.sqrt(ic_sub.len())) if std > 0 else 0.0
        metrics["rank_ic_mean"] = round(mean, 4)
        metrics["rank_ic_t"] = round(t, 2)
        direction = meta.get("direction", 1)
        if abs(t) > 2 and (mean * direction) < 0:
            flags.append("direction_ic_flip")

    # recon
    if recon.get("status") in {"mismatch", "source_missing"}:
        flags.append(f"recon_{recon['status']}")

    observe_only = {"outlier", "heavy_tail"}
    actionable_flags = [f for f in flags if f.split(":", 1)[0] not in observe_only]

    if "nonfinite" in flags or any(f.startswith("recon_") for f in flags):
        level = "error"
    elif actionable_flags:
        level = "warn"
    else:
        level = "ok"
    return {"level": level, "flags": flags, "metrics": metrics}
