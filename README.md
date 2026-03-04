# 金融市场信息汇总工具

你提到的诉求已改为：**不再按具体个股**，而是按“股市指数 + 行业板块指数”汇总。

统计窗口固定为：**北京时间前一日 09:00 到当日 09:00**。

> 说明：你提到 `akshare`，它底层也大量使用东方财富等数据源。当前环境无法安装第三方包（代理限制），所以这里直接调用东方财富公开接口，达到与 `akshare` 类似的数据抓取目标。

## 使用方式

```bash
python3 financial_summary.py
```

可选参数：

- `--date YYYY-MM-DD`：指定统计日（窗口终点 = 该日 09:00，北京时间）
- `--output-dir output`：输出目录
- `--sector-limit 10`：行业板块抓取数量（按实时涨跌幅排序抓前 N 个）

示例：

```bash
python3 financial_summary.py --date 2026-03-04 --output-dir reports --sector-limit 15
```

## 输出内容

脚本会生成：

- `financial_summary_YYYYMMDD_0900.md`
- `financial_summary_YYYYMMDD_0900.json`

报告包括：

1. 主要股市指数（如上证、深证、创业板、沪深300、中证500、科创50）
2. 行业板块指数（非个股）
3. 抓取异常信息（当外部接口限流或不可达时）

## 依赖

- Python 3.10+
- 无第三方依赖
