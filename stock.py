"""
stock.py — A股波段分析工具（长线波段严选版）
用法：python stock.py
依赖：pip install akshare pandas numpy
"""

import json
import os
import sys
import warnings
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

try:
    import akshare as ak
    import pandas as pd
    import numpy as np
except ImportError as e:
    print(f"\n缺少依赖：{e}")
    print("请运行：pip install akshare pandas numpy")
    sys.exit(1)

# ═══════════════════════════════════════════════
# 常量：核心价值观重塑（非 5% 不抓）
# ═══════════════════════════════════════════════
FORWARD_DAYS  = 5        # 回测基准往后看5天
WIN_THRESHOLD = 5.0      # 涨/跌幅必须超过 5.0% 才算真正的波段机会，过滤小震荡
WEIGHTS_DIR   = "weights"                 

def _ensure_weights_dir():
    os.makedirs(WEIGHTS_DIR, exist_ok=True)

def _base_weights_file():
    return os.path.join(WEIGHTS_DIR, "weights_base.json")

def stock_weights_file(code):
    return os.path.join(WEIGHTS_DIR, f"weights_{code}.json")

def output_file(code, name=""):
    name_part = f"_{name}" if name else ""
    return f"data_{code}{name_part}.json"  

CALIBRATION_STOCKS =[
    ("600519","贵州茅台"),("000858","五粮液"),        
    ("300750","宁德时代"),("002594","比亚迪"),        
    ("600036","招商银行"),("601318","中国平安"),      
    ("000001","平安银行"),("601166","兴业银行"),      
    ("600900","长江电力"),("601088","中国神华"),      
    ("000568","泸州老窖"),("603288","海天味业"),      
    ("002415","海康威视"),("000725","京东方A"),       
    ("600276","恒瑞医药"),("000661","长春高新"),      
    ("601899","紫金矿业"),("000063","中兴通讯"),      
    ("000333","美的集团"),("600660","福耀玻璃"),      
]

SELL_RULES = {
    "rsi_overbought_high", "rsi_overbought", "kdj_death_cross",
    "macd_top_diverge", "volume_stall", "boll_upper_retreat", "volume_drop_streak",
}

# 考核窗口（非对称时间）：卖出求快躲暴跌，买入求稳防阴跌死猫跳
SIGNAL_WINDOWS = {
    # 卖出组（3-5天内必须暴跌，证明逃顶成功）
    "rsi_overbought_high":  3,
    "rsi_overbought":       5,
    "kdj_death_cross":      3,
    "macd_top_diverge":     5,
    "volume_stall":         3,
    "boll_upper_retreat":   3,
    "volume_drop_streak":   3,
    
    # 买入组（10-15天后还能保住5%的涨幅才算真底，过滤短线诱多）
    "rsi_oversold_deep":    10,
    "rsi_oversold":         10,
    "kdj_golden_cross":     10,
    "macd_bot_diverge":     15,
    "boll_lower_shrink":    10,
    "boll_lower_touch":     10,
    "drop_stop_shrink":     10,
    "ma20_pullback":        10,
}

DEFAULT_WEIGHTS = {
    "rsi_overbought_high": 3, "rsi_overbought":      1,
    "kdj_death_cross":     2, "macd_top_diverge":    3,
    "volume_stall":        2, "boll_upper_retreat":  2,
    "volume_drop_streak":  2,
    "rsi_oversold_deep":   3, "rsi_oversold":        1,
    "kdj_golden_cross":    3, "macd_bot_diverge":    3,
    "boll_lower_shrink":   3, "boll_lower_touch":    1,
    "drop_stop_shrink":    2, "ma20_pullback":       2,
}

FIXED_WEIGHTS = {
    "macd60_death":        1, "kdj60_drop":          1,
    "volume60_spike_drop": 1, "macd60_golden":       1,
    "kdj60_golden":        1,
    "index_weak":          1, "index_strong":        1,
    "money_inflow_big":    2, "money_inflow":        1,
    "money_outflow_big":   2, "money_outflow":       1,
}

ALL_DEFAULT_WEIGHTS = {**DEFAULT_WEIGHTS, **FIXED_WEIGHTS}

# ═══════════════════════════════════════════════
# 工具与指标
# ═══════════════════════════════════════════════
def safe(fn, *a, default=None, **kw):
    try:
        return fn(*a, **kw)
    except Exception as e:
        print(f"  [跳过] {fn.__name__}: {e}")
        return default

def ask(prompt, options=None):
    while True:
        ans = input(prompt).strip()
        if options is None: return ans
        if ans.lower() in options: return ans.lower()
        print(f"  请输入 {'/'.join(options)}")

def find_code(query: str) -> tuple:
    query = query.strip()
    if query.isdigit() and len(query) == 6:
        try:
            info = ak.stock_individual_info_em(symbol=query)
            d = dict(zip(info["item"], info["value"]))
            return query, d.get("股票简称", query)
        except Exception:
            return query, query
    try:
        df = ak.stock_info_a_code_name()
        hit = df[df["name"].str.contains(query, na=False)]
        if not hit.empty:
            row = hit.iloc[0]
            return str(row["code"]), str(row["name"])
    except Exception:
        pass
    try:
        spot = ak.stock_zh_a_spot_em()
        hit = spot[spot["名称"].str.contains(query, na=False)]
        if not hit.empty:
            row = hit.iloc[0]
            return str(row["代码"]), str(row["名称"])
    except Exception:
        pass
    raise ValueError(f"找不到股票「{query}」，请尝试输入6位代码")

def rsi(s, p=14):
    """标准 Wilder RSI（与 TradingView、东方财富、同花顺、Investing.com 完全一致）"""
    delta = s.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    
    # Wilder 平滑（核心修正点：用 ewm com=p-1）
    avg_gain = gain.ewm(com=p-1, adjust=False).mean()
    avg_loss = loss.ewm(com=p-1, adjust=False).mean()
    
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).round(2)

def macd(s, fast=12, slow=26, sig=9):
    ef = s.ewm(span=fast, adjust=False).mean()
    es = s.ewm(span=slow, adjust=False).mean()
    dif = ef - es
    dea = dif.ewm(span=sig, adjust=False).mean()
    return dif.round(4), dea.round(4), ((dif - dea) * 2).round(4)

def kdj(df, n=9):
    lo = df["low"].rolling(n).min()
    hi = df["high"].rolling(n).max()
    rsv = (df["close"] - lo) / (hi - lo).replace(0, np.nan) * 100
    K = rsv.ewm(com=2, adjust=False).mean()
    D = K.ewm(com=2, adjust=False).mean()
    return K.round(2), D.round(2), (3*K - 2*D).round(2)

def boll(df, w=20, m=2):
    mid = df["close"].rolling(w).mean()
    std = df["close"].rolling(w).std()
    return mid.round(3), (mid + m*std).round(3), (mid - m*std).round(3)

def add_ind(df):
    for w in [5, 10, 20, 60]:
        df[f"ma{w}"] = df["close"].rolling(w).mean().round(3)
    df["rsi14"]  = rsi(df["close"], 14)
    df["dif"], df["dea"], df["hist"] = macd(df["close"])
    df["k"], df["d"], df["j"] = kdj(df)
    df["bm"], df["bu"], df["bl"] = boll(df)
    df["vr"] = (df["volume"] / df["volume"].rolling(5).mean()).round(2)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - df["close"].shift(1)).abs(),
        (df["low"]  - df["close"].shift(1)).abs(),
    ], axis=1).max(axis=1)
    df["atr14"] = tr.rolling(14).mean().round(3)
    return df

# ═══════════════════════════════════════════════
# 数据抓取（多源切换 + 限流防封）
# ═══════════════════════════════════════════════
import time as _time
import pickle
from contextlib import contextmanager

_LAST_REQUEST_TIME = 0.0
_REQUEST_INTERVAL  = 2.0   
_BACKTEST_INTERVAL = 8.0   
_backtest_mode     = False  
_CACHE_DIR = ".stock_cache"

