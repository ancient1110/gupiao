#!/usr/bin/env python3
"""Generate Beijing 09:00 window market and sector summary (no single-stock granularity)."""

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
EASTMONEY_QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
EASTMONEY_KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
EASTMONEY_BOARD_LIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    )
}

MAJOR_MARKETS = [
    ("上证指数", "1.000001"),
    ("深证成指", "0.399001"),
    ("创业板指", "0.399006"),
    ("沪深300", "1.000300"),
    ("中证500", "1.000905"),
    ("科创50", "1.000688"),
]


@dataclass
class Snapshot:
    name: str
    secid: str
    start_price: float | None
    end_price: float | None
    current_price: float | None
    change_pct: float | None
    error: str | None = None


def beijing_window(reference: dt.datetime | None = None) -> tuple[dt.datetime, dt.datetime]:
    now = (reference or dt.datetime.now(tz=BEIJING_TZ)).astimezone(BEIJING_TZ)
    end = now.replace(hour=9, minute=0, second=0, microsecond=0)
    if now < end:
        end -= dt.timedelta(days=1)
    start = end - dt.timedelta(days=1)
    return start, end


def http_get_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    query = urlencode(params)
    request = Request(f"{url}?{query}", headers=HEADERS)
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def get_daily_close_map(secid: str, start: dt.datetime, end: dt.datetime) -> dict[dt.date, float]:
    beg = (start.date() - dt.timedelta(days=5)).strftime("%Y%m%d")
    finish = (end.date() + dt.timedelta(days=1)).strftime("%Y%m%d")
    payload = http_get_json(
        EASTMONEY_KLINE_URL,
        {
            "secid": secid,
            "klt": "101",
            "fqt": "1",
            "beg": beg,
            "end": finish,
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
        },
    )
    klines = payload.get("data", {}).get("klines", [])
    result: dict[dt.date, float] = {}
    for item in klines:
        parts = item.split(",")
        if len(parts) < 3:
            continue
        day = dt.datetime.strptime(parts[0], "%Y-%m-%d").date()
        close = float(parts[2])
        result[day] = close
    return result


def nearest_not_after(target: dt.date, series: dict[dt.date, float]) -> float | None:
    candidates = [d for d in series if d <= target]
    if not candidates:
        return None
    nearest = max(candidates)
    return series[nearest]


def get_current_price(secid: str) -> float | None:
    payload = http_get_json(
        EASTMONEY_QUOTE_URL,
        {
            "secid": secid,
            "fields": "f43",
        },
    )
    raw = payload.get("data", {}).get("f43")
    if raw is None:
        return None
    return float(raw) / 100


def summarize_security(name: str, secid: str, start: dt.datetime, end: dt.datetime) -> Snapshot:
    try:
        close_map = get_daily_close_map(secid, start, end)
        start_price = nearest_not_after(start.date(), close_map)
        end_price = nearest_not_after(end.date(), close_map)
        current = get_current_price(secid)

        change_pct = None
        if start_price and end_price:
            change_pct = (end_price - start_price) / start_price * 100

        return Snapshot(name, secid, start_price, end_price, current, change_pct)
    except Exception as exc:  # noqa: BLE001
        return Snapshot(name, secid, None, None, None, None, str(exc))


def fetch_industry_boards(limit: int) -> list[tuple[str, str]]:
    payload = http_get_json(
        EASTMONEY_BOARD_LIST_URL,
        {
            "pn": "1",
            "pz": str(limit),
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fs": "m:90+t:2+f:!50",  # 行业板块
            "fields": "f12,f14",
        },
    )
    diff = payload.get("data", {}).get("diff", [])
    return [(item.get("f14", "未知板块"), f"90.{item.get('f12')}") for item in diff if item.get("f12")]


def format_pct(value: float | None) -> str:
    return "N/A" if value is None else f"{value:+.2f}%"


def format_price(value: float | None) -> str:
    return "N/A" if value is None else f"{value:,.2f}"


