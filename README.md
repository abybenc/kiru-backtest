# Kiru Backtest (Android)

Personal app to backtest and paper trade two of Kiru Rajendran's ETF systems on real NSE data.

- **Nifty/Gold switch**: ratio Niftybees/Goldbees; break above prior 20-day high = 100% Niftybees, below 20-day low = 100% Goldbees.
- **Smooth momentum rotation**: monthly, top 3 ETFs by volatility-adjusted 6m/12m momentum, above 200-day SMA.

Data: Upstox v3 historical candles (free data endpoint, no login). Orders are placed manually in Kite/Upstox (SEBI static IP rule for API orders).

Every push to `main` builds a signed APK (same key every time, so it installs as an update) and attaches it to a GitHub Release.

Not investment advice.