def _cache_path(prefix, code, tag=""):
    os.makedirs(_CACHE_DIR, exist_ok=True)
    today = datetime.today().strftime("%Y%m%d")
    fname = f"{prefix}_{code}{'_'+tag if tag else ''}_{today}.pkl"
    return os.path.join(_CACHE_DIR, fname)

def _load_cache(path):
    try:
        with open(path, "rb") as f: return pickle.load(f)
    except Exception: return None

def _save_cache(path, data):
    try:
        with open(path, "wb") as f: pickle.dump(data, f)
    except Exception: pass

@contextmanager
def _backtest_ctx():
    global _backtest_mode
    _backtest_mode = True
    try: yield
    finally: _backtest_mode = False

def _is_market_closed() -> bool:
    now = datetime.now()
    if now.weekday() >= 5: return True
    h, m = now.hour, now.minute
    # 修复：推迟到 16:00 才算盘后，防止缓存提前锁死尚未更新完整的残缺日线
    if h >= 16: return True
    if h < 9 or (h == 9 and m < 30): return True
    # 午休：11:30–13:00 视为休市，避免用不完整K线计算指标
    if (h == 11 and m >= 30) or h == 12: return True
    return False

def _throttle():
    global _LAST_REQUEST_TIME
    interval = _BACKTEST_INTERVAL if _backtest_mode else _REQUEST_INTERVAL
    elapsed  = _time.time() - _LAST_REQUEST_TIME
    if elapsed < interval: _time.sleep(interval - elapsed)
    _LAST_REQUEST_TIME = _time.time()

def _norm_daily(df):
    col_map = {
        "日期":"date","开盘":"open","收盘":"close",
        "最高":"high","最低":"low","成交量":"volume",
        "成交额":"amount","涨跌幅":"pct_chg","换手率":"turnover",
        "TDATE":"date","OPEN":"open","CLOSE":"close",
        "HIGH":"high","LOW":"low","TVOL":"volume",
        "TAMT":"amount","PCHG":"pct_chg","TURNOVER":"turnover",
        "date":"date","open":"open","close":"close",
        "high":"high","low":"low","vol":"volume",
        "amount":"amount","p_change":"pct_chg","turn":"turnover",
    }
    df = df.rename(columns={k:v for k,v in col_map.items() if k in df.columns})
    for col in ["open","close","high","low","volume"]:
        if col not in df.columns: return None
    if "pct_chg" not in df.columns: df["pct_chg"] = df["close"].pct_change() * 100
    if "turnover" not in df.columns: df["turnover"] = 0.0
    df["date"] = pd.to_datetime(df["date"])
    df = df[df["volume"] > 0]
    return df.sort_values("date").reset_index(drop=True)

def _fetch_em(code, start_str, end_str):
    _throttle()
    for attempt in range(3):
        try:
            df = ak.stock_zh_a_hist(
                symbol=code, period="daily", start_date=start_str, 
                end_date=end_str, adjust="qfq"
            )
            return _norm_daily(df)
        except Exception as e:
            if attempt < 2:
                wait = 5 * (2 ** attempt)
                print(f"[东方财富重试{attempt+1}] {e}，{wait}s后重试...")
                _time.sleep(wait)
            else: raise

def _fetch_163(code, start_str, end_str):
    _throttle()
    prefix = "sz" if code.startswith(("0", "3")) else "sh"
    s_fmt = f"{start_str[:4]}-{start_str[4:6]}-{start_str[6:]}"
    e_fmt = f"{end_str[:4]}-{end_str[4:6]}-{end_str[6:]}"
    df = ak.stock_zh_a_hist_tx(
        symbol=f"{prefix}{code}", start_date=s_fmt, 
        end_date=e_fmt, adjust="qfq"
    )
    return _norm_daily(df)

def _fetch_sina(code, start_str, end_str):
    _throttle()
    prefix = "sz" if code.startswith(("0","3")) else "sh"
    s_fmt = f"{start_str[:4]}-{start_str[4:6]}-{start_str[6:]}"
    e_fmt = f"{end_str[:4]}-{end_str[4:6]}-{end_str[6:]}"
    df = ak.stock_zh_a_daily(
        symbol=f"{prefix}{code}", start_date=s_fmt, 
        end_date=e_fmt, adjust="qfq"
    )
    return _norm_daily(df)

SOURCES =[("新浪财经", _fetch_sina), ("腾讯财经", _fetch_163), ("东方财富", _fetch_em)]

def _fetch_with_fallback(code, start_str, end_str, label=""):
    last_err = None
    for src_name, fn in SOURCES:
        try:
            df = fn(code, start_str, end_str)
            if df is not None and len(df) > 5:
                if label: print(f"  [{label}] {src_name} ✓        ", end="\r")
                return df
        except Exception as e:
            last_err = e
            wait = 6 if _backtest_mode else 3
            print(f"[{src_name}失败] {e}，{wait}秒后尝试下一个源...")
            _time.sleep(wait)
    raise ConnectionError(f"全部数据源均失败（{label}）: {last_err}")

def fetch_daily(code, days=90):
    market_closed = _is_market_closed()
    cache_file = _cache_path("daily", code, str(days))
    if market_closed:
        cached = _load_cache(cache_file)
        if cached is not None: return cached

    end   = datetime.today()
    start = end - timedelta(days=days + 45)
    df = _fetch_with_fallback(
        code, start.strftime("%Y%m%d"), end.strftime("%Y%m%d"), label=f"{code} 日线"
    )
    df = df.tail(days).copy()

    now   = datetime.now()
    today = pd.Timestamp(now.date())
    if not _is_market_closed() and now.weekday() < 5:
        last_date = df.iloc[-1]["date"] if not df.empty else None
        if last_date != today:
            try:
                prefix   = "sz" if code.startswith(("0","3")) else "sh"
                _throttle()   # 防止紧接日线请求后立刻再打1分钟接口
                df_1m    = ak.stock_zh_a_minute(symbol=f"{prefix}{code}", period="1", adjust="qfq")
                df_1m["day"] = pd.to_datetime(df_1m["day"])
                for col in ["open","high","low","close","volume","amount"]:
                    df_1m[col] = pd.to_numeric(df_1m[col], errors="coerce")
                
                today_1m = df_1m[df_1m["day"].dt.date == now.date()]
                if not today_1m.empty and today_1m["volume"].sum() > 0:
                    amt  = today_1m["amount"].sum()
                    vol  = today_1m["volume"].sum()
                    
                    # 修复假放量：单位对齐（历史是手，今日1m是股，除以100）
                    if not df.empty:
                        last_hist_row = df.iloc[-1]
                        if (last_hist_row["amount"] / last_hist_row["volume"]) > (last_hist_row["close"] * 50):
                            vol = vol / 100

                    recent     = today_1m.tail(10)
                    recent_vol = recent["volume"].sum()
                    vwap = (recent["amount"].sum() / recent_vol if recent_vol > 0 else amt / vol)

                    # 用真实分钟K线的最高/最低/开盘，仅close用近端VWAP
                    real_open = float(today_1m.iloc[0]["open"])
                    real_high = float(today_1m["high"].max())
                    real_low  = float(today_1m["low"].min())

                    synthetic = pd.DataFrame([{
                        "date":    today,
                        "open":    round(real_open, 3),
                        "high":    round(real_high, 3),
                        "low":     round(real_low,  3),
                        "close":   round(vwap, 3),
                        "volume":  vol,
                        "amount":  amt,
                        "pct_chg": round((vwap / float(df.iloc[-1]["close"]) - 1) * 100, 2),
                        "turnover": 0.0,
                    }])
                    df = pd.concat([df, synthetic], ignore_index=True)
            except Exception as e:
                print(f"  [今日合成K线] 失败：{e}")

    if market_closed: _save_cache(cache_file, df)
    return df

