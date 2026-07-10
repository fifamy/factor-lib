"""市场交易信息类·扩充因子（对应技术文档 2.1~2.8，用本地 price.csv 字段可算的部分）。

全部向量化（polars 按 stock_code 分组算，避免逐股 Python 循环拖慢 02 流水线）。
输入 panel 列：stock_code, trade_date, adj_close, amount, free_shares, total_shares,
              market_cap, is_suspended。
每个 @factor 函数返回 DataFrame(stock_code, value)，value 为该因子在 asof 截面的原始值。

口径要点：
- 收益用复权收盘价 adj_close 的对数收益。
- 换手率 = amount / 流通市值；本地 market_cap 来自 Wind S_DQ_MV，实测为流通市值。
  （amount 千元、market_cap 万元，故 turnover = amount/market_cap/10）
- 所有窗口都取 asof 当天可观察的过去 N 个交易日（trade_date <= asof）。
"""
from __future__ import annotations

from datetime import date
import polars as pl

from factor_lib.registry import factor


from datetime import timedelta


def _window(panel: pl.DataFrame, asof: date, lookback: int) -> pl.DataFrame:
    """先按【日期下界】裁剪到 asof 往前足够覆盖 lookback 个交易日的窗口，再算收益。

    关键性能点：price_panel 有 1750 万行（回溯到 1990），若直接 filter(trade_date<=asof)
    再对全量做 .over('stock_code') 排名会极慢。这里先用日历日下界把行数砍到约 lookback×股票数，
    交易日按 ~0.7 个/日历日折算，多留 60 天缓冲。
    """
    cal_days = int(lookback / 0.66) + 60
    lo = asof - timedelta(days=cal_days)
    df = (panel.filter((pl.col("trade_date") <= asof) & (pl.col("trade_date") >= lo))
               .sort(["stock_code", "trade_date"]))
    return df.with_columns(
        (pl.col("adj_close") / pl.col("adj_close").shift(1).over("stock_code"))
            .log().alias("ret"))


def _hist(panel: pl.DataFrame, asof: date, lookback: int) -> pl.DataFrame:
    """取 asof 及之前、每只股票最近 lookback 个交易日（已日期下界裁剪 → 再取每股末 lookback 行）。"""
    df = _window(panel, asof, lookback)
    df = df.with_columns(
        pl.col("trade_date").rank("ordinal", descending=True).over("stock_code").alias("_rk"))
    return df.filter(pl.col("_rk") <= lookback)


def _turnover_col() -> pl.Expr:
    float_mv = pl.col("market_cap")
    # 流通市值为 0 或非有限时换手率无意义，
    # 置空以避免除零产生 inf/NaN 污染 TURN20/TURNVOL/ABTURN/TURNPCTL。
    return (
        pl.when((float_mv > 0) & float_mv.is_finite())
        .then(pl.col("amount") / float_mv / 10.0)
        .otherwise(None)
        .alias("turnover")
    )


# ============================== 2.1 收益趋势类 ==============================