def render_markdown(
    start: dt.datetime,
    end: dt.datetime,
    market_data: list[Snapshot],
    sector_data: list[Snapshot],
    global_errors: list[str],
) -> str:
    lines = [
        "# 金融市场窗口汇总（股市/板块）",
        "",
        f"统计窗口：{start.strftime('%Y-%m-%d %H:%M')} ~ {end.strftime('%Y-%m-%d %H:%M')}（北京时间）",
        "",
        "## 一、主要股市指数",
        "",
        "| 市场指数 | secid | 窗口起点收盘 | 窗口终点收盘 | 当前价 | 窗口涨跌幅 |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for item in market_data:
        lines.append(
            f"| {item.name} | {item.secid} | {format_price(item.start_price)} | {format_price(item.end_price)} | {format_price(item.current_price)} | {format_pct(item.change_pct)} |"
        )

    lines.extend([
        "",
        "## 二、行业板块（按实时涨跌幅抓取前N个）",
        "",
        "| 行业板块 | secid | 窗口起点收盘 | 窗口终点收盘 | 当前价 | 窗口涨跌幅 |",
        "|---|---|---:|---:|---:|---:|",
    ])
    for item in sector_data:
        lines.append(
            f"| {item.name} | {item.secid} | {format_price(item.start_price)} | {format_price(item.end_price)} | {format_price(item.current_price)} | {format_pct(item.change_pct)} |"
        )

    errors = [s for s in market_data + sector_data if s.error]
    if global_errors or errors:
        lines.extend(["", "## 三、数据抓取异常", ""])
        for err in global_errors:
            lines.append(f"- {err}")
        for item in errors:
            lines.append(f"- {item.name} ({item.secid}): {item.error}")

    return "\n".join(lines)


def to_dict(snapshot: Snapshot) -> dict[str, Any]:
    return {
        "name": snapshot.name,
        "secid": snapshot.secid,
        "start_price": snapshot.start_price,
        "end_price": snapshot.end_price,
        "current_price": snapshot.current_price,
        "change_pct": snapshot.change_pct,
        "error": snapshot.error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="生成北京时间09:00窗口的股市/板块汇总")
    parser.add_argument("--output-dir", default="output", help="输出目录（默认 output）")
    parser.add_argument("--date", default=None, help="北京时间 YYYY-MM-DD（窗口终点=当日09:00）")
    parser.add_argument("--sector-limit", type=int, default=10, help="行业板块数量，默认10")
    args = parser.parse_args()

    if args.date:
        target = dt.datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=BEIJING_TZ)
        end = target.replace(hour=9, minute=0, second=0, microsecond=0)
        start = end - dt.timedelta(days=1)
    else:
        start, end = beijing_window()

    global_errors: list[str] = []

    market_data = [summarize_security(name, secid, start, end) for name, secid in MAJOR_MARKETS]

    sectors: list[tuple[str, str]] = []
    try:
        sectors = fetch_industry_boards(args.sector_limit)
    except Exception as exc:  # noqa: BLE001
        global_errors.append(f"行业板块列表抓取失败：{exc}")

    sector_data = [summarize_security(name, secid, start, end) for name, secid in sectors]

    markdown = render_markdown(start, end, market_data, sector_data, global_errors)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = end.strftime("%Y%m%d_0900")
    md_path = output_dir / f"financial_summary_{stamp}.md"
    json_path = output_dir / f"financial_summary_{stamp}.json"

    md_path.write_text(markdown, encoding="utf-8")
    json_path.write_text(
        json.dumps(
            {
                "window_start": start.isoformat(),
                "window_end": end.isoformat(),
                "errors": global_errors,
                "markets": [to_dict(i) for i in market_data],
                "sectors": [to_dict(i) for i in sector_data],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"Markdown: {md_path}")
    print(f"JSON: {json_path}")


if __name__ == "__main__":
    main()
