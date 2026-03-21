# HolyPoly

Polymarket trading bot for BTC/ETH 5-minute Up/Down binary markets.

## Current Strategy: Webhook Mode (`STRATEGY_MODE=webhook`)

**NOT using the old arb/edge-detection strategy anymore.**

The active strategy is signal-based directional trading:
1. TradingView webhook sends UP/DOWN signal for BTC or ETH
2. Bot targets the CURRENT 5-min window if >60s remaining, otherwise NEXT
3. Places GTC limit ladder at 49-51¢ (maker = 0% fee)
4. Monitors fills for ~4 minutes
5. FOK fallback at 52¢ for unfilled remainder at T+4:00
6. Holds naked position until settlement — no hedge/arb completion

This is similar to trader "beboule" on Polymarket who also buys at 50-51¢ based on directional signals.

### Key Parameters
- Ladder: 49¢ (25%), 50¢ (40%), 51¢ (35%)
- Fallback: 52¢ FOK after 4 min
- Size: 4% of balance per signal
- Maker fee: 0%, Taker fee: 2%
- Entry at ~50¢ → Win = +48-50¢/share, Loss = -50-52¢/share

### Architecture
- `src/webhook.ts` — Express server receiving TradingView alerts
- `src/execution/signal-executor.ts` — GTC ladder + FOK fallback logic
- `src/data/clob-ws.ts` — CLOB WebSocket (orderbook data, connects only when tokens subscribed)
- `src/config.ts` — All configuration parameters

### WebSocket Notes
- Polymarket CLOB WS requires subscription message immediately after connect, otherwise server disconnects after ~10s
- CLOB WS only connects when `subscribe()` is called with tokens (not on `start()`)
- Market/User channels: client sends `PING` every 5s, server responds `PONG`
- Sports channels: server sends `ping`, client must respond `pong` within 10s
