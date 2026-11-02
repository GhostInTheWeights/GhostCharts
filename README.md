# 👻 Ghost Charts

A free, TradingView-style chart for **manual backtesting** on your own computer.
Pick a date, replay the market candle by candle, draw your levels, and place simulated trades with stop loss and take profit.
Candle data comes from your own **MetaTrader 5** terminal (a free demo account works).

![Ghost Charts](docs/screenshot.jpg)

## Features

- TradingView-like candlestick chart: zoom, scroll, crosshair, volume, M1 / M5 / M15 / M30 / H1 / H4 / D1
- Drawing tools: trend line, horizontal line, rectangle, with an OHLC magnet. Drawings stay put when you change timeframe
- **Bar replay**: start from any date or click a candle, then step (→) or play (Space) at up to 25 candles/s.
  Step size can be smaller than the chart timeframe, so you can watch an H1 candle form in M5 steps
- Orders: market, limit, stop; size in lots or % risk; SL/TP by price, by clicking the chart, or by R:R.
  Drag SL/TP/order lines on the chart to modify them
- Realistic fills: simulated on M5 (or M1) candles using the broker's spread; if SL and TP are inside the same candle, SL is assumed first
- Positions, orders, trade history and stats (win rate, profit factor, average R, max drawdown, equity curve), CSV export
- Everything is saved in your browser, so you can close it and continue the session later

## Requirements

- Windows (the MetaTrader 5 Python package only runs on Windows)
- [Python 3.9+](https://www.python.org/downloads/) — tick *"Add Python to PATH"* when installing
- [MetaTrader 5](https://www.metatrader5.com/) logged in to any broker account (demo is fine)
- An internet connection (the chart library loads from a CDN)

## Setup

```
git clone https://github.com/GhostInTheWeights/GhostCharts.git
cd GhostCharts
pip install -r requirements.txt
```

## Run

1. Open MetaTrader 5 and log in.
2. Double-click **`start.bat`** (or run `python server.py` and open http://localhost:8765).
3. First time only: click **Download data**. Downloading the full history can take a few minutes.

Keep the black "Ghost Charts server" window open while you use the app; close it to stop.

## Keeping data up to date

Click **Update data** at the top right. Only new candles are fetched, so it takes seconds.
"Data to …" next to the button shows your newest candle.

## Choosing symbols

Edit `symbols.json`:

```json
{ "name": "XAUUSD", "start": "2023-01-01", "m1": true }
```

- `name` — the symbol. Broker suffixes (e.g. `XAUUSDm`, `EURUSD.raw`) are found automatically; set `"mt5_name"` if not.
- `start` — first date to download. How far back you get depends on your broker's history.
- `m1` — also download 1-minute candles (large; enables the M1 timeframe and more precise fills).

Then click **Update data**. Contract size and price decimals come from MetaTrader automatically.

## Keyboard shortcuts

| Key | Action |
|---|---|
| → | Step forward one candle (replay) |
| Space | Play / pause (replay) |
| Alt+T / Alt+H / Alt+R | Trend line / horizontal line / rectangle |
| Del | Delete selected drawing |
| Esc | Cancel / back to cursor |

## How it works

| File | Purpose |
|---|---|
| `index.html`, `style.css` | Page layout and styling |
| `app.js` | Chart, drawings, replay, order simulation, stats |
| `server.py` | Tiny local web server (127.0.0.1 only); runs the updater when you click *Update data* |
| `update_data.py` | Downloads candles from MetaTrader 5 into `data/` (M5, optional M1; other timeframes are built from M5) |
| `symbols.json` | Which symbols to download |

The data files are plain binary arrays (time + OHLC + volume + spread per candle) that the browser loads directly.

## Disclaimer

This is a practice and research tool, not financial advice. Simulated results ignore commissions, slippage and
liquidity, and past performance does not predict future results.

## Credits

Charts by [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0).
Released under the [MIT License](LICENSE).