def fetch_history(code, years=4):
    cache_file = _cache_path("history", code, f"{years}y")
    cached = _load_cache(cache_file)
    if cached is not None:
        print(f"  [{code} {years}年历史] 命中缓存 ✓")
        return cached

    end   = datetime.today()
    start = end - timedelta(days=365 * years + 60)
    df = _fetch_with_fallback(
        code, start.strftime("%Y%m%d"), end.strftime("%Y%m%d"), label=f"{code} {years}年历史"
    )
    _save_cache(cache_file, df)
    return df

def fetch_60min(code):
    market_closed = _is_market_closed()
    cache_file = _cache_path("60min", code)
    if market_closed:
        cached = _load_cache(cache_file)
        if cached is not None: return cached

    prefix = "sz" if code.startswith(("0","3")) else "sh"
    try:
        _throttle()
        df_1m = ak.stock_zh_a_minute(symbol=f"{prefix}{code}", period="1", adjust="qfq")
    except Exception as e:
        print(f"[60min] 拉取失败：{e}")
        return None

    if df_1m is None or df_1m.empty: return None

    try:
        df_1m["day"] = pd.to_datetime(df_1m["day"])
        for col in ["open","high","low","close","volume","amount"]:
            df_1m[col] = pd.to_numeric(df_1m[col], errors="coerce")

        today = pd.Timestamp(datetime.now().date())
        df_hist = df_1m[df_1m["day"].dt.date < today.date()].dropna(subset=["close"]).copy()
        
        df_today = df_1m[df_1m["day"].dt.date == today.date()].copy()
        if not df_today.empty:
            # 仅修正 close 为每分钟 VWAP（防止集合竞价等零成交除零）
            safe_vol = df_today["volume"].replace(0, np.nan)
            df_today["close"] = (df_today["amount"] / safe_vol).ffill()
            # open/high/low 保留原始分钟数据，不做覆盖
            df_today = df_today.dropna(subset=["close"])

        df_combined = pd.concat([df_hist, df_today]).sort_values("day").reset_index(drop=True)
        df_combined = df_combined.dropna(subset=["close"])

        # 先按日期分组，再在每天内按60根物理切分
        # 避免末尾不足60根的天与下一天首根合并，导致跨日open串位
        day_chunks = []
        for _, day_df in df_combined.groupby(df_combined["day"].dt.date):
            day_df = day_df.reset_index(drop=True)
            day_chunks.append(
                day_df.groupby(day_df.index // 60).agg({
                    "day":    "last",
                    "open":   "first",
                    "high":   "max",
                    "low":    "min",
                    "close":  "last",
                    "volume": "sum",
                    "amount": "sum",
                })
            )
        df_60 = pd.concat(day_chunks).dropna(subset=["close"]).reset_index(drop=True)
        
        df_60 = df_60.rename(columns={"day":"datetime"})

        df_60["rsi14"] = rsi(df_60["close"], 14)
        _, _, df_60["hist"] = macd(df_60["close"])
        df_60["k"], df_60["d"], df_60["j"] = kdj(df_60)
        df_60["vr"] = (df_60["volume"] / df_60["volume"].rolling(5).mean()).round(2)

        result = df_60.tail(40)
        if market_closed: _save_cache(cache_file, result)
        return result
    except Exception as e:
        print(f"  [60min] 处理异常: {e}")
        return None

def fetch_index():
    market_closed = _is_market_closed()
    cache_file = _cache_path("index", "sh000300")
    if market_closed:
        cached = _load_cache(cache_file)
        if cached is not None: return cached

    _throttle()
    df = ak.stock_zh_index_daily(symbol="sh000300")
    df["pct_chg"] = df["close"].pct_change() * 100
    df = df.tail(20)
    t5 = float(df.tail(5)["pct_chg"].sum())
    env = ("强势" if t5>3 else "偏强" if t5>1 else "弱势" if t5<-3 else "偏弱" if t5<-1 else "震荡")
    result = {"trend_5d_pct": round(t5,2), "env": env, "close": round(float(df.iloc[-1]["close"]),2)}
    if market_closed: _save_cache(cache_file, result)
    return result

def fetch_money(code, df_daily=None):
    market_closed = _is_market_closed()
    cache_file = _cache_path("money", code)
    if market_closed:
        cached = _load_cache(cache_file)
        if cached is not None: return cached

    mkt = "sz" if code.startswith(("0","3")) else "sh"

    # 主路径：直接查个股信息获取流通市值，避免换手率单位歧义
    float_cap_yi = None
    try:
        _throttle()
        info = ak.stock_individual_info_em(symbol=code)
        d = dict(zip(info["item"], info["value"]))
        raw = d.get("流通市值")
        if raw is not None:
            float_cap_yi = float(raw) / 1e8   # 单位：亿元
    except Exception:
        pass

    # 备用路径：换手率逆推（akshare不同接口换手率单位不统一，做自适应判断）
    # 实测部分接口返回小数(0.0088)而非百分比(0.88)，直接/100会放大100倍
    # 通过两套结果与A股最大流通市值(约20万亿)比较来自动择优
    if float_cap_yi is None:
        try:
            if df_daily is not None and not df_daily.empty:
                temp_turnover = pd.to_numeric(df_daily["turnover"], errors="coerce").fillna(0)
                valid_df = df_daily[temp_turnover > 0]
                if not valid_df.empty:
                    last_valid = valid_df.iloc[-1]
                    t_val = float(last_valid["turnover"])
                    a_val = float(last_valid["amount"])
                    if t_val > 0 and a_val > 0:
                        cap_as_dec = (a_val / t_val) / 1e8           # t_val是小数形式
                        cap_as_pct = (a_val / (t_val / 100)) / 1e8   # t_val是百分比形式
                        MAX_CAP = 200_000   # A股流通市值上限参考：约20万亿，留10倍余量
                        # 哪个结果落在合理区间内就用哪个；都合理时优先选较小值（更保守）
                        in_range = lambda v: 5 <= v <= MAX_CAP
                        if in_range(cap_as_pct) and not in_range(cap_as_dec):
                            float_cap_yi = cap_as_pct
                        elif in_range(cap_as_dec) and not in_range(cap_as_pct):
                            float_cap_yi = cap_as_dec
                        elif in_range(cap_as_pct) and in_range(cap_as_dec):
                            float_cap_yi = min(cap_as_pct, cap_as_dec)
        except Exception:
            pass

    if float_cap_yi is None:
        float_cap_yi = 100.0

    big_thresh    = max(1000.0, float_cap_yi * 80)   
    normal_thresh = max(300.0,  float_cap_yi * 20)   

    _throttle()
    df = ak.stock_individual_fund_flow(stock=code, market=mkt)
    if df is None or df.empty: return None
    df = df.tail(5)
    cols = {"超大单净流入-净额":"sl","大单净流入-净额":"l"}
    df = df.rename(columns={k:v for k,v in cols.items() if k in df.columns})
    sl = sum(float(v)/1e4 for v in df.get("sl", pd.Series()).dropna())
    lg = sum(float(v)/1e4 for v in df.get("l",  pd.Series()).dropna())
    net = sl + lg
    sig = ("主力大幅净流入" if net>big_thresh else "主力净流入" if net>normal_thresh else
           "主力大幅净流出" if net<-big_thresh else "主力净流出" if net<-normal_thresh else "主力中性")
    result = {
        "5d_net_wan":       round(net, 2),
        "signal":           sig,
        "big_thresh_wan":   round(big_thresh, 0),
        "normal_thresh_wan":round(normal_thresh, 0),
        "float_cap_yi":     round(float_cap_yi, 1),
    }
    if market_closed: _save_cache(cache_file, result)
    return result