@factor(code="REV5D", l1="市场交易信息", l2="动量", direction=-1,
        formula="REV5D = sum_{d=t-4..t} ln(S_DQ_ADJCLOSE_d / S_DQ_ADJCLOSE_{d-1})",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 5 个交易日累计对数收益（短期反转：近 5 日涨多的下期倾向回调，方向为负）。")
def rev5d(panel, asof):
    h = _hist(panel, asof, 5)
    return (h.group_by("stock_code")
             .agg(pl.col("ret").sum().alias("value"))
             .filter(pl.col("value").is_not_null()))


@factor(code="MOM60", l1="市场交易信息", l2="动量", direction=1,
        formula="MOM60 = sum_{d=t-59..t} ln(S_DQ_ADJCLOSE_d / S_DQ_ADJCLOSE_{d-1})",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 60 个交易日（约 3 个月）累计对数收益，中期动量。")
def mom60(panel, asof):
    h = _hist(panel, asof, 60)
    out = (h.group_by("stock_code")
            .agg([pl.col("ret").sum().alias("value"), pl.len().alias("n")]))
    return out.filter(pl.col("n") >= 40).select(["stock_code", "value"])


@factor(code="MOM20", l1="市场交易信息", l2="动量", direction=1,
        formula="MOM20 = sum_{d=t-19..t} ln(S_DQ_ADJCLOSE_d / S_DQ_ADJCLOSE_{d-1})",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 20 个交易日（约 1 个月）累计对数收益，短中期动量。")
def mom20(panel, asof):
    h = _hist(panel, asof, 20)
    out = (h.group_by("stock_code")
            .agg([pl.col("ret").sum().alias("value"), pl.len().alias("n")]))
    return out.filter(pl.col("n") >= 15).select(["stock_code", "value"])


# ============================== 2.2 均值回复类 ==============================

@factor(code="PRICEZ", l1="市场交易信息", l2="均值回复", direction=-1,
        formula="PRICEZ = (S_DQ_ADJCLOSE_t - mean(S_DQ_ADJCLOSE, 60)) / std(S_DQ_ADJCLOSE, 60)",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="价格 Zscore：(现价 − 近 60 日均价) / 近 60 日价格标准差；越高越偏离均值，方向负（回复）。")
def pricez(panel, asof):
    h = _hist(panel, asof, 60)
    out = (h.group_by("stock_code")
            .agg([pl.col("adj_close").last().alias("p"),
                  pl.col("adj_close").mean().alias("mu"),
                  pl.col("adj_close").std().alias("sd"),
                  pl.len().alias("n")])
            .filter((pl.col("n") >= 40) & (pl.col("sd") > 0))
            .with_columns(((pl.col("p") - pl.col("mu")) / pl.col("sd")).alias("value")))
    return out.select(["stock_code", "value"])


@factor(code="MA20BIAS", l1="市场交易信息", l2="均值回复", direction=-1,
        formula="MA20BIAS = S_DQ_ADJCLOSE_t / mean(S_DQ_ADJCLOSE, 20) - 1",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="均线偏离度：现价 / 近 20 日均价 − 1；正偏离越大越偏贵，方向负（回复）。")
def ma20bias(panel, asof):
    h = _hist(panel, asof, 20)
    out = (h.group_by("stock_code")
            .agg([pl.col("adj_close").last().alias("p"),
                  pl.col("adj_close").mean().alias("ma"),
                  pl.len().alias("n")])
            .filter((pl.col("n") >= 15) & (pl.col("ma") > 0))
            .with_columns((pl.col("p") / pl.col("ma") - 1).alias("value")))
    return out.select(["stock_code", "value"])


@factor(code="HLPOS", l1="市场交易信息", l2="均值回复", direction=-1,
        formula="HLPOS = (S_DQ_ADJCLOSE_t - min(S_DQ_ADJCLOSE, 60)) / (max(S_DQ_ADJCLOSE, 60) - min(S_DQ_ADJCLOSE, 60))",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 60 日高低点位置：(现价 − 60 日最低) / (60 日最高 − 60 日最低)，0~1；越接近高点越负向（回复）。")
def hlpos(panel, asof):
    h = _hist(panel, asof, 60)
    out = (h.group_by("stock_code")
            .agg([pl.col("adj_close").last().alias("p"),
                  pl.col("adj_close").min().alias("lo"),
                  pl.col("adj_close").max().alias("hi"),
                  pl.len().alias("n")])
            .filter((pl.col("n") >= 40) & (pl.col("hi") > pl.col("lo")))
            .with_columns(((pl.col("p") - pl.col("lo")) / (pl.col("hi") - pl.col("lo"))).alias("value")))
    return out.select(["stock_code", "value"])


# ============================== 2.3 波动风险类 ==============================

@factor(code="DOWNVOL", l1="市场交易信息", l2="波动", direction=-1,
        formula="DOWNVOL = std(ln(P_d/P_{d-1}) | ln(P_d/P_{d-1}) < 0, 252) * sqrt(252)，P=S_DQ_ADJCLOSE",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="下行波动率：近 252 日负收益的标准差 × √252；只看下跌的波动，越高风险越大。")
def downvol(panel, asof):
    h = _hist(panel, asof, 252)
    neg = h.filter(pl.col("ret") < 0)
    out = (neg.group_by("stock_code")
             .agg([pl.col("ret").std().alias("sd"), pl.len().alias("n")])
             .filter(pl.col("n") >= 20)
             .with_columns((pl.col("sd") * (252 ** 0.5)).alias("value")))
    return out.select(["stock_code", "value"])


@factor(code="MAXDD1Y", l1="市场交易信息", l2="波动", direction=1,
        formula="MAXDD1Y = min(S_DQ_ADJCLOSE_d / cummax(S_DQ_ADJCLOSE_d, 252) - 1)",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 252 日最大回撤（按复权价，负数）；越接近 0 回撤越浅，方向正。")
def maxdd1y(panel, asof):
    h = _hist(panel, asof, 252).sort(["stock_code", "trade_date"])
    # 累计最高价 → 回撤 = price/cummax − 1，取最小
    h = h.with_columns(pl.col("adj_close").cum_max().over("stock_code").alias("peak"))
    h = h.with_columns((pl.col("adj_close") / pl.col("peak") - 1).alias("dd"))
    out = (h.group_by("stock_code")
            .agg([pl.col("dd").min().alias("value"), pl.len().alias("n")])
            .filter(pl.col("n") >= 60))
    return out.select(["stock_code", "value"])


@factor(code="RETSKEW", l1="市场交易信息", l2="波动", direction=1,
        formula="RETSKEW = skew(ln(S_DQ_ADJCLOSE_d / S_DQ_ADJCLOSE_{d-1}), 252)",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 252 日日收益偏度；负偏（左尾厚、易暴跌）更差，方向正。")
def retskew(panel, asof):
    h = _hist(panel, asof, 252)
    out = (h.group_by("stock_code")
            .agg([pl.col("ret").skew().alias("value"), pl.col("ret").count().alias("n")])
            .filter((pl.col("n") >= 60) & pl.col("value").is_finite()))
    return out.select(["stock_code", "value"])


@factor(code="RETKURT", l1="市场交易信息", l2="波动", direction=-1,
        formula="RETKURT = kurtosis(ln(S_DQ_ADJCLOSE_d / S_DQ_ADJCLOSE_{d-1}), 252)",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 252 日日收益峰度；峰度高=极端波动多，方向负。")
def retkurt(panel, asof):
    h = _hist(panel, asof, 252)
    out = (h.group_by("stock_code")
            .agg([pl.col("ret").kurtosis().alias("value"), pl.col("ret").count().alias("n")])
            .filter((pl.col("n") >= 60) & pl.col("value").is_finite()))
    return out.select(["stock_code", "value"])


@factor(code="BIGDOWN", l1="市场交易信息", l2="波动", direction=-1,
        formula="BIGDOWN = count(ln(S_DQ_ADJCLOSE_d / S_DQ_ADJCLOSE_{d-1}) < -0.05, 60) / count(valid return, 60)",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 60 日大跌天数：单日跌幅 > 5% 的天数占比；越高越脆弱，方向负。")
def bigdown(panel, asof):
    h = _hist(panel, asof, 60)
    out = (h.group_by("stock_code")
            .agg([(pl.col("ret") < -0.05).sum().alias("big"), pl.col("ret").count().alias("n")])
            .filter(pl.col("n") >= 40)
            .with_columns((pl.col("big") / pl.col("n")).alias("value")))
    return out.select(["stock_code", "value"])


# ============================== 2.5 流动性类 ==============================

@factor(code="AMOUNT20", l1="市场交易信息", l2="流动性", direction=-1,
        name_cn="近20日日均成交额",
        formula="ln(mean(S_DQ_AMOUNT, 20))",
        wind_source="AShareEODPrices.S_DQ_AMOUNT",
        description="近 20 日日均成交额（对数）；大盘高流动性历史溢价低，方向负（偏小流动性）。")
def amount20(panel, asof):
    h = _hist(panel, asof, 20)
    out = (h.group_by("stock_code")
            .agg([pl.col("amount").mean().alias("amt"), pl.len().alias("n")])
            .filter((pl.col("n") >= 15) & (pl.col("amt") > 0))
            .with_columns(pl.col("amt").log().alias("value")))
    return out.select(["stock_code", "value"])


@factor(code="VOLUME20", l1="市场交易信息", l2="流动性", direction=1,
        name_cn="近20日日均成交量",
        formula="mean(S_DQ_AMOUNT / S_DQ_ADJCLOSE, 20)，作为成交量近似值。",
        wind_source="AShareEODPrices.S_DQ_AMOUNT; AShareEODPrices.S_DQ_ADJCLOSE",
        description="近 20 日日均成交量近似值：成交额 / 复权收盘价；按 Word v2 流动性口径方向为正。")
def volume20(panel, asof):
    h = _hist(panel, asof, 20)
    out = (h.filter((pl.col("adj_close") > 0) & pl.col("amount").is_not_null())
            .with_columns((pl.col("amount") / pl.col("adj_close")).alias("volume_proxy"))
            .group_by("stock_code")
            .agg([pl.col("volume_proxy").mean().alias("value"), pl.len().alias("n")])
            .filter(pl.col("n") >= 15))
    return out.select(["stock_code", "value"])


@factor(code="TURN20", l1="市场交易信息", l2="流动性", direction=-1,
        formula="TURN20 = mean(TURN, 20)，TURN = S_DQ_AMOUNT / S_DQ_MV / 10",
        wind_source="AShareEODPrices.S_DQ_AMOUNT; AShareEODDerivativeIndicator.S_DQ_MV",
        description="近 20 日日均换手率；高换手（投机/拥挤）历史表现弱，方向负。")
def turn20(panel, asof):
    df = _window(panel, asof, 20).with_columns(_turnover_col())
    df = df.with_columns(
        pl.col("trade_date").rank("ordinal", descending=True).over("stock_code").alias("_rk"))
    h = df.filter(pl.col("_rk") <= 20)
    out = (h.group_by("stock_code")
            .agg([pl.col("turnover").mean().alias("value"), pl.len().alias("n")])
            .filter((pl.col("n") >= 15) & pl.col("value").is_finite()))
    return out.select(["stock_code", "value"])


@factor(code="AMTVOL", l1="市场交易信息", l2="流动性", direction=-1,
        formula="AMTVOL = std(S_DQ_AMOUNT, 60) / mean(S_DQ_AMOUNT, 60)",
        wind_source="AShareEODPrices.S_DQ_AMOUNT",
        description="近 60 日成交额波动率：日成交额的变异系数（std/mean）；越不稳定越负向。")
def amtvol(panel, asof):
    h = _hist(panel, asof, 60)
    out = (h.group_by("stock_code")
            .agg([pl.col("amount").mean().alias("mu"), pl.col("amount").std().alias("sd"),
                  pl.len().alias("n")])
            .filter((pl.col("n") >= 40) & (pl.col("mu") > 0))
            .with_columns((pl.col("sd") / pl.col("mu")).alias("value")))
    return out.select(["stock_code", "value"])


@factor(code="TURNVOL", l1="市场交易信息", l2="流动性", direction=-1,
        formula="TURNVOL = std(TURN, 60)，TURN = S_DQ_AMOUNT / S_DQ_MV / 10",
        wind_source="AShareEODPrices.S_DQ_AMOUNT; AShareEODDerivativeIndicator.S_DQ_MV",
        description="近 60 日换手率波动率：日换手率标准差；换手忽高忽低=不稳定资金，方向负。")
def turnvol(panel, asof):
    df = _window(panel, asof, 60).with_columns(_turnover_col())
    df = df.with_columns(
        pl.col("trade_date").rank("ordinal", descending=True).over("stock_code").alias("_rk"))
    h = df.filter(pl.col("_rk") <= 60)
    out = (h.group_by("stock_code")
            .agg([pl.col("turnover").std().alias("value"), pl.len().alias("n")])
            .filter((pl.col("n") >= 40) & pl.col("value").is_finite()))
    return out.select(["stock_code", "value"])


@factor(code="TURNPCTL", l1="市场交易信息", l2="流动性", direction=-1,
        name_cn="换手率历史分位",
        formula="rank_pct(TURN_t, 120)，TURN = S_DQ_AMOUNT / S_DQ_MV / 10。",
        wind_source="AShareEODPrices.S_DQ_AMOUNT; AShareEODDerivativeIndicator.S_DQ_MV",
        description="最新日换手率在近 120 个交易日内的历史分位；换手越处高位越拥挤，方向负。")
def turnpctl(panel, asof):
    h = _hist(panel, asof, 120).with_columns(_turnover_col())
    h = h.filter(pl.col("turnover").is_not_null())
    latest = (h.sort(["stock_code", "trade_date"])
                .group_by("stock_code")
                .agg([pl.col("turnover").last().alias("latest_turnover"),
                      pl.len().alias("n")]))
    ranked = (h.join(latest, on="stock_code")
                .filter((pl.col("n") >= 60) & (pl.col("turnover") <= pl.col("latest_turnover")))
                .group_by("stock_code")
                .agg([pl.len().alias("le_count"), pl.col("n").first().alias("n")])
                .with_columns((pl.col("le_count") / pl.col("n")).alias("value")))
    return ranked.select(["stock_code", "value"])


# ============================== 2.7 价量配合类 ==============================

@factor(code="PVCORR", l1="市场交易信息", l2="价量", direction=-1,
        formula="PVCORR = corr(ln(S_DQ_ADJCLOSE_d / S_DQ_ADJCLOSE_{d-1}), S_DQ_AMOUNT_d, 60)",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE; AShareEODPrices.S_DQ_AMOUNT",
        description="近 60 日收益率与成交额的相关性；高正相关=追涨放量（拥挤），方向负。")
def pvcorr(panel, asof):
    h = _hist(panel, asof, 60).filter(pl.col("ret").is_not_null())
    out = (h.group_by("stock_code")
            .agg([pl.corr("ret", "amount").alias("value"), pl.len().alias("n")])
            .filter((pl.col("n") >= 40) & pl.col("value").is_finite()))
    return out.select(["stock_code", "value"])


@factor(code="UPVOLRATIO", l1="市场交易信息", l2="价量", direction=-1,
        formula="UPVOLRATIO = sum(S_DQ_AMOUNT_d | ret_d > 0, 60) / sum(S_DQ_AMOUNT_d, 60)，ret_d=ln(S_DQ_ADJCLOSE_d/S_DQ_ADJCLOSE_{d-1})",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE; AShareEODPrices.S_DQ_AMOUNT",
        description="近 60 日上涨日成交额占比：上涨日成交额 / 总成交额；过高=放量追涨，方向负。")
def upvolratio(panel, asof):
    h = _hist(panel, asof, 60).filter(pl.col("ret").is_not_null())
    out = (h.group_by("stock_code")
            .agg([pl.col("amount").filter(pl.col("ret") > 0).sum().alias("up"),
                  pl.col("amount").sum().alias("tot"), pl.len().alias("n")])
            .filter((pl.col("n") >= 40) & (pl.col("tot") > 0))
            .with_columns((pl.col("up") / pl.col("tot")).alias("value")))
    return out.select(["stock_code", "value"])


# ============================== 2.8 拥挤度类 ==============================

@factor(code="ABTURN", l1="市场交易信息", l2="拥挤度", direction=-1,
        formula="ABTURN = mean(TURN, 5) / mean(TURN, 60) - 1，TURN = S_DQ_AMOUNT / S_DQ_MV / 10",
        wind_source="AShareEODPrices.S_DQ_AMOUNT; AShareEODDerivativeIndicator.S_DQ_MV",
        description="异常换手率：近 5 日均换手 / 近 60 日均换手 − 1；骤升=短期拥挤，方向负。")
def abturn(panel, asof):
    df = _window(panel, asof, 60).with_columns(_turnover_col())
    df = df.with_columns(
        pl.col("trade_date").rank("ordinal", descending=True).over("stock_code").alias("_rk"))
    t5 = (df.filter(pl.col("_rk") <= 5).group_by("stock_code")
            .agg(pl.col("turnover").mean().alias("t5")))
    t60 = (df.filter(pl.col("_rk") <= 60).group_by("stock_code")
             .agg([pl.col("turnover").mean().alias("t60"), pl.len().alias("n")]))
    out = (t5.join(t60, on="stock_code")
             .filter((pl.col("n") >= 40) & (pl.col("t60") > 0))
             .with_columns((pl.col("t5") / pl.col("t60") - 1).alias("value"))
             .filter(pl.col("value").is_finite()))
    return out.select(["stock_code", "value"])


@factor(code="HIGHMOMTURN", l1="市场交易信息", l2="拥挤度", direction=-1,
        name_cn="高动量+高换手",
        formula="HIGHMOMTURN = pct_rank(MOM60) * pct_rank(TURN20)，按月末截面计算。",
        wind_source="AShareEODPrices.S_DQ_ADJCLOSE; AShareEODPrices.S_DQ_AMOUNT; AShareEODDerivativeIndicator.S_DQ_MV",
        description="60 日动量横截面分位与 20 日日均换手横截面分位的乘积；越高代表上涨且交易拥挤，方向负。")
def highmomturn(panel, asof):
    h = _hist(panel, asof, 60).with_columns(_turnover_col())
    mom = (
        h.group_by("stock_code")
        .agg([pl.col("ret").sum().alias("mom60"), pl.len().alias("n_mom")])
        .filter((pl.col("n_mom") >= 40) & pl.col("mom60").is_finite())
    )
    turn = (
        h.sort(["stock_code", "trade_date"])
        .with_columns(pl.col("trade_date").rank("ordinal", descending=True).over("stock_code").alias("_rk"))
        .filter(pl.col("_rk") <= 20)
        .group_by("stock_code")
        .agg([pl.col("turnover").mean().alias("turn20"), pl.len().alias("n_turn")])
        .filter((pl.col("n_turn") >= 15) & pl.col("turn20").is_finite())
    )
    base = mom.join(turn, on="stock_code", how="inner")
    if base.is_empty():
        return pl.DataFrame({"stock_code": [], "value": []})
    return (
        base.with_columns([
            (pl.col("mom60").rank("average") / pl.len()).alias("mom_pct"),
            (pl.col("turn20").rank("average") / pl.len()).alias("turn_pct"),
        ])
        .with_columns((pl.col("mom_pct") * pl.col("turn_pct")).alias("value"))
        .select(["stock_code", "value"])
    )
