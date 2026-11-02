"""Download candles from MetaTrader 5 into data/ for the app.

The first run downloads full history from each symbol's start date (can take a few minutes for M1);
later runs only fetch the last few days plus anything newer.
Symbols are listed in symbols.json. MetaTrader 5 must be open and logged in.

Run:  python update_data.py      (or click "Update data" in the app)

Each data file is a flat little-endian array of records:
    int32 time (unix seconds, UTC), float32 open, high, low, close, volume, spread
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

try:
    import MetaTrader5 as mt5
except ImportError:
    raise SystemExit("The MetaTrader5 Python package is missing. Run:  pip install -r requirements.txt")

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
UTC = timezone.utc
# Re-fetch the last few days each run: replaces the still-forming last candle and any bars
# MT5 had not synced yet on the previous run.
OVERLAP = 3 * 86400

TF_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}
RESAMPLE_RULE = {"M15": "15min", "M30": "30min", "H1": "1h", "H4": "4h", "D1": "1D"}
DTYPE = [("time", "<i4"), ("open", "<f4"), ("high", "<f4"), ("low", "<f4"),
         ("close", "<f4"), ("volume", "<f4"), ("spread", "<f4")]
COLS = [c for c, _ in DTYPE]


def read_bin(path):
    if not os.path.exists(path):
        return pd.DataFrame({c: pd.Series(dtype="float64") for c in COLS})
    df = pd.DataFrame(np.fromfile(path, dtype=DTYPE)).astype({c: "float64" for c in COLS[1:]})
    df["time"] = df["time"].astype("int64")
    return df


def write_bin(df, path):
    rec = np.zeros(len(df), dtype=DTYPE)
    for c in COLS:
        rec[c] = df[c].fillna(0).to_numpy()
    tmp = path + ".tmp"
    rec.tofile(tmp)
    os.replace(tmp, path)  # never leave a half-written file behind


def fetch(symbol, tf, start, end, step_days):
    chunks, t = [], start
    while t < end:
        r = mt5.copy_rates_range(symbol, tf, datetime.fromtimestamp(t, UTC),
                                 datetime.fromtimestamp(min(t + step_days * 86400, end), UTC))
        if r is not None and len(r):
            chunks.append(pd.DataFrame(r))
        t += step_days * 86400
    return pd.concat(chunks) if chunks else None


def update_tf(name, broker_sym, tf_name, start, point):
    tf_const, step = {"M1": (mt5.TIMEFRAME_M1, 7), "M5": (mt5.TIMEFRAME_M5, 30)}[tf_name]
    path = os.path.join(DATA, f"{name}_{tf_name}.bin")
    old = read_bin(path)
    since = int(old["time"].iloc[-1]) - OVERLAP if len(old) else start
    first_run = not len(old)
    if first_run:
        print(f"{name} {tf_name}: downloading history since {datetime.fromtimestamp(start, UTC):%Y-%m-%d} ...", flush=True)
    raw = fetch(broker_sym, tf_const, since, int(datetime.now(UTC).timestamp()) + 86400, step)
    if raw is None:
        print(f"{name} {tf_name}: MT5 returned no bars")
        return old
    raw = raw.drop_duplicates("time").sort_values("time")
    new = pd.DataFrame({"time": raw["time"].astype("int64"), "open": raw["open"], "high": raw["high"],
                        "low": raw["low"], "close": raw["close"], "volume": raw["tick_volume"].astype("float64"),
                        "spread": raw["spread"] * point})
    merged = (pd.concat([old[old["time"] < new["time"].iloc[0]], new])
              .drop_duplicates("time", keep="last").sort_values("time").reset_index(drop=True))
    write_bin(merged, path)
    print(f"{name} {tf_name}: +{len(merged) - len(old)} bars, now up to "
          f"{datetime.fromtimestamp(int(merged['time'].iloc[-1]), UTC):%Y-%m-%d %H:%M} UTC")
    return merged


def resample(m5, rule):
    idx = pd.to_datetime(m5["time"], unit="s", utc=True)
    r = m5.set_index(idx).resample(rule, label="left", closed="left")
    out = pd.DataFrame({"open": r["open"].first(), "high": r["high"].max(), "low": r["low"].min(),
                        "close": r["close"].last(), "volume": r["volume"].sum(),
                        "spread": r["spread"].mean()}).dropna(subset=["open"])
    out["time"] = (out.index - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta("1s")
    return out.reset_index(drop=True)[COLS]


def find_broker_symbol(name, override):
    """Brokers often add suffixes (XAUUSDm, EURUSD.raw); find the one this terminal offers."""
    for cand in [override, name] if override else [name]:
        if mt5.symbol_select(cand, True):
            return cand
    for s in mt5.symbols_get(f"{name}*") or []:
        if mt5.symbol_select(s.name, True):
            return s.name
    return None


def file_info(name, tf, df):
    return {"file": f"{name}_{tf}.bin", "rows": len(df), "from": int(df["time"].iloc[0]),
            "to": int(df["time"].iloc[-1]), "sec": TF_SECONDS[tf]}


def main():
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(HERE, "symbols.json")) as f:
        config = json.load(f)["symbols"]
    mpath = os.path.join(DATA, "manifest.json")
    manifest = {"symbols": {}}
    if os.path.exists(mpath):
        with open(mpath) as f:
            manifest = json.load(f)

    if not mt5.initialize():
        raise SystemExit(f"Could not connect to MetaTrader 5. Is it open and logged in? ({mt5.last_error()})")
    try:
        for sc in config:
            name = sc["name"]
            broker_sym = find_broker_symbol(name, sc.get("mt5_name"))
            if not broker_sym:
                print(f"{name}: not offered by this broker/terminal, skipped")
                continue
            info = mt5.symbol_info(broker_sym)
            start = int(datetime.strptime(sc.get("start", "2023-01-01"), "%Y-%m-%d").replace(tzinfo=UTC).timestamp())
            frames = {"M5": update_tf(name, broker_sym, "M5", start, info.point)}
            if not len(frames["M5"]):
                continue
            if sc.get("m1"):
                frames["M1"] = update_tf(name, broker_sym, "M1", start, info.point)
                if not len(frames["M1"]):
                    del frames["M1"]
            for tf, rule in RESAMPLE_RULE.items():
                frames[tf] = resample(frames["M5"], rule)
                write_bin(frames[tf], os.path.join(DATA, f"{name}_{tf}.bin"))
            manifest["symbols"][name] = {
                "contract": info.trade_contract_size, "decimals": info.digits,
                "tfs": {tf: file_info(name, tf, df) for tf, df in frames.items()}}
    finally:
        mt5.shutdown()

    with open(mpath, "w") as f:
        json.dump(manifest, f, indent=1)
    if not manifest["symbols"]:
        raise SystemExit("No data was downloaded. Check the symbol names in symbols.json.")
    print("Done.")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
