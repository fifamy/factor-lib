"""25 个计算类因子的独立 numpy 参考实现（对账用，独立于生产代码）。

每个函数签名: fn(win: pl.DataFrame, ctx: dict) -> tuple[float | None, list[str]]
  win: 该股截至 asof 的价格窗口（升序），列含 adj_close/amount/free_shares/total_shares/market_cap
  ctx: 跨股上下文（如 {"market_returns": DataFrame(trade_date, market_return)}）
返回 (ref_value, steps)。窗口不足或不可算时 ref_value=None。
"""
from __future__ import annotations

import math
from datetime import timedelta

import numpy as np
import polars as pl

REF_IMPLS: dict = {}


def _ref(code: str):
    def deco(fn):
        REF_IMPLS[code] = fn
        return fn
    return deco


def _adjclose(win: pl.DataFrame) -> np.ndarray:
    return win["adj_close"].to_numpy().astype(float)


def _turnover(win: pl.DataFrame) -> np.ndarray:
    """日换手率 = amount / S_DQ_MV / 10；本地 market_cap 字段来自 S_DQ_MV。"""
    return win["amount"].to_numpy() / win["market_cap"].to_numpy() / 10.0


def _market_extra_hist(win: pl.DataFrame, lookback: int, ctx: dict | None = None) -> pl.DataFrame:
    """复刻 market_extra._hist：按真实交易观测计算变化，再取最近 lookback 行。"""
    if win.is_empty():
        return win
    return (
        win.sort("trade_date")
        .with_columns([
            (pl.col("adj_close") / pl.col("adj_close").shift(1)).log().alias("ret"),
            pl.when(pl.col("volume") > 0)
            .then(pl.col("volume").log())
            .otherwise(None)
            .diff()
            .alias("volume_log_change")
            if "volume" in win.columns else pl.lit(None).alias("volume_log_change"),
        ])
        .tail(lookback)
    )


def _skew(x: np.ndarray) -> float:
    """有偏（总体矩）偏度，与 polars Series.skew() 默认口径一致。"""
    n = len(x)
    if n < 2:
        return float("nan")
    m = x.mean()
    s = math.sqrt(np.mean((x - m) ** 2))
    if s == 0:
        return float("nan")
    return float(np.mean((x - m) ** 3) / s ** 3)


def _kurt(x: np.ndarray) -> float:
    """有偏普通峰度，与 polars Series.kurtosis(fisher=False) 口径一致。"""
    n = len(x)
    if n < 2:
        return float("nan")
    m = x.mean()
    s = math.sqrt(np.mean((x - m) ** 2))
    if s == 0:
        return float("nan")
    return float(np.mean((x - m) ** 4) / s ** 4)


# ---------- 动量 momentum ----------
@_ref("REV1M")
def _rev1m(win, ctx):
    p = _adjclose(win)
    if len(p) < 22:
        return None, []
    v = float(math.log(p[-1] / p[-22]))
    return v, [f"ln(P_t={p[-1]:.4f} / P_t-21={p[-22]:.4f}) = {v:.6f}"]


@_ref("REV5D")
def _rev5d(win, ctx):
    p = _adjclose(win)
    if len(p) < 6:
        return None, []
    r = np.diff(np.log(p[-6:]))
    v = float(r.sum())
    return v, [f"近5日对数收益之和 = {v:.6f}"]


@_ref("MOM20")
def _mom20(win, ctx):
    p = _adjclose(win)
    if len(p) < 21:
        return None, []
    v = float(np.diff(np.log(p[-21:])).sum())
    return v, [f"近20日对数收益之和 = {v:.6f}"]


@_ref("MOM60")
def _mom60(win, ctx):
    h = _market_extra_hist(win, 60, ctx)
    if h.height < 40:
        return None, []
    r = h["ret"].to_numpy().astype(float)
    r = r[np.isfinite(r)]
    if len(r) == 0:
        return None, []
    v = float(r.sum())
    return v, [f"最长60日对数收益之和（{h.height}个价格观测） = {v:.6f}"]


@_ref("MOM12_1")
def _mom12_1(win, ctx):
    p = _adjclose(win)
    if len(p) < 253:
        return None, []
    recent = p[-253:]
    log_ret = np.diff(np.log(recent))      # 252 个
    window = 252 - 21                      # 231
    window_ret = log_ret[:window]          # 收益日 d=t-251..t-21
    v = float(np.sum(window_ret))
    return v, [f"收益日d=t-251..t-21，价格端点P_{{t-252}}至P_{{t-21}}，等权累计对数收益 = {v:.6f}"]