def fetch_lhb(code):
    market_closed = _is_market_closed()
    cache_file = _cache_path("lhb", code)
    if market_closed:
        cached = _load_cache(cache_file)
        if cached is not None: return cached
    _throttle()
    # 7个自然日约等于5个交易日，与描述"近5个交易日"保持一致
    s = (datetime.today()-timedelta(days=7)).strftime("%Y%m%d")
    e = datetime.today().strftime("%Y%m%d")
    try:
        df = ak.stock_lhb_detail_em(start_date=s, end_date=e)
        if df is None or df.empty:
            result = {"appeared": False, "note": "近5个交易日未上龙虎榜"}
            _save_cache(cache_file, result)
            return result
        code_col = next((c for c in df.columns if "代码" in c), None)
        if code_col: df = df[df[code_col].astype(str).str.contains(code)]
        if df.empty:
            result = {"appeared": False, "note": "近5个交易日未上龙虎榜"}
            _save_cache(cache_file, result)
            return result
    except Exception:
        return {"appeared": False, "note": "龙虎榜接口暂不可用"}

    seat_col = next((c for c in df.columns if "席位" in c or "营业部" in c), None)
    seats = " ".join(df[seat_col].dropna().astype(str).tolist()) if seat_col else ""
    inst  = any(k in seats for k in["机构","基金","社保","险资"])
    youzi = any(k in seats for k in["华鑫","财通","东莞","方正","国海","招商"])
    note  = ("机构席位出现，可能战略建仓或减仓" if inst else "游资席位活跃，注意短线炒作风险" if youzi else "近期上过龙虎榜，关注买卖方向")
    result = {"appeared": True, "has_institution": inst, "has_youzi": youzi, "note": note}
    _save_cache(cache_file, result)
    return result

def fetch_margin(code):
    cache_file = _cache_path("margin", code)
    cached = _load_cache(cache_file)
    if cached is not None: return cached
    _throttle()
    df = None
    for fn_name in["stock_margin_detail_em", "stock_margin_underlying_info_szse", "stock_margin_account_info"]:
        try:
            fn = getattr(ak, fn_name, None)
            if fn:
                df = fn(symbol=code)
                if df is not None and not df.empty: break
        except Exception: continue
    
    if df is None or (hasattr(df, 'empty') and df.empty):
        try:
            market = "sh" if code.startswith(("6","9")) else "sz"
            fn = getattr(ak, f"stock_margin_{market}_daily_em", None)
            if fn:
                df_all = fn()
                if df_all is not None and not df_all.empty:
                    code_col = next((c for c in df_all.columns if "代码" in c), None)
                    if code_col: df = df_all[df_all[code_col].astype(str)==code].tail(10)
        except Exception: pass

    if df is None or not hasattr(df, 'empty') or df.empty: return None
    col = next((c for c in df.columns if "融资余额" in c), None)
    if not col: return None
    try: df = df.sort_values(df.columns[0]).tail(10)
    except Exception: pass
    vals = df[col].dropna().values
    if len(vals) < 2: return None
    
    chg = (vals[-1]-vals[0])/vals[0]*100
    trend = ("融资余额增加，杠杆看多" if chg>5 else "融资余额减少，去杠杆" if chg<-5 else "融资余额平稳")
    result = {"10d_change_pct": round(float(chg), 2), "trend": trend}
    _save_cache(cache_file, result)
    return result

# ═══════════════════════════════════════════════
# 信号检测与双向趋势过滤
# ═══════════════════════════════════════════════
def _apply_signal(layer, typ, factor, detail, key, W, in_uptrend=False, in_downtrend=False, trend_sensitive=False):
    w = W.get(key, 1)
    if w < 0:
        typ    = "sell" if typ == "buy" else "buy"
        w      = abs(w)
        detail += "（反向指标）"
        
    trend_filtered = False
    if typ == "sell" and trend_sensitive and in_uptrend:
        w      = max(0.5, w / 2)
        detail += "（强势上涨中，回调信号可靠性偏低）"
        trend_filtered = True
    elif typ == "buy" and trend_sensitive and in_downtrend:
        w      = max(0.5, w / 2)
        detail += "（持续下跌中，反弹信号可靠性偏低）"
        trend_filtered = True
        
    return {"layer": layer, "type": typ, "factor": factor, "detail": detail, "weight": w, "trend_filtered": trend_filtered}

def _daily_sell_signals(df_d, in_uptrend, W):
    last = df_d.iloc[-1]
    prev = df_d.iloc[-2] if len(df_d) > 1 else last
    r20  = df_d.tail(20)
    r5   = df_d.tail(5)
    out  =[]

    def add(factor, detail, key, ts=False):
        out.append(_apply_signal("日线", "sell", factor, detail, key, W, in_uptrend=in_uptrend, trend_sensitive=ts))

    if last["rsi14"] > 75:
        add("RSI深度超买", f"RSI14={last['rsi14']:.1f}", "rsi_overbought_high", ts=True)
    elif last["rsi14"] > 70:
        add("RSI偏高",     f"RSI14={last['rsi14']:.1f}", "rsi_overbought",      ts=True)
    if prev["k"] > prev["d"] and last["k"] < last["d"] and last["k"] > 70:
        add("KDJ高位死叉", f"K={last['k']:.1f}下穿D={last['d']:.1f}", "kdj_death_cross", ts=True)
    if last["close"] >= r20["close"].max() * 0.99 and last["hist"] < r20["hist"].max() * 0.75:
        add("MACD顶背离", "价格新高但MACD柱未同步", "macd_top_diverge")
    if last["vr"] > 1.8 and abs(last["pct_chg"]) < 1.0:
        add("放量滞涨", f"量比={last['vr']:.1f}，涨幅不足1%", "volume_stall")
    if prev["close"] > prev["bu"] and last["close"] < last["bu"]:
        add("布林上轨回落", "前日突破今日回落", "boll_upper_retreat", ts=True)
    
    # 将超长行拆解，防复制截断
    drop_streak = (r5["pct_chg"] < 0).sum() >= 4
    if drop_streak and last["volume"] > r5["volume"].iloc[0]:
        add("放量连跌", f"近5日跌{(r5['pct_chg']<0).sum()}天且量能放大", "volume_drop_streak")

    return out

def _daily_buy_signals(df_d, in_downtrend, W):
    last = df_d.iloc[-1]
    prev = df_d.iloc[-2] if len(df_d) > 1 else last
    r20  = df_d.tail(20)
    pre5 = df_d.tail(6).head(5)
    out  =[]

    def add(factor, detail, key, ts=False):
        out.append(_apply_signal("日线", "buy", factor, detail, key, W, in_downtrend=in_downtrend, trend_sensitive=ts))

    if last["rsi14"] < 38 and last["rsi14"] >= 28:
        add("RSI偏低", f"RSI14={last['rsi14']:.1f}", "rsi_oversold", ts=True)
    if prev["k"] < prev["d"] and last["k"] > last["d"] and last["k"] < 30:
        add("KDJ低位金叉", f"K={last['k']:.1f}上穿D={last['d']:.1f}", "kdj_golden_cross", ts=True)
    if last["close"] <= last["bl"] * 1.015 and last["vr"] >= 0.7:
        add("触布林下轨", "触及下轨支撑", "boll_lower_touch", ts=True)

    if last["rsi14"] < 28:
        add("RSI深度超卖", f"RSI14={last['rsi14']:.1f}", "rsi_oversold_deep", ts=True)
    if last["close"] <= r20["close"].min() * 1.01 and last["hist"] > r20["hist"].min() * 0.75:
        add("MACD底背离", "价格新低但MACD柱收窄", "macd_bot_diverge")
    if last["close"] <= last["bl"] * 1.015 and last["vr"] < 0.7:
        add("缩量触布林下轨", "成交量骤降+触下轨", "boll_lower_shrink")
    
    if (pre5["pct_chg"] < 0).all() and last["volume"] < pre5["volume"].mean() * 0.55 and last["pct_chg"] > -0.8:
        add("连跌缩量止跌", "连跌后极致缩量且跌幅收窄", "drop_stop_shrink")
    
    # 将超长判断拆解，防截断
    ma_struct_ok = (not pd.isna(last["ma5"])) and (not pd.isna(last["ma20"])) and (not pd.isna(last["ma60"]))
    if ma_struct_ok and (last["ma5"] > last["ma20"] > last["ma60"]):
        if abs(last["close"] - last["ma20"]) / last["ma20"] < 0.025:
            add("多头回踩MA20", "均线多头精准回踩", "ma20_pullback")

    return out

