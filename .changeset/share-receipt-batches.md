---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
"@abolishus/sdk": minor
---

Share-receipt batches (record type `0x0016`, docs/spec/delivery.md, Share-receipt batch): `encodeShareReceiptBatch`, `decodeShareReceiptBatch`, `shareReceiptBatchStatement`, `batchShareReceipts` and `RECEIPT_BATCH_MAX`; `checkDelivery` reads each pair of a contract-path batch as the receipt it states. Contract-event version 4 adds the board's `ShareReceiptBatchSubmitted`, and `profileCombinationRule` now requires every profile to pin it: a profile pinning contract-event version 3 is `profile-combination`. `FORCED_PATH` is re-pinned for batch calls (1,024 receipts at 4,500,000 gas). The verifier reads version 4 and reports each batch pair with `pair`; the sdk's simulated board takes batches. Share-complaint batches (record type `0x0017`): `encodeShareComplaintBatch`, `decodeShareComplaintBatch`, `shareComplaintBatchStatement`, `batchShareComplaints`, `frameComplaintBatch` and `COMPLAINT_BATCH_MAX`, with contract-event version 4's `ShareComplaintBatchSubmitted`; `FORCED_PATH` gains `complaintsPerCall` (512) and `complaintCallGas` is 5,000,000.