@_ref("RSTR252")
def _rstr252(win, ctx):
    p = _adjclose(win)
    if len(p) < 253:
        return None, []
    window_ret = np.diff(np.log(p[-253:]))[:231]
    k = np.arange(231)
    w = 0.5 ** (k / 126)
    w = w / w.sum()
    v = float(np.sum(window_ret * w[::-1]))
    return v, [f"收益日d=t-251..t-21，价格端点P_{{t-252}}至P_{{t-21}}，半衰期126加权累计对数收益 = {v:.6f}"]


# ---------- 波动 volatility ----------
@_ref("DASTD")
def _dastd(win, ctx):
    p = _adjclose(win)
    if len(p) < 252:
        return None, []
    r = np.diff(np.log(p[-252:]))
    v = float(np.std(r, ddof=1) * math.sqrt(252))
    return v, [f"std(日对数收益,252)×√252 = {v:.6f}"]


@_ref("DOWNVOL")
def _downvol(win, ctx):
    # 生产 _hist(252) 先按日历窗口裁剪，再取最近 252 个交易日。
    h = _market_extra_hist(win, 252, ctx)
    if h.height == 0:
        return None, []
    r = h["ret"].to_numpy().astype(float)
    r = r[np.isfinite(r)]
    neg = r[r < 0]
    if len(neg) < 20:
        return None, []
    v = float(np.std(np.minimum(r, 0.0), ddof=1) * math.sqrt(250))
    return v, [f"下行波动 std(min(r,0),252)×√250 = {v:.6f}"]


@_ref("MAXDD1Y")
def _maxdd1y(win, ctx):
    p = _adjclose(win)
    if len(p) < 252:
        return None, []
    s = p[-252:]
    dd = 1.0 - s / np.maximum.accumulate(s)
    v = float(dd.max())
    return v, [f"max(1-P/cummax(P), 252) = {v:.6f}"]


@_ref("RETSKEW")
def _retskew(win, ctx):
    # 生产 _hist(252) 先按日历窗口裁剪，再取最近 252 个交易日。
    h = _market_extra_hist(win, 252, ctx)
    if h.height == 0:
        return None, []
    r = h["ret"].to_numpy().astype(float)
    r = r[np.isfinite(r)]
    if len(r) < 60:
        return None, []
    v = float(_skew(r))
    return v, [f"skew(日对数收益,252) = {v:.6f}"]


@_ref("RETKURT")
def _retkurt(win, ctx):
    h = _market_extra_hist(win, 252, ctx)
    if h.height == 0:
        return None, []
    r = h["ret"].to_numpy().astype(float)
    r = r[np.isfinite(r)]
    if len(r) < 60:
        return None, []
    v = float(_kurt(r))
    return v, [f"普通峰度(日对数收益,252) = {v:.6f}"]


@_ref("BIGDOWN")
def _bigdown(win, ctx):
    p = _adjclose(win)
    if len(p) < 61:
        return None, []
    r = np.diff(np.log(p[-61:]))
    v = float((r < -0.05).sum() / len(r))
    return v, [f"近60日 r<-5% 占比 = {v:.6f}"]


# ---------- 流动性 liquidity ----------
@_ref("AMOUNT20")
def _amount20(win, ctx):
    # 生产端允许上市历史不足 20 日的股票进入计算，但至少要有 15 个交易日。
    a = win.tail(20)["amount"].to_numpy().astype(float)
    a = a[np.isfinite(a)]
    if len(a) < 15:
        return None, []
    m = a.mean()
    if m <= 0:
        return None, []
    v = float(math.log(m))
    return v, [f"ln(mean(amount,20)={m:.2f}) = {v:.6f}"]


@_ref("VOLUME20")
def _volume20(win, ctx):
    if win.height < 20:
        return None, []
    w = win.tail(20)
    volume = w["volume"].to_numpy().astype(float)
    volume = volume[np.isfinite(volume) & (volume > 0)]
    if len(volume) < 15:
        return None, []
    v = float(volume.mean())
    return v, [f"mean(S_DQ_VOLUME,20) = {v:.6f}"]


@_ref("TURN20")
def _turn20(win, ctx):
    if win.height < 20:
        return None, []
    t = _turnover(win.tail(20))
    v = float(np.nanmean(t))
    return v, [f"mean(turnover,20) = {v:.6f}"]