def _60min_signals(df_60, in_uptrend, in_downtrend, W):
    out =[]
    if df_60 is None or len(df_60) < 10: return out
    ml, mp = df_60.iloc[-1], df_60.iloc[-2]

    def add(typ, factor, detail, key, ts=False):
        out.append(_apply_signal("60min", typ, factor, detail, key, W,
                                 in_uptrend=in_uptrend, in_downtrend=in_downtrend,
                                 trend_sensitive=ts))

    if mp["hist"] < 0 and ml["hist"] > 0:
        add("buy",  "60min MACD金叉",  "60分钟MACD翻正",     "macd60_golden",   ts=True)
    if mp["hist"] > 0 and ml["hist"] < 0:
        add("sell", "60min MACD死叉",  "60分钟MACD翻负",     "macd60_death",    ts=True)
    if mp["k"] < mp["d"] and ml["k"] > ml["d"] and ml["k"] < 35:
        add("buy",  "60min KDJ低位金叉", "60分钟低位金叉",   "kdj60_golden",    ts=True)
    if mp["k"] > mp["d"] and ml["k"] < ml["d"] and ml["k"] > 65:
        add("sell", "60min KDJ高位死叉", "60分钟高位死叉",   "kdj60_drop",      ts=True)
    if ml["vr"] > 2.0 and ml["hist"] < df_60.tail(10)["hist"].min() * 0.9:
        add("sell", "60min 放量急跌",  "60分钟放量MACD急跌", "volume60_spike_drop")
    return out

def _market_signals(idx, W):
    out, index_adj =[], 0
    if not idx: return out, 0
    t5, env = idx.get("trend_5d_pct", 0), idx.get("env", "")
    if env == "弱势" or t5 < -3:
        out.append(_apply_signal("大盘", "sell", "大盘弱势", f"沪深300近5日{t5:+.1f}%", "index_weak", W))
        index_adj = -1
    elif env in ("强势", "偏强") or t5 > 2:
        out.append(_apply_signal("大盘", "buy",  "大盘偏强", f"沪深300近5日{t5:+.1f}%", "index_strong", W))
        index_adj = 1
    return out, index_adj

def _money_signals(money, W):
    out =[]
    if not money: return out
    net = money.get("5d_net_wan", 0) or 0
    big_t, normal_t = money.get("big_thresh_wan", 8000), money.get("normal_thresh_wan", 2000)
    if   net >  big_t:    out.append(_apply_signal("资金", "buy",  "主力大幅净流入", f"近5日净流入{net:.0f}万",     "money_inflow_big",  W))
    elif net >  normal_t: out.append(_apply_signal("资金", "buy",  "主力净流入",     f"近5日净流入{net:.0f}万",     "money_inflow",      W))
    elif net < -big_t:    out.append(_apply_signal("资金", "sell", "主力大幅净流出", f"近5日净流出{abs(net):.0f}万", "money_outflow_big", W))
    elif net < -normal_t: out.append(_apply_signal("资金", "sell", "主力净流出",     f"近5日净流出{abs(net):.0f}万", "money_outflow",     W))
    return out

def detect(df_d, df_60, money, idx, weights):
    W, last = weights, df_d.iloc[-1]
    pct = float(last["pct_chg"]) if not pd.isna(last.get("pct_chg", float("nan"))) else 0.0
    last_close = float(last["close"])
    last_high   = float(last["high"])
    last_low    = float(last["low"])
    # 用相对价差判停板：振幅/收盘价 < 0.05%，且涨跌幅 > 9.5%（适配全价位区间）
    spread_ratio = (last_high - last_low) / last_close if last_close > 0 else 1.0
    is_limit = spread_ratio < 0.0005 and abs(pct) > 9.5
    if is_limit:
        return {
            "action": "HOLD", "action_cn": "停板日——信号无效，持仓不动",
            "net_score": 0, "sell_score": 0, "buy_score": 0,
            "signals":[{"layer": "停板", "type": "halt", "factor": "涨停板" if pct>0 else "跌停板", "detail": "等停板打开后再评估", "weight": 0}],
            "in_uptrend": False, "trend_filter_active": False, 
            "limit_status": "LIMIT_UP" if pct>0 else "LIMIT_DOWN",
        }

    ma5  = float(last["ma5"])  if not pd.isna(last["ma5"])  else None
    ma20 = float(last["ma20"]) if not pd.isna(last["ma20"]) else None
    ma60 = float(last["ma60"]) if not pd.isna(last["ma60"]) else None
    ma5_5d_ago = (float(df_d.iloc[-6]["ma5"]) if len(df_d) >= 6 and not pd.isna(df_d.iloc[-6]["ma5"]) else None)
    
    in_uptrend = (ma5 and ma20 and ma60 and ma5 > ma20 > ma60 and ma5_5d_ago is not None and ma5 > ma5_5d_ago)
    in_downtrend = (ma5 and ma20 and ma60 and ma20 < ma60 and float(last["close"]) < ma20)

    market_sigs, index_adj = _market_signals(idx, W)
    signals = (
        _daily_sell_signals(df_d, in_uptrend, W)
        + _daily_buy_signals(df_d, in_downtrend, W)
        + _60min_signals(df_60, in_uptrend, in_downtrend, W)
        + market_sigs + _money_signals(money, W)
    )

    sell = sum(s["weight"] for s in signals if s["type"] == "sell")
    buy  = sum(s["weight"] for s in signals if s["type"] == "buy")
    net  = buy - sell
    buy_thresh = 3 if index_adj >= 0 else 4

    if   net <= -3:            action, cn = "SELL_WAVE",  "建议先抛"
    elif net <= -2:            action, cn = "WATCH_SELL", "留意下行风险"
    elif net >= buy_thresh:    action, cn = "BUY_ADD",    "可考虑买回/加仓"
    elif net >= 2:             action, cn = "WATCH_BUY",  "关注加仓机会"
    else:                      action, cn = "HOLD",       "持有不动"

    return {
        "action": action, "action_cn": cn,
        "net_score": net, "sell_score": sell, "buy_score": buy,
        "signals": signals, "in_uptrend": in_uptrend, 
        "trend_filter_active": in_uptrend or in_downtrend, "limit_status": None,
    }

# ═══════════════════════════════════════════════
# 价格结构与形态摘要
# ═══════════════════════════════════════════════
def price_struct(df, action):
    last, c = df.iloc[-1], round(float(df.iloc[-1]["close"]), 2)
    r20, r60 = df.tail(20), df.tail(60) if len(df)>=60 else df
    hi20, lo20 = float(r20["high"].max()), float(r20["low"].min())
    hi60, lo60 = float(r60["high"].max()), float(r60["low"].min())
    ma20 = float(last["ma20"]) if not pd.isna(last["ma20"]) else c
    bu   = float(last["bu"])   if not pd.isna(last["bu"])   else c*1.05
    bl   = float(last["bl"])   if not pd.isna(last["bl"])   else c*0.95

    support = round(max(ma20*0.98, lo20*1.01), 2)
    resist = round(min(hi20*0.99, bu), 2)
    stop_loss = round(lo20*0.965, 2)
    
    if support > c:
        support   = min(round(lo60 * 1.005, 2), round(c * 0.99, 2))
        stop_loss = round(lo60 * 0.965, 2)

    atr = float(last["atr14"]) if "atr14" in last and not pd.isna(last["atr14"]) else c * 0.015

    if action in ("SELL_WAVE","WATCH_SELL"):
        offset = min(max(atr * 0.3, c * 0.002), c * 0.010)
        op, half = round(c + offset, 2), round(atr * 0.4, 2)
        orng =[round(op - half, 2), round(op + half, 2)]
        onote = f"建议在 {orng[0]}～{orng[1]} 区间挂卖单"
    elif action in ("BUY_ADD","WATCH_BUY"):
        # 支撑在现价下方：以现价为基准挂单（信号已触发，不必等跌到支撑）
        # 支撑在现价附近（±2%以内）：在支撑处接，更安全
        base = support if support >= c * 0.98 else c
        offset = min(max(atr * 0.3, base * 0.002), base * 0.015)
        op, half = round(base - offset, 2), round(atr * 0.4, 2)
        orng =[round(op - half, 2), round(op + half, 2)]
        onote = f"建议在 {orng[0]}～{orng[1]} 区间分批接回"
    else:
        op, orng, onote = None, None, "当前无波段操作建议，持有等待"

    return {
        "current_price": c, "high_20d":hi20, "low_20d":lo20, "high_60d":hi60, "low_60d":lo60,
        "ma5": round(float(last["ma5"]),2) if not pd.isna(last["ma5"]) else None, 
        "ma20": round(ma20,2),
        "ma60": round(float(last["ma60"]),2) if not pd.isna(last["ma60"]) else None,
        "boll_upper": round(bu,2), "boll_lower": round(bl,2),
        "support": support, "resistance": resist, "stop_loss": stop_loss,
        "order_price": op, "order_range": orng, "order_note": onote,
    }

