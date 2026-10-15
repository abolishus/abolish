---
"@abolishus/crypto": minor
---

`splitSegmentObject` splits a segment object fetched by its CID into its encoded entries by their framing alone (`docs/spec/board.md`, Segment objects), for `verifyBoard` to authenticate. It throws `DecodeError` on an empty object, a payload length over `MAX_BOARD_PAYLOAD` or a truncated entry.
