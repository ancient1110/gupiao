# 金融市场信息汇总工具

该脚本会自动抓取**北京时间前一日 09:00 到当日 09:00**区间内的主要金融指数与主要板块代表股数据，并生成：

- Markdown 报告（便于阅读/转发）
- JSON 数据文件（便于二次处理）

## 环境准备

```bash
python3 -m venv .venv
source .venv/bin/activate
```

## 使用方式

默认按“最近一个北京时间 09:00 截止窗口”生成：

```bash
python3 financial_summary.py
```

指定统计日（窗口终点 = 该日 09:00，北京时间）：

```bash
python3 financial_summary.py --date 2026-03-04
```

指定输出目录：

```bash
python3 financial_summary.py --output-dir reports
```

## 输出示例

运行后会在输出目录生成：

- `financial_summary_YYYYMMDD_0900.md`
- `financial_summary_YYYYMMDD_0900.json`

报告内容包括：

1. 主要指数（美股、欧股、亚太与A股核心指数）
2. 主要板块代表股（科技、金融、能源、消费、医药）
3. 数据异常信息（若个别代码抓取失败）

## 数据来源说明

- 使用 Yahoo Finance 公共接口抓取行情（通过 Python 标准库请求，无需额外第三方依赖）。
- 个别市场在目标时间窗口若无成交，脚本会使用最接近时间点的可用收盘价进行对比。