def build_shape_desc(df, ps_data, sig_data):
    last, r20, r5, c = df.iloc[-1], df.tail(20), df.tail(5), float(df.iloc[-1]["close"])
    ma5 = float(last["ma5"]) if not pd.isna(last["ma5"]) else c
    ma20 = float(last["ma20"]) if not pd.isna(last["ma20"]) else c
    ma60 = float(last["ma60"]) if not pd.isna(last["ma60"]) else c
    bu = float(last["bu"]) if not pd.isna(last["bu"]) else c*1.05
    bl = float(last["bl"]) if not pd.isna(last["bl"]) else c*0.95
    rsi_v, parts = float(last["rsi14"]) if not pd.isna(last["rsi14"]) else 50,[]

    ma5_5d_ago = float(df.iloc[-6]["ma5"]) if len(df) >= 6 and not pd.isna(df.iloc[-6]["ma5"]) else None
    slope = (ma5 - ma5_5d_ago) / ma5 * 100 if ma5_5d_ago else 0
    if ma5 > ma20 > ma60:
        parts.append(f"多头排列{'斜率向上' if slope>0.3 else '走平'}" + ("" if ma5_5d_ago and ma5 > ma5_5d_ago else "（MA5走平）"))
    elif ma5 < ma20 < ma60: parts.append("空头排列阴跌趋势")
    elif c < ma20:          parts.append(f"跌破MA20均线（MA20={ma20:.2f}）")
    elif abs(c - ma20) / ma20 < 0.02: parts.append(f"贴近MA20均线支撑")
    else:                   parts.append("均线结构混乱震荡")

    boll_pos = (c - bl) / (bu - bl) * 100 if bu != bl else 50
    if boll_pos >= 90:   parts.append(f"触上轨超买区")
    elif boll_pos <= 10: parts.append(f"触下轨超卖区")

    if rsi_v > 75:   parts.append(f"RSI={rsi_v:.0f}深度超买")
    elif rsi_v < 28: parts.append(f"RSI={rsi_v:.0f}深度超卖")

    avg_vol5, avg_vol20, chg5 = float(r5["volume"].mean()), float(r20["volume"].mean()), float(r5["pct_chg"].sum())
    vol_ratio = avg_vol5 / avg_vol20 if avg_vol20 > 0 else 1
    if   vol_ratio > 1.5 and chg5 >  2: parts.append(f"放量上涨")
    elif vol_ratio > 1.5 and chg5 < -2: parts.append(f"放量下跌出货")
    elif vol_ratio < 0.6:               parts.append(f"明显缩量")

    if sig_data.get("trend_filter_active"): parts.append("⚡ 信号已按趋势方向校正")
    return "；".join(parts)

def build_position_hint(ps_data, sig_data, idx_data):
    action, c = sig_data["action"], ps_data["current_price"]
    sup, sl, net, hints = ps_data["support"], ps_data["stop_loss"], sig_data["net_score"],[]
    
    if c < sup:
        if c > sl:
            if action in ("BUY_ADD", "WATCH_BUY"): hints.append(f"【超跌试探】现价低于支撑{sup}，可小仓位试探接回，止损参考{sl}。")
            elif action == "HOLD" and net >= -1:   hints.append(f"【破位观察】跌破支撑{sup}，等稳定再接，不追跌。")
            else:                                  hints.append(f"【暂缓介入】卖压仍强，等站回{sup}再说。")
        else: hints.append(f"【止损警示】已跌破止损线{sl}，下行未解除，切勿接回。")
    else:
        if action == "HOLD" and net >= -1:       hints.append(f"【仓位管理】暂无明确买入信号，等回落至{sup}附近再考虑分批建首仓。")
        elif action in ("WATCH_BUY", "BUY_ADD"):
            op = ps_data.get("order_price") or sup
            near = abs(op - c) / c < 0.02   # 接回价在现价2%以内，视为"现价附近"
            if near:
                hints.append(f"【接回时机】买入信号明确，可在{op}附近分批建仓，止损参考{sl}。")
            else:
                hints.append(f"【等回踩接回】信号已触发，接回价{op}低于现价{c}，等回踩再建仓，或现价小仓试探，止损参考{sl}。")
        elif action in ("SELL_WAVE", "WATCH_SELL"): hints.append(f"【等待观望】卖压仍强，高抛筹码暂不接回。")
    if idx_data:
        env = idx_data.get("env", "")
        if env in ("弱势", "偏弱"):   hints.append(f"大盘{env}，接回节奏放慢。")
        elif env in ("强势", "偏强"): hints.append(f"大盘{env}，可积极接回防踏空。")
    return " ".join(hints) if hints else None

def kline_rows(df, n=20):
    cols =["date","open","close","high","low","volume","pct_chg","rsi14","hist","k","d","ma5","ma20","vr"]
    r = df.tail(n)[cols].copy()
    r["date"] = r["date"].dt.strftime("%Y-%m-%d")
    return r.round(3).where(r.notna(), None).to_dict(orient="records")

def min_rows(df):
    cols =["datetime","open","close","high","low","volume","rsi14","hist","k","d","vr"]
    r = df[cols].copy()
    r["datetime"] = r["datetime"].dt.strftime("%Y-%m-%d %H:%M")
    return r.round(3).where(r.notna(), None).to_dict(orient="records")