@_ref("STOM")
def _stom(win, ctx):
    if win.is_empty():
        return None, []
    asof = ctx.get("_asof") or win["trade_date"][-1]
    recent = win.filter(pl.col("trade_date") >= asof - timedelta(days=45)).tail(21)
    t = _turnover(recent)
    t = t[(t > 0) & np.isfinite(t)]
    if len(t) < 15:
        return None, []
    s = float(np.sum(t))
    if s <= 0:
        return None, []
    v = float(math.log(s))
    return v, [f"ln(Σturnover,最长21日={s:.6f})，有效换手日={len(t)} = {v:.6f}"]


# ---------- 流动性·扩充 (market_extra) ----------
@_ref("AMTVOL")
def _amtvol(win, ctx):
    """近20日成交额变异系数std/mean (ddof=1)。"""
    h = _market_extra_hist(win, 20, ctx)
    if h.height < 15:
        return None, []
    a = h["amount"].to_numpy().astype(float)
    mu = a.mean()
    if mu <= 0:
        return None, []
    v = float(np.std(a, ddof=1) / mu)
    return v, [f"std(amount,20)/mean(amount,20) = {v:.6f}"]


@_ref("TURNVOL")
def _turnvol(win, ctx):
    """近60日换手率标准差 (ddof=1)。"""
    # 与生产端一致：最长 60 日，上市历史较短时至少需要 40 个交易日。
    t = _turnover(win.tail(60))
    t = t[np.isfinite(t)]
    if len(t) < 40:
        return None, []
    v = float(np.std(t, ddof=1))
    return v, [f"std(turnover,60) = {v:.6f}"]


@_ref("TURNPCTL")
def _turnpctl(win, ctx):
    """末日换手率在近120日内的历史分位 = (turnover<=末日).sum()/n。"""
    t = _turnover(win.tail(120))
    t = t[np.isfinite(t)]
    if len(t) < 60:
        return None, []
    last = t[-1]
    v = float((t <= last).sum() / len(t))
    return v, [f"换手率历史分位(120d) = {v:.6f}"]


@_ref("PVCORR")
def _pvcorr(win, ctx):
    """近60日日对数收益与实际成交量对数变化的相关系数。"""
    if win.height < 41:
        return None, []
    h = _market_extra_hist(win, 60, ctx)
    r = h["ret"].to_numpy().astype(float)
    volume_change = h["volume_log_change"].to_numpy().astype(float)
    valid = np.isfinite(r) & np.isfinite(volume_change)
    r = r[valid]
    volume_change = volume_change[valid]
    if len(r) < 40 or np.std(r) == 0 or np.std(volume_change) == 0:
        return None, []
    v = float(np.corrcoef(r, volume_change)[0, 1])
    return v, [f"corr(日对数收益, 成交量对数变化, 最长60日)，共同有效观测={len(r)} = {v:.6f}"]


@_ref("UPVOLRATIO")
def _upvolratio(win, ctx):
    """近20日上涨日成交额占比：上涨日(r>0)成交额/全部成交额。"""
    # 价格窗口最多取 21 行以形成 20 个收益观测；新上市股票按生产端规则
    # 可使用更短窗口，但必须至少形成 15 个有效收益观测。
    if win.height < 16:
        return None, []
    w = win.tail(21)
    p = w["adj_close"].to_numpy().astype(float)
    a = w["amount"].to_numpy().astype(float)
    r = np.diff(np.log(p))
    a = a[1:]
    valid = np.isfinite(r) & np.isfinite(a)
    r = r[valid]
    a = a[valid]
    if len(r) < 15:
        return None, []
    tot = a.sum()
    if tot <= 0:
        return None, []
    v = float(a[r > 0].sum() / tot)
    return v, [f"上涨日成交额占比(20d) = {v:.6f}"]


@_ref("VR")
def _vr(win, ctx):
    """24 日成交量比率：上涨日量合计 / 下跌日量合计，平盘日不计。"""
    if win.height < 25:
        return None, []
    w = win.tail(25)
    p = w["adj_close"].to_numpy().astype(float)
    volume = w["volume"].to_numpy().astype(float)[1:]
    change = np.diff(p)
    valid = np.isfinite(change) & np.isfinite(volume) & (volume >= 0)
    if valid.sum() != 24:
        return None, []
    up_volume = float(volume[(change > 0) & valid].sum())
    down_volume = float(volume[(change < 0) & valid].sum())
    if down_volume <= 0:
        return None, []
    value = up_volume / down_volume
    return value, [
        f"近24日上涨日成交量合计={up_volume:.4f}",
        f"近24日下跌日成交量合计={down_volume:.4f}",
        f"VR24=上涨日量/下跌日量={value:.6f}（平盘日不计）",
    ]


