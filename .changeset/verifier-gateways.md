---
"@abolishus/verifier": minor
---

Reads a board copy by CID from IPFS trustless gateways as well as from `blocks.car`: `gatewaySource`, `parseGateway`, `MAX_GATEWAYS` and `DEFAULT_GATEWAY_TIMEOUT_MS`, an optional `gateways` argument to `readBoardByCid` and `loadBundle`, and `--gateway <url>` on the command line. `readBoardByCid` now takes `undefined` for the store where gateways are given, and `CidRead`'s `storeBlocks` and `storeUnreadableBytes` are present only where `blocks.car` was read, beside a new `gateways` count: code that read those two fields unconditionally must allow for their absence.