# ═══════════════════════════════════════════════
# 回测与校准（双向独立基准胜率）
# ═══════════════════════════════════════════════
def run_backtest(code, name, years=4):
    print(f"\n  拉取 {name} 近{years}年历史数据...")
    df = fetch_history(code, years=years)
    df = add_ind(df)
    df = df.dropna(subset=["rsi14","k","d","hist","bu","bl","ma20"]).reset_index(drop=True)
    N = len(df)
    print(f"  有效交易日：{N} 天")
    if N < 120: return None

    def rule_triggers(df):
        last, prev = df, df.shift(1)
        r20_hi, r20_lo = df["close"].rolling(20).max(), df["close"].rolling(20).min()
        r20_hhi, r20_llo = df["hist"].rolling(20).max(), df["hist"].rolling(20).min()
        
        # 拆解超长推导，防止截断报错
        roll_down = df["pct_chg"].rolling(5).apply(lambda x: (x<0).all(), raw=True).shift(1)
        pre5_all_down = (roll_down == 1)
        vr5_mean = df["volume"].rolling(5).mean().shift(1)
        
        return {
            "rsi_overbought_high": last["rsi14"] > 75, 
            "rsi_overbought": (last["rsi14"]>70) & (last["rsi14"]<=75),
            "kdj_death_cross": (prev["k"]>prev["d"]) & (last["k"]<last["d"]) & (last["k"]>70),
            "macd_top_diverge": (last["close"]>=r20_hi*0.99) & (last["hist"]<r20_hhi*0.75),
            "volume_stall": (last["vr"]>1.8) & (last["pct_chg"].abs()<1.0),
            "boll_upper_retreat": (prev["close"]>prev["bu"]) & (last["close"]<last["bu"]),
            "volume_drop_streak": (df["pct_chg"].rolling(5).apply(lambda x:(x<0).sum()>=4,raw=True)==1) & (last["volume"]>df["volume"].shift(4)),
            
            "rsi_oversold_deep": last["rsi14"] < 28, 
            "rsi_oversold": (last["rsi14"]>=28) & (last["rsi14"]<38),
            "kdj_golden_cross": (prev["k"]<prev["d"]) & (last["k"]>last["d"]) & (last["k"]<30),
            "macd_bot_diverge": (last["close"]<=r20_lo*1.01) & (last["hist"]>r20_llo*0.75),
            "boll_lower_shrink": (last["close"]<=last["bl"]*1.015) & (last["vr"]<0.7),
            "boll_lower_touch": (last["close"]<=last["bl"]*1.015) & (last["vr"]>=0.7),
            "drop_stop_shrink": pre5_all_down & (last["volume"]<vr5_mean*0.55) & (last["pct_chg"]>-0.8),
            "ma20_pullback": (last["ma5"]>last["ma20"]) & (last["ma20"]>last["ma60"]) & ((last["close"]-last["ma20"]).abs()/last["ma20"]<0.025),
        }

    triggers = rule_triggers(df)
    unique_windows = set(SIGNAL_WINDOWS.values())
    
    open_arr = df["open"].values
    close_arr = df["close"].values
    high_arr = df["high"].values
    low_arr = df["low"].values
    pct_arr = df["pct_chg"].values
    
    limit_next = (
        (np.abs(high_arr - low_arr) / np.where(close_arr > 0, close_arr, 1) < 0.0005)
        & (np.abs(pct_arr) > 9.5)
    )
    
    window_base_rates = {}
    for w in unique_windows:
        if N > w + 1:
            tradable   = ~limit_next[1 : N - w]           
            entry_base = open_arr[1 : N - w][tradable]    
            exit_base  = close_arr[1 + w : N][tradable]   
            if len(entry_base) == 0:
                window_base_rates[w] = {"buy": 10.0, "sell": 10.0}
                continue
            rets_w = (exit_base - entry_base) / entry_base * 100
            
            buy_win_rate = round(float((rets_w > WIN_THRESHOLD).mean() * 100), 1)
            sell_win_rate = round(float((rets_w < -WIN_THRESHOLD).mean() * 100), 1)
            window_base_rates[w] = {"buy": buy_win_rate, "sell": sell_win_rate}
        else: 
            window_base_rates[w] = {"buy": 10.0, "sell": 10.0}
        
    stock_base_rate = window_base_rates.get(FORWARD_DAYS, {"buy": 10.0, "sell": 10.0})
    print(f"  该股基准自然概率（大涨>5%概率={stock_base_rate['buy']}%, 暴跌<-5%概率={stock_base_rate['sell']}%）")

    open_next = df["open"].shift(-1)
    high_next = df["high"].shift(-1)
    low_next = df["low"].shift(-1)
    pct_next = df["pct_chg"].shift(-1)
    
    close_next = df["close"].shift(-1)
    next_is_limit = (
        ((high_next - low_next).abs() / close_next.replace(0, np.nan) < 0.0005)
        & (pct_next.abs() > 9.5)
    )

    results = {}
    for rule_key, mask in triggers.items():
        window = SIGNAL_WINDOWS.get(rule_key, FORWARD_DAYS)
        close_future = df["close"].shift(-(1 + window))  
        valid = mask & ~next_is_limit & open_next.notna() & close_future.notna()
        entry_vals, exit_vals = open_next[valid].values, close_future[valid].values

        if len(entry_vals) == 0:
            results[rule_key] = {"n":0,"win_rate":None,"avg_ret":None,"window":window}
            continue

        rets = (exit_vals - entry_vals) / entry_vals * 100
        
        if rule_key in SELL_RULES:
            wins = (rets < -WIN_THRESHOLD).sum()
        else:
            wins = (rets > WIN_THRESHOLD).sum()

        results[rule_key] = {
            "n": len(rets), "win_rate": round(wins / len(rets) * 100, 1),
            "avg_ret": round(float(rets.mean()), 2), "window": window,
        }
    return results, stock_base_rate, window_base_rates

def run_calibration():
    from collections import defaultdict
    print("\n  ┌─ 正在用20只代表股校准默认权重（抓5%大波段标准）──┐")
    agg_wins, agg_total, agg_ret = defaultdict(int), defaultdict(int), defaultdict(list)
    all_window_base_rates = defaultdict(lambda: {"buy": [], "sell":[]})

    done = 0
    with _backtest_ctx():
        for attempt, (code, name) in enumerate(CALIBRATION_STOCKS, 1):
            print(f"[{attempt:02d}/{len(CALIBRATION_STOCKS)}] {name}({code})...", end="\r")
            try:
                bt_result = run_backtest(code, name, years=4)
                if bt_result:
                    bt, _, wbr = bt_result
                    for w, rates_dict in wbr.items():
                        all_window_base_rates[w]["buy"].append(rates_dict["buy"])
                        all_window_base_rates[w]["sell"].append(rates_dict["sell"])
                    for key, res in bt.items():
                        if res["n"] and res["win_rate"] is not None:
                            w = int(res["n"] * res["win_rate"] / 100)
                            agg_wins[key]  += w
                            agg_total[key] += res["n"]
                            if res["avg_ret"] is not None: agg_ret[key].append(res["avg_ret"])
                    done += 1
            except Exception: pass

    if done == 0: return dict(DEFAULT_WEIGHTS)

    # 拆解字典推导式，防止被强制换行截断
    calib_window_base = {}
    for w, d in all_window_base_rates.items():
        if d["buy"]:
            calib_window_base[w] = {
                "buy": round(float(np.mean(d["buy"])), 1),
                "sell": round(float(np.mean(d["sell"])), 1)
            }

    base_rate = calib_window_base.get(FORWARD_DAYS, {"buy": 10.0, "sell": 10.0})
    new_w, calibrated_vals = {}, []

    for key in DEFAULT_WEIGHTS:
        if key not in agg_total or agg_total[key] < 15: continue
        n, wr = agg_total[key], agg_wins[key] / agg_total[key] * 100
        avg_ret = float(np.mean(agg_ret[key])) if agg_ret[key] else None
        
        key_base_dict = calib_window_base.get(SIGNAL_WINDOWS.get(key, FORWARD_DAYS), base_rate)
        key_base = key_base_dict["sell"] if key in SELL_RULES else key_base_dict["buy"]
        
        adv = wr - key_base
        w = 3 if adv>=10 else 2 if adv>=5 else 1 if adv>=-5 else (-1 if adv>=-10 else -2)

        is_sell = key in SELL_RULES
        ev_bad  = avg_ret is not None and (avg_ret > 0 if is_sell else avg_ret < 0)
        if ev_bad and w > 0: w = max(-2, w - 1)
        new_w[key] = w
        calibrated_vals.append(abs(w))

    fallback = int(np.median(calibrated_vals)) if calibrated_vals else 1
    for key in DEFAULT_WEIGHTS:
        if key not in new_w: new_w[key] = fallback
    return new_w

def _load_json(path):
    try:
        with open(path, encoding="utf-8") as f: return json.load(f)
    except Exception: return {}

def _save_json(path, data):
    with open(path, "w", encoding="utf-8") as f: json.dump(data, f, ensure_ascii=False, indent=2)

def merge_weights(code):
    base, stock, merged = _load_json(_base_weights_file()), _load_json(stock_weights_file(code)), {}
    for k in ALL_DEFAULT_WEIGHTS:
        if k in FIXED_WEIGHTS: merged[k] = FIXED_WEIGHTS[k]        
        elif k in stock:       merged[k] = stock[k]                
        elif k in base:        merged[k] = base[k]                 
        else:                  merged[k] = DEFAULT_WEIGHTS.get(k, 1)  
    return merged

def save_base_weights(w):
    _ensure_weights_dir(); _save_json(_base_weights_file(), w)

def save_stock_weights(code, w):
    _ensure_weights_dir(); _save_json(stock_weights_file(code), w)