@_ref("ABTURN")
def _abturn(win, ctx):
    """异常换手率：当日换手率相对近60日的Z分数。"""
    if win.is_empty():
        return None, []
    t = _turnover(win.tail(60))
    current = t[-1]
    if not np.isfinite(current):
        return None, []
    valid = t[np.isfinite(t)]
    if len(valid) < 40:
        return None, []
    sd = np.std(valid, ddof=1)
    if not np.isfinite(sd) or sd <= 0:
        return None, []
    v = float((current - np.mean(valid)) / sd)
    return v, [f"(turnover_t-mean(turnover,最长60日))/std(turnover,最长60日)，有效换手日={len(valid)} = {v:.6f}"]


@_ref("HIGHMOMTURN")
def _highmomturn(win, ctx):
    factor_raw = ctx.get("_factor_raw")
    asof = ctx.get("_asof")
    stock = win["stock_code"][0] if "stock_code" in win.columns and win.height else None
    if factor_raw is not None and asof is not None and stock is not None:
        base = (
            factor_raw.filter(
                (pl.col("trade_date") == asof)
                & pl.col("factor_code").is_in(["MOM60", "TURN20"])
            )
            .select(["stock_code", "factor_code", "raw_value"])
            .pivot(index="stock_code", on="factor_code", values="raw_value", aggregate_function="first")
            .drop_nulls(["MOM60", "TURN20"])
        )
        if base.is_empty() or stock not in set(base["stock_code"].to_list()):
            return None, []
        ranked = (
            base.with_columns([
                (pl.col("MOM60").rank("average") / pl.len()).alias("mom_pct"),
                (pl.col("TURN20").rank("average") / pl.len()).alias("turn_pct"),
            ])
            .with_columns((pl.col("mom_pct") * pl.col("turn_pct")).alias("value"))
        )
        row = ranked.filter(pl.col("stock_code") == stock)
        if not row.is_empty():
            v = float(row["value"][0])
            return v, [f"用同截面 MOM60/TURN20 重算 pct_rank(MOM60)*pct_rank(TURN20) = {v:.6f}"]
    return None, []


# ---------- 均值回复 (market_extra) ----------
@_ref("PRICEZ")
def _pricez(win, ctx):
    """价格Zscore：(P_t-mean(P,20))/std(P,20), ddof=1。"""
    if win.height < 20:
        return None, []
    p = win.tail(20)["adj_close"].to_numpy().astype(float)
    sd = np.std(p, ddof=1)
    if sd == 0:
        return None, []
    v = float((p[-1] - p.mean()) / sd)
    return v, [f"(P_t-mean(P,20))/std(P,20) = {v:.6f}"]


@_ref("AROON")
def _aroon(win, ctx):
    if win.height < 25:
        return None, []
    w = win.tail(25)
    high = w["high"].to_numpy().astype(float)
    low = w["low"].to_numpy().astype(float)
    if not np.isfinite(high).all() or not np.isfinite(low).all():
        return None, []
    up = (int(np.argmax(high)) + 1) * 4.0
    down = (int(np.argmin(low)) + 1) * 4.0
    v = float(up - down)
    return v, [f"AroonUp(25)-AroonDown(25) = {v:.6f}"]


@_ref("MFLOW20")
def _mflow20(win, ctx):
    if win.height < 20:
        return None, []
    w = win.tail(20)
    close = w["close"].to_numpy().astype(float)
    high = w["high"].to_numpy().astype(float)
    low = w["low"].to_numpy().astype(float)
    volume = w["volume"].to_numpy().astype(float)
    if not all(np.isfinite(x).all() for x in [close, high, low, volume]):
        return None, []
    v = float(np.sum(((close + high + low) / 3.0) * volume * 100.0))
    return v, [f"sum(typical_price*volume*100,20) = {v:.6f}"]


