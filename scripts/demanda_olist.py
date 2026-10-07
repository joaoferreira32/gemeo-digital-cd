"""Builds public/demanda-olist.json, the demand profile of the simulation
(phase 5), from the orders of the Olist dataset (Kaggle), which never enters
the repository:

    ai/.venv/Scripts/python scripts/demanda_olist.py C:/dados/olist_orders_dataset.csv

Only `order_purchase_timestamp` is read. The profile is the average number of
orders in each of the 168 hours of the week (Monday 00h ... Sunday 23h),
scaled so the week averages 1: a multiplier of the base order rate.

Period: January 2017 to August 2018, checked against the monthly volume (the
months before are the start of the platform, with gaps: 4, 324, 0 and 1
orders from September to December 2016; the months after are the end of the
dataset: 16 and 4). 2017 grew and 2018 is flat, but the shape of the week is
the same in both (r = 0.977), so the whole period is used. The Black Friday
week of 2017 (20 to 26 November) is left out: one atypical day (1,176 orders
against 162 on a typical Friday) would raise the weight of every Friday by
5.8%.

The derived file is CC BY-NC-SA 4.0, like the dataset (see
public/demanda-olist.LICENSE.txt); the code is MIT.
"""
import csv
import datetime as dt
import json
import pathlib
import sys

START = dt.datetime(2017, 1, 1)
END = dt.datetime(2018, 9, 1)  # exclusive
EXCLUDED = (dt.datetime(2017, 11, 20), dt.datetime(2017, 11, 27))  # Black Friday week
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "demanda-olist.json"


def main(path: str) -> None:
    counts = [0] * 168
    orders = 0
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            t = dt.datetime.strptime(row["order_purchase_timestamp"], "%Y-%m-%d %H:%M:%S")
            if not START <= t < END or EXCLUDED[0] <= t < EXCLUDED[1]:
                continue
            counts[t.weekday() * 24 + t.hour] += 1
            orders += 1
    # How many times each weekday occurs in the period: an average per hour, not a sum.
    days = [0] * 7
    d = START
    while d < END:
        if not EXCLUDED[0] <= d < EXCLUDED[1]:
            days[d.weekday()] += 1
        d += dt.timedelta(days=1)
    rates = [counts[h] / days[h // 24] for h in range(168)]
    mean = sum(rates) / 168
    weights = [round(r / mean, 4) for r in rates]
    profile = {
        "source": "Brazilian E-Commerce Public Dataset by Olist, olist_orders_dataset.csv (order_purchase_timestamp)",
        "url": "https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce",
        "license": "CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/)",
        "attribution": "Olist",
        "changes": "Orders counted per hour of the week, averaged over the weeks of the period and scaled to a mean of 1.",
        "period": {"from": START.date().isoformat(), "to": (END - dt.timedelta(days=1)).date().isoformat()},
        "excluded": "Black Friday week, 2017-11-20 to 2017-11-26",
        "orders": orders,
        "hours": "168 weights: Monday 00h, Monday 01h, ..., Sunday 23h (local time of the purchases)",
        "weights": weights,
    }
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"{OUT}: {orders} pedidos, pesos de {min(weights)} a {max(weights)}, média {sum(weights) / 168:.4f}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("uso: python scripts/demanda_olist.py caminho/para/olist_orders_dataset.csv")
    main(sys.argv[1])