def has_base_weights():
    return os.path.exists(_base_weights_file())

def compute_weights(bt_results, stock_base_rate=None, base_weights=None, window_base_rates=None):
    if stock_base_rate is None: stock_base_rate = {"buy":10.0, "sell":10.0}
    new_w, calibrated_vals = {},[]

    for key, res in bt_results.items():
        if key not in DEFAULT_WEIGHTS: continue
        n, wr, avg_ret = res["n"], res["win_rate"], res.get("avg_ret")
        if n >= 20 and wr is not None:
            base_dict = window_base_rates.get(SIGNAL_WINDOWS.get(key, FORWARD_DAYS), stock_base_rate) if window_base_rates else stock_base_rate
            key_base = base_dict["sell"] if key in SELL_RULES else base_dict["buy"]
            adv = wr - key_base
            w = 3 if adv>=10 else 2 if adv>=5 else 1 if adv>=-5 else (-1 if adv>=-10 else -2)

            is_sell_rule = key in SELL_RULES
            if (avg_ret is not None and (avg_ret > 0 if is_sell_rule else avg_ret < 0)) and w > 0:
                w = max(-2, w - 1)
                res["ev_penalized"] = True
                
            # 与 run_calibration 保持一致：上限3，下限-2
            w = max(-2, min(3, w))
            new_w[key] = w
            calibrated_vals.append(abs(w))

    if base_weights:
        for key in list(new_w.keys()):
            base_val = base_weights.get(key, DEFAULT_WEIGHTS.get(key, 1))
            blended  = 0.6 * new_w[key] + 0.4 * base_val
            # blended==0：个股与通用方向完全对冲，保留个股方向最小权重±1
            # abs(blended)<0.5：四舍五入会归零，同样保留方向最小权重
            if blended == 0:
                new_w[key] = 1 if new_w[key] > 0 else (-1 if new_w[key] < 0 else (1 if base_val >= 0 else -1))
            elif abs(blended) < 0.5:
                new_w[key] = 1 if blended > 0 else -1
            else:
                new_w[key] = max(-2, min(3, round(blended)))

    result = {}
    print(f"\n  ┌─ 个股评估结果（目标波段>5%，消除噪音）──────────────────┐")
    for key in DEFAULT_WEIGHTS:
        if key in new_w:
            w, res = new_w[key], bt_results.get(key, {})
            base_d = window_base_rates.get(SIGNAL_WINDOWS.get(key, FORWARD_DAYS), stock_base_rate) if window_base_rates else stock_base_rate
            key_base = base_d["sell"] if key in SELL_RULES else base_d["buy"]
            adv = res.get("win_rate", 0) - key_base
            marker = "★" if adv>=5 else ("⟳反向" if w<0 else ("↑" if adv>=0 else "↓"))
            flag = f"{marker}真胜率{res.get('win_rate',0):.0f}%(自然率{key_base:.1f}%) → 权重{w:+d}"
        elif base_weights and key in base_weights:
            w, flag = base_weights[key], f"样本不足 → 沿用通用权重 {base_weights[key]}"
        else:
            w, flag = DEFAULT_WEIGHTS[key], f"样本不足 → 默认值 {DEFAULT_WEIGHTS[key]}"
        result[key] = w
        print(f"  │ {key.replace('_',' '):28s} {flag}")
    print("  └──────────────────────────────────────────────────────┘")
    return result

# ═══════════════════════════════════════════════
# 主交互流程
# ═══════════════════════════════════════════════
def main():
    print("\n" + "═"*52)
    print("  A股波段分析工具  长线持股 · 严选波段（过滤阴跌死猫跳）")
    print("═"*52)

    while True:
        query = ask("\n请输入股票名称或代码：")
        if not query: continue
        try:
            print("  查找中...", end="\r")
            code, name = find_code(query)
            print(f"  找到：{name}（{code}）        ")
            break
        except ValueError as e:
            print(f"  {e}")

    if not has_base_weights():
        print("\n  首次启动，自动校准通用大波段权重...")
        base_w = safe(run_calibration, default=dict(DEFAULT_WEIGHTS))
        save_base_weights(base_w)
        print(f"\n  通用权重已就绪。")
        do_bt = ask(f"  是否针对 {name} 跑个股回测？(y/n)：", ["y","n"])
    else:
        src = f"通用+个股({code})" if os.path.exists(stock_weights_file(code)) else "通用"
        print(f"\n  当前权重来源：{src}")
        do_bt = ask(f"  是否针对 {name} 重新跑个股回测？(y/n)：", ["y","n"])

    if do_bt == "y":
        print(f"\n  ─ 针对 {name}（{code}）回测（严格过滤微跌微涨）─")
        with _backtest_ctx():
            bt_result = safe(run_backtest, code, name, years=4)
        if bt_result:
            bt, stock_base_rate, window_base_rates = bt_result
            base_w   = _load_json(_base_weights_file())
            stock_w  = compute_weights(bt, stock_base_rate=stock_base_rate, base_weights=base_w, window_base_rates=window_base_rates)
            save_stock_weights(code, stock_w)

    weights = merge_weights(code)
    weights_src = "个股+通用" if os.path.exists(stock_weights_file(code)) else ("通用" if has_base_weights() else "内置默认")

    print("\n  ─ 抓取当前数据 ─")
    print(f"[日线数据（90日）]...", end="\r")
    df_d = safe(lambda: add_ind(fetch_daily(code, 90)))
    if df_d is not None: print(f"[日线数据（90日）] ✓        ")
    else:
        print("  日线数据获取失败，无法继续")
        sys.exit(1)

    steps =[
        ("60分钟线",         lambda: fetch_60min(code)),
        ("沪深300",          lambda: fetch_index()),
        ("大单资金流向",     lambda: fetch_money(code, df_daily=df_d)),
        ("龙虎榜（近5日）", lambda: fetch_lhb(code)),
        ("融资融券",         lambda: fetch_margin(code)),
    ]

    results_data =[]
    for label, fn in steps:
        print(f"  [{label}]...", end="\r")
        result = safe(fn)
        results_data.append(result)
        if result is not None: print(f"[{label}] ✓        ")
        else: print(f"  [{label}] —（跳过）  ")

    df_60, idx, money, lhb, margin = results_data

    sig = detect(df_d, df_60, money, idx, weights)
    ps  = price_struct(df_d, sig["action"])
    shape_desc = build_shape_desc(df_d, ps, sig)
    position_hint = build_position_hint(ps, sig, idx)

    output = {
        "meta": {"stock_name": name, "stock_code": code, "fetch_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "weights_source": weights_src},
        "wave_signals": sig, "price_structure": ps, "market_index": idx,
        "smart_money": {"fund_flow":money,"lhb":lhb,"margin":margin},
        "shape_desc": shape_desc, "position_hint": position_hint,
        "daily_klines_20d": kline_rows(df_d),
        "intraday_60min": min_rows(df_60) if df_60 is not None else None,
    }

    out_path = output_file(code, name)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print("\n" + "─"*52)
    print(f"  {name}（{code}）  当前价：{ps['current_price']} 元")
    print(f"  {'─'*48}")
    icon = {"SELL_WAVE":"↓","WATCH_SELL":"⚠","HOLD":"—","WATCH_BUY":"△","BUY_ADD":"↑"}.get(sig["action"],"?")
    print(f"  {icon} {sig['action_cn']}  （净分={sig['net_score']:+d}，卖={sig['sell_score']}，买={sig['buy_score']}）")
    print(f"  {ps['order_note']}")
    print(f"  支撑={ps['support']}  压力={ps['resistance']}  止损={ps['stop_loss']}")
    if idx: print(f"  大盘：{idx['env']}，近5日{idx['trend_5d_pct']:+.1f}%")
    if money: print(f"  主力：{money['signal']}（近5日净{money['5d_net_wan']:+.0f}万）")
    print(f"  {'─'*48}")
    print(f"  已输出：{out_path}")
    print("─"*52 + "\n")

if __name__ == "__main__":
    main()