@_ref("RVI")
def _rvi(win, ctx):
    if win.height < 1:
        return None, []
    row = win.tail(1).row(0, named=True)
    values = [row.get(c) for c in ["open", "high", "low", "close"]]
    if any(v is None or not np.isfinite(v) for v in values) or row["high"] <= row["low"]:
        return None, []
    v = float((row["close"] - row["open"]) / (row["high"] - row["low"]))
    return v, [f"(close-open)/(high-low) = {v:.6f}"]


@_ref("MA20BIAS")
def _ma20bias(win, ctx):
    """均线偏离度：P_t / mean(P,20) − 1。"""
    if win.height < 20:
        return None, []
    p = win.tail(20)["adj_close"].to_numpy().astype(float)
    ma = p.mean()
    if ma <= 0:
        return None, []
    v = float(p[-1] / ma - 1.0)
    return v, [f"P_t / mean(P,20) - 1 = {v:.6f}"]


@_ref("HLPOS")
def _hlpos(win, ctx):
    """近60日高低点位置：(P_t − min(P,60)) / (max(P,60) − min(P,60))。"""
    if win.height < 40:
        return None, []
    p = win.tail(60)["adj_close"].to_numpy().astype(float)
    lo = p.min()
    hi = p.max()
    if hi <= lo:
        return None, []
    v = float((p[-1] - lo) / (hi - lo))
    return v, [f"(P_t - min(P,60)) / (max-min,60) = {v:.6f}"]


# ---------- Beta ----------
def build_market_returns_ref(panel: pl.DataFrame) -> pl.DataFrame:
    """独立重建 cap-weighted 市场日对数收益: r_mkt(t)=Σ w_i(t-1) r_i(t)。"""
    df = panel.sort(["stock_code", "trade_date"]).with_columns(
        (pl.col("adj_close") / pl.col("adj_close").shift(1).over("stock_code")).log().alias("lr"),
        pl.col("market_cap").shift(1).over("stock_code").alias("mcp"),
    ).filter(pl.col("lr").is_not_null() & pl.col("mcp").is_not_null())
    return (
        df.group_by("trade_date")
        .agg((pl.col("lr") * pl.col("mcp")).sum().alias("num"), pl.col("mcp").sum().alias("den"))
        .with_columns((pl.col("num") / pl.col("den")).alias("market_return"))
        .select(["trade_date", "market_return"])
        .sort("trade_date")
    )


@_ref("BETA")
def _beta(win, ctx):
    mkt = ctx.get("market_returns")
    if mkt is None or win.is_empty():
        return None, []
    w = win.with_columns(
        (pl.col("adj_close") / pl.col("adj_close").shift(1)).log().alias("lr")
    ).join(mkt, on="trade_date", how="left").drop_nulls(["lr", "market_return"])
    asof = ctx.get("_asof") or win["trade_date"][-1]
    if w.height < 200 or (asof - w["trade_date"].max()).days > 10:
        return None, []
    rec = w.tail(252)
    y = rec["lr"].to_numpy()
    x = rec["market_return"].to_numpy()
    var = np.var(x, ddof=1)
    if var == 0:
        return None, []
    v = float(np.cov(y, x, ddof=1)[0, 1] / var)
    return v, [f"cov(r_i,r_mkt)/var(r_mkt)，最长252日、至少200日（实际{rec.height}日） = {v:.6f}"]


@_ref("DOWNBETA")
def _downbeta(win, ctx):
    mkt = ctx.get("market_returns")
    if mkt is None or win.is_empty():
        return None, []
    w = win.with_columns(
        (pl.col("adj_close") / pl.col("adj_close").shift(1)).log().alias("lr")
    ).join(mkt, on="trade_date", how="left").drop_nulls(["lr", "market_return"])
    asof = ctx.get("_asof") or win["trade_date"][-1]
    if w.height < 200 or (asof - w["trade_date"].max()).days > 10:
        return None, []
    recent_all = w.tail(252)
    if recent_all.height < 200:
        return None, []
    rec = recent_all.filter(pl.col("market_return") < 0)
    if rec.height < 20:
        return None, []
    y = rec["lr"].to_numpy()
    x = rec["market_return"].to_numpy()
    var = np.var(x, ddof=1)
    if var == 0:
        return None, []
    v = float(np.cov(y, x, ddof=1)[0, 1] / var)
    return v, [f"cov(r_i,r_mkt | r_mkt<0)/var(r_mkt | r_mkt<0)，最长252日、至少200日且下跌日{rec.height} = {v:.6f}"]
