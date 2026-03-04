#!/usr/bin/env python3
"""Generate a daily financial summary between Beijing 09:00 windows."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

BEIJING_TZ = ZoneInfo("Asia/Shanghai")
UTC = dt.timezone.utc
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    )
}

INDEX_SYMBOLS = [
    ("S&P 500", "^GSPC"),
    ("NASDAQ Composite", "^IXIC"),
    ("Dow Jones Industrial Average", "^DJI"),
    ("Russell 2000", "^RUT"),
    ("FTSE 100", "^FTSE"),
    ("DAX", "^GDAXI"),
    ("CAC 40", "^FCHI"),
    ("Nikkei 225", "^N225"),
    ("Hang Seng Index", "^HSI"),
    ("CSI 300", "000300.SS"),
    ("Shanghai Composite", "000001.SS"),
    ("Shenzhen Component", "399001.SZ"),
]

SECTOR_STOCKS = {
    "科技/半导体": [
        ("Apple", "AAPL"),
        ("Microsoft", "MSFT"),
        ("NVIDIA", "NVDA"),
        ("Taiwan Semiconductor", "TSM"),
    ],
    "金融": [
        ("JPMorgan Chase", "JPM"),
        ("Bank of America", "BAC"),
        ("HSBC", "0005.HK"),
        ("中国平安", "601318.SS"),
    ],
    "能源": [
        ("Exxon Mobil", "XOM"),
        ("Chevron", "CVX"),
        ("中国石油", "601857.SS"),
        ("中国海洋石油", "0883.HK"),
    ],
    "消费": [
        ("Amazon", "AMZN"),
        ("Walmart", "WMT"),
        ("贵州茅台", "600519.SS"),
        ("阿里巴巴", "9988.HK"),
    ],
    "医药健康": [
        ("Johnson & Johnson", "JNJ"),
        ("Eli Lilly", "LLY"),
        ("辉瑞", "PFE"),
        ("恒瑞医药", "600276.SS"),
    ],
}


@dataclass
class Snapshot:
    name: str
    symbol: str
    start_price: float | None
    end_price: float | None
    current_price: float | None
    currency: str | None
    change_pct: float | None
    error: str | None = None


def beijing_window(reference: dt.datetime | None = None) -> tuple[dt.datetime, dt.datetime]:
    now = (reference or dt.datetime.now(tz=BEIJING_TZ)).astimezone(BEIJING_TZ)
    end = now.replace(hour=9, minute=0, second=0, microsecond=0)
    if now < end:
        end -= dt.timedelta(days=1)
    start = end - dt.timedelta(days=1)
    return start, end


def epoch_seconds(value: dt.datetime) -> int:
    return int(value.astimezone(UTC).timestamp())


def http_get_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    query = urlencode(params)
    request = Request(f"{url}?{query}", headers=HEADERS)
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_chart(symbol: str, start: dt.datetime, end: dt.datetime) -> dict[str, Any]:
    params = {
        "period1": epoch_seconds(start) - 3600,
        "period2": epoch_seconds(end) + 3600,
        "interval": "60m",
        "includePrePost": "true",
        "events": "div,splits",
    }
    url = YAHOO_CHART_URL.format(symbol=symbol)
    return http_get_json(url, params)


def fetch_quotes(symbols: list[str]) -> dict[str, dict[str, Any]]:
    payload = http_get_json(YAHOO_QUOTE_URL, {"symbols": ",".join(symbols)})
    result = payload.get("quoteResponse", {}).get("result", [])
    return {item.get("symbol"): item for item in result if item.get("symbol")}


def nearest_price(
    timestamps: list[int], prices: list[float | None], target: dt.datetime
) -> float | None:
    target_ts = epoch_seconds(target)
    best: tuple[int, float] | None = None
    for ts, price in zip(timestamps, prices):
        if price is None:
            continue
        dist = abs(ts - target_ts)
        if best is None or dist < best[0]:
            best = (dist, float(price))
    return best[1] if best else None


def summarize_symbol(
    name: str,
    symbol: str,
    start: dt.datetime,
    end: dt.datetime,
    quote_map: dict[str, dict[str, Any]],
) -> Snapshot:
    try:
        chart = fetch_chart(symbol, start, end)
        result = chart["chart"]["result"][0]
        timestamps = result.get("timestamp", [])
        closes = result.get("indicators", {}).get("quote", [{}])[0].get("close", [])
        start_price = nearest_price(timestamps, closes, start)
        end_price = nearest_price(timestamps, closes, end)

        quote = quote_map.get(symbol, {})
        current_price = quote.get("regularMarketPrice")
        currency = quote.get("currency")

        change_pct = None
        if start_price and end_price:
            change_pct = (end_price - start_price) / start_price * 100

        return Snapshot(
            name=name,
            symbol=symbol,
            start_price=start_price,
            end_price=end_price,
            current_price=float(current_price) if current_price is not None else None,
            currency=currency,
            change_pct=change_pct,
        )
    except Exception as exc:  # noqa: BLE001
        return Snapshot(
            name=name,
            symbol=symbol,
            start_price=None,
            end_price=None,
            current_price=None,
            currency=None,
            change_pct=None,
            error=str(exc),
        )


def format_pct(value: float | None) -> str:
    if value is None:
        return "N/A"
    return f"{value:+.2f}%"


def format_price(value: float | None) -> str:
    if value is None:
        return "N/A"
    return f"{value:,.2f}"


def render_markdown(
    start: dt.datetime,
    end: dt.datetime,
    index_data: list[Snapshot],
    sector_data: dict[str, list[Snapshot]],
    global_errors: list[str] | None = None,
) -> str:
    lines: list[str] = []
    lines.append("# 金融市场日度信息汇总")
    lines.append("")
    lines.append(
        f"统计窗口：{start.strftime('%Y-%m-%d %H:%M')} ~ {end.strftime('%Y-%m-%d %H:%M')}（北京时间）"
    )
    lines.append("")
    lines.append("## 一、主要指数")
    lines.append("")
    lines.append("| 指数 | 代码 | 窗口起点 | 窗口终点 | 当前价 | 涨跌幅(窗口) |")
    lines.append("|---|---|---:|---:|---:|---:|")
    for item in index_data:
        lines.append(
            "| {name} | {symbol} | {start_price} | {end_price} | {current} | {pct} |".format(
                name=item.name,
                symbol=item.symbol,
                start_price=format_price(item.start_price),
                end_price=format_price(item.end_price),
                current=format_price(item.current_price),
                pct=format_pct(item.change_pct),
            )
        )
    lines.append("")
    lines.append("## 二、主要板块代表股")
    lines.append("")
    for sector, stocks in sector_data.items():
        lines.append(f"### {sector}")
        lines.append("")
        lines.append("| 股票 | 代码 | 窗口起点 | 窗口终点 | 当前价 | 涨跌幅(窗口) |")
        lines.append("|---|---|---:|---:|---:|---:|")
        for item in stocks:
            lines.append(
                "| {name} | {symbol} | {start_price} | {end_price} | {current} | {pct} |".format(
                    name=item.name,
                    symbol=item.symbol,
                    start_price=format_price(item.start_price),
                    end_price=format_price(item.end_price),
                    current=format_price(item.current_price),
                    pct=format_pct(item.change_pct),
                )
            )
        lines.append("")
    errors = [i for i in index_data if i.error]
    for values in sector_data.values():
        errors.extend(i for i in values if i.error)
    if global_errors or errors:
        lines.append("## 三、数据抓取异常")
        lines.append("")
        for err in global_errors or []:
            lines.append(f"- {err}")
        for item in errors:
            lines.append(f"- {item.name} ({item.symbol}): {item.error}")
        lines.append("")
    return "\n".join(lines)


def to_dict(snapshot: Snapshot) -> dict[str, Any]:
    return {
        "name": snapshot.name,
        "symbol": snapshot.symbol,
        "start_price": snapshot.start_price,
        "end_price": snapshot.end_price,
        "current_price": snapshot.current_price,
        "currency": snapshot.currency,
        "change_pct": snapshot.change_pct,
        "error": snapshot.error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="生成金融市场当日汇总")
    parser.add_argument(
        "--output-dir",
        default="output",
        help="输出目录（默认 output）",
    )
    parser.add_argument(
        "--date",
        default=None,
        help="以北京时间的 YYYY-MM-DD 为统计日（窗口终点为该日09:00）",
    )
    args = parser.parse_args()

    if args.date:
        target_date = dt.datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=BEIJING_TZ)
        end = target_date.replace(hour=9, minute=0, second=0, microsecond=0)
        start = end - dt.timedelta(days=1)
    else:
        start, end = beijing_window()

    symbols = [s for _, s in INDEX_SYMBOLS]
    for stocks in SECTOR_STOCKS.values():
        symbols.extend(symbol for _, symbol in stocks)
    global_errors: list[str] = []
    try:
        quote_map = fetch_quotes(symbols)
    except Exception as exc:  # noqa: BLE001
        quote_map = {}
        global_errors.append(f"批量行情获取失败：{exc}")

    index_data = [
        summarize_symbol(name, symbol, start, end, quote_map)
        for name, symbol in INDEX_SYMBOLS
    ]

    sector_data: dict[str, list[Snapshot]] = {}
    for sector, stocks in SECTOR_STOCKS.items():
        sector_data[sector] = [
            summarize_symbol(name, symbol, start, end, quote_map)
            for name, symbol in stocks
        ]

    markdown = render_markdown(start, end, index_data, sector_data, global_errors)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    stamp = end.strftime("%Y%m%d_0900")
    md_path = output_dir / f"financial_summary_{stamp}.md"
    json_path = output_dir / f"financial_summary_{stamp}.json"

    md_path.write_text(markdown, encoding="utf-8")

    payload = {
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "errors": global_errors,
        "indices": [to_dict(item) for item in index_data],
        "sectors": {
            sector: [to_dict(item) for item in values]
            for sector, values in sector_data.items()
        },
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Markdown: {md_path}")
    print(f"JSON: {json_path}")


if __name__ == "__main__":
    main()
