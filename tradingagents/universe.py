"""Curated ticker universe for batch analysis.

Symbols use Yahoo Finance conventions (futures use `=F`, FX uses `=X`,
crypto uses `-USD`). Index ETFs are preferred over `^`-prefixed indexes
in the default selection because the data layer handles ETFs more
reliably across providers.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

# Each entry: (symbol, display_name)
TickerEntry = Tuple[str, str]

UNIVERSE: Dict[str, List[TickerEntry]] = {
    "Indexes": [
        ("^GSPC", "S&P 500"),
        ("^DJI", "Dow Jones"),
        ("^IXIC", "Nasdaq Composite"),
        ("^RUT", "Russell 2000"),
        ("^VIX", "VIX"),
    ],
    "Index ETFs": [
        ("SPY", "S&P 500 ETF"),
        ("QQQ", "Nasdaq-100 ETF"),
        ("DIA", "Dow ETF"),
        ("IWM", "Russell 2000 ETF"),
    ],
    "Mega-cap Stocks": [
        ("AAPL", "Apple"),
        ("MSFT", "Microsoft"),
        ("NVDA", "Nvidia"),
        ("GOOGL", "Alphabet"),
        ("AMZN", "Amazon"),
        ("META", "Meta"),
        ("TSLA", "Tesla"),
        ("BRK-B", "Berkshire Hathaway"),
        ("JPM", "JPMorgan"),
        ("V", "Visa"),
        ("UNH", "UnitedHealth"),
        ("XOM", "ExxonMobil"),
        ("WMT", "Walmart"),
        ("LLY", "Eli Lilly"),
        ("AVGO", "Broadcom"),
    ],
    "Mid/Small-cap (high volume)": [
        ("AMD", "AMD"),
        ("PLTR", "Palantir"),
        ("COIN", "Coinbase"),
        ("HOOD", "Robinhood"),
        ("SOFI", "SoFi"),
        ("AFRM", "Affirm"),
        ("RBLX", "Roblox"),
        ("DKNG", "DraftKings"),
        ("RIVN", "Rivian"),
        ("LCID", "Lucid"),
        ("U", "Unity"),
        ("MARA", "Marathon Digital"),
        ("RIOT", "Riot Platforms"),
    ],
    "Energy": [
        ("CL=F", "WTI Crude Oil"),
        ("BZ=F", "Brent Crude"),
        ("NG=F", "Natural Gas"),
    ],
    "Metals": [
        ("GC=F", "Gold"),
        ("SI=F", "Silver"),
        ("PL=F", "Platinum"),
        ("HG=F", "Copper"),
    ],
    "Agriculture": [
        ("ZC=F", "Corn"),
        ("ZW=F", "Wheat"),
        ("ZS=F", "Soybeans"),
    ],
    "Crypto": [
        ("BTC-USD", "Bitcoin"),
        ("ETH-USD", "Ethereum"),
    ],
    "FX": [
        ("EURUSD=X", "EUR/USD"),
        ("GBPUSD=X", "GBP/USD"),
        ("USDJPY=X", "USD/JPY"),
        ("DX=F", "US Dollar Index"),
    ],
}


def all_symbols() -> List[str]:
    """Flat list of every symbol in the universe."""
    return [sym for entries in UNIVERSE.values() for sym, _ in entries]


def universe_for_api() -> List[Dict[str, object]]:
    """Shape the universe for JSON serialization in /api/config."""
    return [
        {
            "category": cat,
            "tickers": [{"symbol": s, "name": n} for s, n in entries],
        }
        for cat, entries in UNIVERSE.items()
    ]
