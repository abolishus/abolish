//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// BallotRelay
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ballotRelayAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "portal_", internalType: "address", type: "address" },
      { name: "board_", internalType: "address", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "MAX_RELAY_RECORD",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "board",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "callCount",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "index", internalType: "uint64", type: "uint64" }],
    name: "callHash",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "eventAccumulator",
    outputs: [
      { name: "accumulator", internalType: "bytes32", type: "bytes32" },
      { name: "count", internalType: "uint64", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "portal",
    outputs: [{ name: "", internalType: "contract IOptimismPortal", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "gasLimit", internalType: "uint64", type: "uint64" },
      { name: "record", internalType: "bytes", type: "bytes" },
    ],
    name: "relayBallot",
    outputs: [{ name: "index", internalType: "uint64", type: "uint64" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "index", internalType: "uint64", type: "uint64", indexed: true },
      {
        name: "callHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
    ],
    name: "BallotRelayed",
  },
  {
    type: "error",
    inputs: [{ name: "blockNumber", internalType: "uint256", type: "uint256" }],
    name: "BlockNumberTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "chainId", internalType: "uint256", type: "uint256" }],
    name: "ChainIdTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "DataTooLong",
  },
  { type: "error", inputs: [], name: "InvalidDeployment" },
  { type: "error", inputs: [], name: "NonCanonicalCalldata" },
  {
    type: "error",
    inputs: [{ name: "recordType", internalType: "uint16", type: "uint16" }],
    name: "RelayRecordType",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "RelayTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "RelayTruncated",
  },
  {
    type: "error",
    inputs: [{ name: "timestamp", internalType: "uint256", type: "uint256" }],
    name: "TimestampTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "count", internalType: "uint256", type: "uint256" }],
    name: "TopicCount",
  },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Board
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const boardAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "elections", internalType: "address", type: "address" },
      { name: "trustees", internalType: "address", type: "address" },
      { name: "relay_", internalType: "address", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "electionRegistry",
    outputs: [{ name: "", internalType: "contract IBoardElections", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "eventAccumulator",
    outputs: [
      { name: "accumulator", internalType: "bytes32", type: "bytes32" },
      { name: "count", internalType: "uint64", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "relay",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "submitAvailabilityRecord",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "submitBallot",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "submitCloseStatement",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "submitComplaint",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "submitComplaintBatch",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "submitObligationRoot",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "posting", internalType: "bytes", type: "bytes" },
      { name: "ballot", internalType: "bytes", type: "bytes" },
    ],
    name: "submitPosting",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "submitReceiptBatch",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "receipts", internalType: "bytes", type: "bytes" }],
    name: "submitReceipts",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "index", internalType: "uint64", type: "uint64" },
      { name: "l1Block", internalType: "uint64", type: "uint64" },
      { name: "stamp", internalType: "uint64", type: "uint64" },
      { name: "gasLimit", internalType: "uint64", type: "uint64" },
      { name: "record", internalType: "bytes", type: "bytes" },
    ],
    name: "submitRelayedBallot",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "trusteeRegistry",
    outputs: [{ name: "", internalType: "contract IBoardTrustees", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "seat", internalType: "uint8", type: "uint8", indexed: true },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "AvailabilityAttestationSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "seat", internalType: "uint8", type: "uint8", indexed: true },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "AvailabilityComplaintSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "ballotHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "BallotSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "signer", internalType: "uint8", type: "uint8", indexed: true },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "CloseStatementSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "seat", internalType: "uint8", type: "uint8", indexed: true },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "ObligationRootSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "ballotHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "index", internalType: "uint64", type: "uint64", indexed: false },
      {
        name: "l1Block",
        internalType: "uint64",
        type: "uint64",
        indexed: false,
      },
      { name: "stamp", internalType: "uint64", type: "uint64", indexed: false },
      {
        name: "gasLimit",
        internalType: "uint64",
        type: "uint64",
        indexed: false,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "RelayedBallotSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "seat", internalType: "uint8", type: "uint8", indexed: true },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "ShareComplaintBatchSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "ballotHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "ShareComplaintSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "ballotHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "SharePosted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "seat", internalType: "uint8", type: "uint8", indexed: true },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "ShareReceiptBatchSubmitted",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "ballotHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "ShareReceiptSubmitted",
  },
  {
    type: "error",
    inputs: [
      {
        name: "code",
        internalType: "enum ElectionDefinitionLib.DecodeError",
        type: "uint8",
      },
      { name: "offset", internalType: "uint256", type: "uint256" },
    ],
    name: "AvailabilityMalformed",
  },
  {
    type: "error",
    inputs: [
      {
        name: "code",
        internalType: "enum AvailabilityCheckLib.Code",
        type: "uint8",
      },
    ],
    name: "AvailabilityRefused",
  },
  {
    type: "error",
    inputs: [
      {
        name: "code",
        internalType: "enum ElectionDefinitionLib.DecodeError",
        type: "uint8",
      },
      { name: "offset", internalType: "uint256", type: "uint256" },
    ],
    name: "BallotMalformed",
  },
  {
    type: "error",
    inputs: [{ name: "code", internalType: "enum BallotCheckLib.Code", type: "uint8" }],
    name: "BallotRefused",
  },
  {
    type: "error",
    inputs: [
      { name: "timestamp", internalType: "uint256", type: "uint256" },
      { name: "opensAt", internalType: "uint64", type: "uint64" },
      { name: "closesAt", internalType: "uint64", type: "uint64" },
    ],
    name: "BallotWindow",
  },
  {
    type: "error",
    inputs: [{ name: "blockNumber", internalType: "uint256", type: "uint256" }],
    name: "BlockNumberTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "chainId", internalType: "uint256", type: "uint256" }],
    name: "ChainIdTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "DataTooLong",
  },
  {
    type: "error",
    inputs: [
      { name: "record", internalType: "uint256", type: "uint256" },
      {
        name: "code",
        internalType: "enum ElectionDefinitionLib.DecodeError",
        type: "uint8",
      },
      { name: "offset", internalType: "uint256", type: "uint256" },
    ],
    name: "DeliveryMalformed",
  },
  {
    type: "error",
    inputs: [
      { name: "record", internalType: "uint256", type: "uint256" },
      {
        name: "code",
        internalType: "enum DeliveryCheckLib.Code",
        type: "uint8",
      },
    ],
    name: "DeliveryRefused",
  },
  { type: "error", inputs: [], name: "InsufficientGas" },
  { type: "error", inputs: [], name: "InvalidDeployment" },
  { type: "error", inputs: [], name: "NonCanonicalCalldata" },
  {
    type: "error",
    inputs: [{ name: "root", internalType: "uint256", type: "uint256" }],
    name: "NonCanonicalRoot",
  },
  { type: "error", inputs: [], name: "PrecompileFailed" },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "ReceiptBatchLength",
  },
  {
    type: "error",
    inputs: [{ name: "caller", internalType: "address", type: "address" }],
    name: "RelaySender",
  },
  {
    type: "error",
    inputs: [
      { name: "stamp", internalType: "uint64", type: "uint64" },
      { name: "opensAt", internalType: "uint64", type: "uint64" },
      { name: "closesAt", internalType: "uint64", type: "uint64" },
    ],
    name: "RelayWindow",
  },
  {
    type: "error",
    inputs: [
      {
        name: "code",
        internalType: "enum ElectionDefinitionLib.DecodeError",
        type: "uint8",
      },
      { name: "offset", internalType: "uint256", type: "uint256" },
    ],
    name: "StatementMalformed",
  },
  {
    type: "error",
    inputs: [
      {
        name: "code",
        internalType: "enum CloseStatementLib.Code",
        type: "uint8",
      },
    ],
    name: "StatementRefused",
  },
  {
    type: "error",
    inputs: [{ name: "timestamp", internalType: "uint256", type: "uint256" }],
    name: "TimestampTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "count", internalType: "uint256", type: "uint256" }],
    name: "TopicCount",
  },
  {
    type: "error",
    inputs: [{ name: "tier", internalType: "uint8", type: "uint8" }],
    name: "UnknownTier",
  },
  { type: "error", inputs: [], name: "ZeroRoot" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// BoardAnchor
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const boardAnchorAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "clock",
        internalType: "struct BoardAnchor.Clock",
        type: "tuple",
        components: [
          { name: "epoch", internalType: "uint64", type: "uint64" },
          { name: "period", internalType: "uint64", type: "uint64" },
          { name: "deadline", internalType: "uint64", type: "uint64" },
        ],
      },
      { name: "authority_", internalType: "address", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "MAX_LOCATOR_LENGTH",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "checkpoints", internalType: "bytes", type: "bytes" },
      { name: "locator", internalType: "bytes", type: "bytes" },
    ],
    name: "anchor",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "authority",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "electionId", internalType: "bytes32", type: "bytes32" },
      { name: "segment", internalType: "uint32", type: "uint32" },
    ],
    name: "checkpointHashOf",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "deadline",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "epoch",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "eventAccumulator",
    outputs: [
      { name: "accumulator", internalType: "bytes32", type: "bytes32" },
      { name: "count", internalType: "uint64", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "latestLocator",
    outputs: [
      { name: "locator", internalType: "bytes", type: "bytes" },
      { name: "count", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "electionId", internalType: "bytes32", type: "bytes32" }],
    name: "lowestSegmentPlusOne",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "period",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "segment", internalType: "uint32", type: "uint32" }],
    name: "periodEnd",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "prefix", internalType: "uint8", type: "uint8" },
      { name: "x", internalType: "bytes32", type: "bytes32" },
    ],
    name: "receiptKeyRecord",
    outputs: [
      { name: "registeredAt", internalType: "uint64", type: "uint64" },
      { name: "retiredAt", internalType: "uint64", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "key", internalType: "bytes", type: "bytes" }],
    name: "registerReceiptKey",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "key", internalType: "bytes", type: "bytes" }],
    name: "retireReceiptKey",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "version",
        internalType: "uint16",
        type: "uint16",
        indexed: true,
      },
      { name: "locator", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "ArchiveLocated",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "electionId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "segment",
        internalType: "uint32",
        type: "uint32",
        indexed: true,
      },
      {
        name: "checkpointHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "size", internalType: "uint64", type: "uint64", indexed: false },
      {
        name: "head",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
      {
        name: "root",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
      {
        name: "objectCid",
        internalType: "bytes",
        type: "bytes",
        indexed: false,
      },
      {
        name: "hashesCid",
        internalType: "bytes",
        type: "bytes",
        indexed: false,
      },
    ],
    name: "CheckpointAnchored",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      { name: "x", internalType: "bytes32", type: "bytes32", indexed: true },
      { name: "prefix", internalType: "uint8", type: "uint8", indexed: false },
    ],
    name: "ReceiptKeyRegistered",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      { name: "x", internalType: "bytes32", type: "bytes32", indexed: true },
      { name: "prefix", internalType: "uint8", type: "uint8", indexed: false },
    ],
    name: "ReceiptKeyRetired",
  },
  {
    type: "error",
    inputs: [
      { name: "electionId", internalType: "bytes32", type: "bytes32" },
      { name: "segment", internalType: "uint32", type: "uint32" },
    ],
    name: "AlreadyAnchored",
  },
  {
    type: "error",
    inputs: [{ name: "blockNumber", internalType: "uint256", type: "uint256" }],
    name: "BlockNumberTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "chainId", internalType: "uint256", type: "uint256" }],
    name: "ChainIdTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "DataTooLong",
  },
  {
    type: "error",
    inputs: [
      { name: "electionId", internalType: "bytes32", type: "bytes32" },
      { name: "segment", internalType: "uint32", type: "uint32" },
    ],
    name: "EmptyBoard",
  },
  { type: "error", inputs: [], name: "EmptyCall" },
  { type: "error", inputs: [], name: "InvalidDeployment" },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "MalformedCheckpoints",
  },
  {
    type: "error",
    inputs: [
      { name: "electionId", internalType: "bytes32", type: "bytes32" },
      { name: "segment", internalType: "uint32", type: "uint32" },
    ],
    name: "MalformedCid",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "MalformedLocator",
  },
  { type: "error", inputs: [], name: "MalformedReceiptKey" },
  { type: "error", inputs: [], name: "NonCanonicalCalldata" },
  {
    type: "error",
    inputs: [{ name: "caller", internalType: "address", type: "address" }],
    name: "NotAuthority",
  },
  {
    type: "error",
    inputs: [
      { name: "segment", internalType: "uint32", type: "uint32" },
      { name: "periodEnd", internalType: "uint256", type: "uint256" },
      { name: "timestamp", internalType: "uint256", type: "uint256" },
    ],
    name: "PastDeadline",
  },
  {
    type: "error",
    inputs: [
      { name: "segment", internalType: "uint32", type: "uint32" },
      { name: "periodEnd", internalType: "uint256", type: "uint256" },
      { name: "timestamp", internalType: "uint256", type: "uint256" },
    ],
    name: "PeriodNotOver",
  },
  {
    type: "error",
    inputs: [
      { name: "prefix", internalType: "uint8", type: "uint8" },
      { name: "x", internalType: "bytes32", type: "bytes32" },
    ],
    name: "ReceiptKeyAlreadyRegistered",
  },
  {
    type: "error",
    inputs: [
      { name: "prefix", internalType: "uint8", type: "uint8" },
      { name: "x", internalType: "bytes32", type: "bytes32" },
    ],
    name: "ReceiptKeyNotActive",
  },
  {
    type: "error",
    inputs: [{ name: "timestamp", internalType: "uint256", type: "uint256" }],
    name: "TimestampTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "count", internalType: "uint256", type: "uint256" }],
    name: "TopicCount",
  },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ElectionRegistry
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const electionRegistryAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "dep",
        internalType: "struct ElectionRegistry.Deployment",
        type: "tuple",
        components: [
          { name: "board", internalType: "address", type: "address" },
          { name: "trusteeRegistry", internalType: "address", type: "address" },
          { name: "groupRegistry", internalType: "address", type: "address" },
          { name: "l1ChainId", internalType: "uint64", type: "uint64" },
          { name: "l1Anchor", internalType: "address", type: "address" },
          { name: "l1Relay", internalType: "address", type: "address" },
          { name: "epoch", internalType: "uint64", type: "uint64" },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "L1_BLOCK",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "MAX_INCLUSION_BOUND",
    outputs: [{ name: "", internalType: "uint32", type: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "MAX_SEQUENCER_DRIFT",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "MAX_SEQUENCING_WINDOW",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "MIN_INCLUSION_BOUND",
    outputs: [{ name: "", internalType: "uint32", type: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "board",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "definitionHash", internalType: "bytes32", type: "bytes32" },
      { name: "c", internalType: "uint256", type: "uint256" },
    ],
    name: "cell",
    outputs: [
      { name: "tier", internalType: "uint8", type: "uint8" },
      { name: "root", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "definitionHash", internalType: "bytes32", type: "bytes32" }],
    name: "cellTiers",
    outputs: [{ name: "", internalType: "uint8[]", type: "uint8[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "definitionHash", internalType: "bytes32", type: "bytes32" }],
    name: "ceremony",
    outputs: [
      { name: "stubHash", internalType: "bytes32", type: "bytes32" },
      { name: "panelId", internalType: "bytes32", type: "bytes32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "createElection",
    outputs: [{ name: "electionId", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "electionId", internalType: "bytes32", type: "bytes32" }],
    name: "creatorOf",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "electionId", internalType: "bytes32", type: "bytes32" }],
    name: "definitionHashOf",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "electionCount",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "counter", internalType: "uint64", type: "uint64" }],
    name: "electionIdAt",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "epoch",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "eventAccumulator",
    outputs: [
      { name: "accumulator", internalType: "bytes32", type: "bytes32" },
      { name: "count", internalType: "uint64", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "groupRegistry",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "l1Anchor",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "l1ChainId",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "l1Relay",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "definitionHash", internalType: "bytes32", type: "bytes32" }],
    name: "parameters",
    outputs: [
      {
        name: "",
        internalType: "struct ElectionRegistry.Parameters",
        type: "tuple",
        components: [
          { name: "ballotVersion", internalType: "uint8", type: "uint8" },
          { name: "threshold", internalType: "uint8", type: "uint8" },
          { name: "panelSize", internalType: "uint8", type: "uint8" },
          { name: "optionCount", internalType: "uint16", type: "uint16" },
          { name: "cellCount", internalType: "uint16", type: "uint16" },
          { name: "authorThreshold", internalType: "uint8", type: "uint8" },
          { name: "authorPanelSize", internalType: "uint8", type: "uint8" },
          { name: "opensAt", internalType: "uint64", type: "uint64" },
          { name: "closesAt", internalType: "uint64", type: "uint64" },
          { name: "l1InclusionBound", internalType: "uint32", type: "uint32" },
          {
            name: "questions",
            internalType: "struct ElectionRegistry.Question[]",
            type: "tuple[]",
            components: [
              { name: "method", internalType: "uint8", type: "uint8" },
              { name: "optionCount", internalType: "uint16", type: "uint16" },
              { name: "minSelections", internalType: "uint16", type: "uint16" },
              { name: "maxSelections", internalType: "uint16", type: "uint16" },
            ],
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "definition", internalType: "bytes", type: "bytes" }],
    name: "registerDefinition",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "trusteeRegistry",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "electionId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "definitionHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "l1OriginNumber",
        internalType: "uint64",
        type: "uint64",
        indexed: false,
      },
      {
        name: "l1OriginTimestamp",
        internalType: "uint64",
        type: "uint64",
        indexed: false,
      },
      {
        name: "l1OriginHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
      {
        name: "definition",
        internalType: "bytes",
        type: "bytes",
        indexed: false,
      },
    ],
    name: "DefinitionRegistered",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "electionId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "creator",
        internalType: "address",
        type: "address",
        indexed: true,
      },
      {
        name: "counter",
        internalType: "uint64",
        type: "uint64",
        indexed: false,
      },
      {
        name: "l1OriginNumber",
        internalType: "uint64",
        type: "uint64",
        indexed: false,
      },
      {
        name: "l1OriginTimestamp",
        internalType: "uint64",
        type: "uint64",
        indexed: false,
      },
      {
        name: "l1OriginHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
    ],
    name: "ElectionCreated",
  },
  {
    type: "error",
    inputs: [
      { name: "opensAt", internalType: "uint64", type: "uint64" },
      { name: "timestamp", internalType: "uint256", type: "uint256" },
    ],
    name: "AlreadyOpen",
  },
  {
    type: "error",
    inputs: [{ name: "electionId", internalType: "bytes32", type: "bytes32" }],
    name: "AlreadyRegistered",
  },
  {
    type: "error",
    inputs: [{ name: "blockNumber", internalType: "uint256", type: "uint256" }],
    name: "BlockNumberTooLarge",
  },
  {
    type: "error",
    inputs: [
      { name: "stubHash", internalType: "bytes32", type: "bytes32" },
      { name: "transcriptHash", internalType: "bytes32", type: "bytes32" },
    ],
    name: "CeremonyNotRecorded",
  },
  {
    type: "error",
    inputs: [{ name: "chainId", internalType: "uint256", type: "uint256" }],
    name: "ChainIdTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "DataTooLong",
  },
  {
    type: "error",
    inputs: [
      {
        name: "rule",
        internalType: "enum ElectionDefinitionLib.Rule",
        type: "uint8",
      },
    ],
    name: "DefinitionIllFormed",
  },
  {
    type: "error",
    inputs: [
      {
        name: "code",
        internalType: "enum ElectionDefinitionLib.DecodeError",
        type: "uint8",
      },
      { name: "offset", internalType: "uint256", type: "uint256" },
    ],
    name: "DefinitionMalformed",
  },
  {
    type: "error",
    inputs: [{ name: "bound", internalType: "uint32", type: "uint32" }],
    name: "InclusionBoundOutOfRange",
  },
  { type: "error", inputs: [], name: "InvalidDeployment" },
  { type: "error", inputs: [], name: "NonCanonicalCalldata" },
  { type: "error", inputs: [], name: "NonCanonicalCalldata" },
  {
    type: "error",
    inputs: [
      { name: "electionId", internalType: "bytes32", type: "bytes32" },
      { name: "caller", internalType: "address", type: "address" },
    ],
    name: "NotCreator",
  },
  {
    type: "error",
    inputs: [
      { name: "opensAt", internalType: "uint64", type: "uint64" },
      { name: "epoch", internalType: "uint64", type: "uint64" },
    ],
    name: "OpensBeforeEpoch",
  },
  {
    type: "error",
    inputs: [
      { name: "recordType", internalType: "uint16", type: "uint16" },
      { name: "version", internalType: "uint8", type: "uint8" },
    ],
    name: "ProfileNotServed",
  },
  {
    type: "error",
    inputs: [
      { name: "tier", internalType: "uint8", type: "uint8" },
      { name: "rootL2Block", internalType: "uint64", type: "uint64" },
      { name: "blockNumber", internalType: "uint256", type: "uint256" },
    ],
    name: "RootNotInPast",
  },
  {
    type: "error",
    inputs: [{ name: "maxSequencerDrift", internalType: "uint64", type: "uint64" }],
    name: "SequencerDriftTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "sequencingWindow", internalType: "uint64", type: "uint64" }],
    name: "SequencingWindowTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "timestamp", internalType: "uint256", type: "uint256" }],
    name: "TimestampTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "count", internalType: "uint256", type: "uint256" }],
    name: "TopicCount",
  },
  {
    type: "error",
    inputs: [{ name: "electionId", internalType: "bytes32", type: "bytes32" }],
    name: "UnknownElection",
  },
  {
    type: "error",
    inputs: [
      {
        name: "field",
        internalType: "enum ElectionRegistry.DeploymentField",
        type: "uint8",
      },
    ],
    name: "WrongDeployment",
  },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// GroupRegistry
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const groupRegistryAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "threshold_", internalType: "uint8", type: "uint8" },
      { name: "registrars_", internalType: "address[]", type: "address[]" },
      {
        name: "trusteeRegistry_",
        internalType: "contract ITrusteePanels",
        type: "address",
      },
      { name: "initialPanelId_", internalType: "bytes32", type: "bytes32" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "SELF_PAID_FEE",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "addMembers",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "addSelfPaidMember",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "addTier1Member",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "tier", internalType: "uint8", type: "uint8" }],
    name: "createGroup",
    outputs: [{ name: "groupId", internalType: "uint64", type: "uint64" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "createSelfPaidGroup",
    outputs: [{ name: "groupId", internalType: "uint64", type: "uint64" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "domainSeparator",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "eventAccumulator",
    outputs: [
      { name: "accumulator", internalType: "bytes32", type: "bytes32" },
      { name: "count", internalType: "uint64", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "groupCount",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "groupId", internalType: "uint64", type: "uint64" }],
    name: "groupCreatedBlock",
    outputs: [{ name: "", internalType: "uint64", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "groupId", internalType: "uint64", type: "uint64" }],
    name: "groupOf",
    outputs: [
      { name: "tier", internalType: "uint8", type: "uint8" },
      { name: "exists", internalType: "bool", type: "bool" },
      { name: "memberCount", internalType: "uint64", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "initialPanelId",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "groupId", internalType: "uint64", type: "uint64" },
      { name: "index", internalType: "uint64", type: "uint64" },
    ],
    name: "isRemoved",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "groupId", internalType: "uint64", type: "uint64" }],
    name: "isSelfPaid",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "nullifierKey",
    outputs: [
      { name: "keyId", internalType: "bytes32", type: "bytes32" },
      { name: "panelId", internalType: "bytes32", type: "bytes32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "keyId", internalType: "bytes32", type: "bytes32" }],
    name: "nullifierKeyRecorded",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "recordNullifierKey",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "recordNullifierReshare",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "registrars",
    outputs: [{ name: "", internalType: "address[]", type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "record", internalType: "bytes", type: "bytes" }],
    name: "removeMembers",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "threshold",
    outputs: [{ name: "", internalType: "uint8", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "trusteeRegistry",
    outputs: [{ name: "", internalType: "contract ITrusteePanels", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "groupId",
        internalType: "uint64",
        type: "uint64",
        indexed: true,
      },
      { name: "tier", internalType: "uint8", type: "uint8", indexed: true },
    ],
    name: "GroupCreated",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "groupId",
        internalType: "uint64",
        type: "uint64",
        indexed: true,
      },
      {
        name: "firstIndex",
        internalType: "uint64",
        type: "uint64",
        indexed: true,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "MembersAdded",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "groupId",
        internalType: "uint64",
        type: "uint64",
        indexed: true,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "MembersRemoved",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "keyId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "NullifierKeyRecorded",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "predecessor",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "keyId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "newPanelId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "NullifierKeyReshared",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "threshold",
        internalType: "uint8",
        type: "uint8",
        indexed: false,
      },
      {
        name: "registrars",
        internalType: "address[]",
        type: "address[]",
        indexed: false,
      },
    ],
    name: "RegistrarsPinned",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "groupId",
        internalType: "uint64",
        type: "uint64",
        indexed: true,
      },
    ],
    name: "SelfPaidGroupCreated",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "groupId",
        internalType: "uint64",
        type: "uint64",
        indexed: true,
      },
      { name: "index", internalType: "uint64", type: "uint64", indexed: true },
      { name: "record", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "SelfPaidMemberAdded",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [{ name: "record", internalType: "bytes", type: "bytes", indexed: false }],
    name: "Tier1MemberAdded",
  },
  {
    type: "error",
    inputs: [{ name: "index", internalType: "uint64", type: "uint64" }],
    name: "AlreadyRemoved",
  },
  {
    type: "error",
    inputs: [{ name: "count", internalType: "uint256", type: "uint256" }],
    name: "BatchSize",
  },
  {
    type: "error",
    inputs: [{ name: "blockNumber", internalType: "uint256", type: "uint256" }],
    name: "BlockNumberTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "chainId", internalType: "uint256", type: "uint256" }],
    name: "ChainIdTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "DataTooLong",
  },
  {
    type: "error",
    inputs: [{ name: "vouch", internalType: "uint256", type: "uint256" }],
    name: "DuplicateSlot",
  },
  {
    type: "error",
    inputs: [{ name: "vouch", internalType: "uint256", type: "uint256" }],
    name: "DuplicateVoucher",
  },
  {
    type: "error",
    inputs: [{ name: "position", internalType: "uint256", type: "uint256" }],
    name: "ForbiddenCommitment",
  },
  {
    type: "error",
    inputs: [
      { name: "firstIndex", internalType: "uint64", type: "uint64" },
      { name: "count", internalType: "uint256", type: "uint256" },
    ],
    name: "GroupFull",
  },
  {
    type: "error",
    inputs: [{ name: "index", internalType: "uint64", type: "uint64" }],
    name: "IndexBeyondSize",
  },
  {
    type: "error",
    inputs: [{ name: "position", internalType: "uint256", type: "uint256" }],
    name: "IndicesOutOfOrder",
  },
  {
    type: "error",
    inputs: [{ name: "panelId", internalType: "bytes32", type: "bytes32" }],
    name: "InitialPanel",
  },
  { type: "error", inputs: [], name: "InsufficientGas" },
  {
    type: "error",
    inputs: [
      {
        name: "reason",
        internalType: "enum GroupRegistry.RegistrarError",
        type: "uint8",
      },
    ],
    name: "InvalidRegistrars",
  },
  {
    type: "error",
    inputs: [{ name: "seat", internalType: "uint8", type: "uint8" }],
    name: "InvalidSeat",
  },
  {
    type: "error",
    inputs: [{ name: "seat", internalType: "uint8", type: "uint8" }],
    name: "InvalidSignature",
  },
  {
    type: "error",
    inputs: [{ name: "keyId", internalType: "bytes32", type: "bytes32" }],
    name: "KeyAlreadyRecorded",
  },
  {
    type: "error",
    inputs: [{ name: "deadline", internalType: "uint64", type: "uint64" }],
    name: "KeyDeadline",
  },
  {
    type: "error",
    inputs: [
      { name: "consents", internalType: "bool", type: "bool" },
      { name: "count", internalType: "uint256", type: "uint256" },
      { name: "quorum", internalType: "uint256", type: "uint256" },
    ],
    name: "KeyQuorum",
  },
  {
    type: "error",
    inputs: [
      { name: "consents", internalType: "bool", type: "bool" },
      { name: "index", internalType: "uint8", type: "uint8" },
    ],
    name: "KeySeat",
  },
  {
    type: "error",
    inputs: [
      { name: "consents", internalType: "bool", type: "bool" },
      { name: "index", internalType: "uint8", type: "uint8" },
    ],
    name: "KeySignature",
  },
  { type: "error", inputs: [], name: "MalformedRecord" },
  { type: "error", inputs: [], name: "NonCanonicalCalldata" },
  {
    type: "error",
    inputs: [{ name: "predecessor", internalType: "bytes32", type: "bytes32" }],
    name: "NotCurrentKey",
  },
  { type: "error", inputs: [], name: "PrecompileFailed" },
  {
    type: "error",
    inputs: [{ name: "vouch", internalType: "uint256", type: "uint256" }],
    name: "RootGrid",
  },
  {
    type: "error",
    inputs: [{ name: "vouch", internalType: "uint256", type: "uint256" }],
    name: "RootWindow",
  },
  {
    type: "error",
    inputs: [
      { name: "size", internalType: "uint64", type: "uint64" },
      { name: "memberCount", internalType: "uint64", type: "uint64" },
    ],
    name: "SizeBeyondCount",
  },
  {
    type: "error",
    inputs: [{ name: "vouch", internalType: "uint256", type: "uint256" }],
    name: "Tier2Group",
  },
  {
    type: "error",
    inputs: [{ name: "timestamp", internalType: "uint256", type: "uint256" }],
    name: "TimestampTooLarge",
  },
  {
    type: "error",
    inputs: [
      { name: "approvals", internalType: "uint256", type: "uint256" },
      { name: "threshold", internalType: "uint8", type: "uint8" },
    ],
    name: "TooFewApprovals",
  },
  { type: "error", inputs: [], name: "TooManyGroups" },
  {
    type: "error",
    inputs: [{ name: "count", internalType: "uint256", type: "uint256" }],
    name: "TopicCount",
  },
  {
    type: "error",
    inputs: [{ name: "groupId", internalType: "uint64", type: "uint64" }],
    name: "UnknownGroup",
  },
  {
    type: "error",
    inputs: [{ name: "panelId", internalType: "bytes32", type: "bytes32" }],
    name: "UnknownPanel",
  },
  {
    type: "error",
    inputs: [{ name: "tier", internalType: "uint8", type: "uint8" }],
    name: "UnsupportedTier",
  },
  {
    type: "error",
    inputs: [{ name: "vouch", internalType: "uint256", type: "uint256" }],
    name: "VouchNullifier",
  },
  {
    type: "error",
    inputs: [
      { name: "vouch", internalType: "uint256", type: "uint256" },
      { name: "slotProof", internalType: "bool", type: "bool" },
    ],
    name: "VouchProof",
  },
  {
    type: "error",
    inputs: [{ name: "vouch", internalType: "uint256", type: "uint256" }],
    name: "VouchRoot",
  },
  {
    type: "error",
    inputs: [{ name: "vouch", internalType: "uint256", type: "uint256" }],
    name: "VouchSlot",
  },
  {
    type: "error",
    inputs: [{ name: "value", internalType: "uint256", type: "uint256" }],
    name: "WrongFee",
  },
  {
    type: "error",
    inputs: [{ name: "groupId", internalType: "uint64", type: "uint64" }],
    name: "WrongKind",
  },
  {
    type: "error",
    inputs: [
      { name: "firstIndex", internalType: "uint64", type: "uint64" },
      { name: "memberCount", internalType: "uint64", type: "uint64" },
    ],
    name: "WrongPosition",
  },
  {
    type: "error",
    inputs: [
      { name: "groupId", internalType: "uint64", type: "uint64" },
      { name: "tier", internalType: "uint8", type: "uint8" },
    ],
    name: "WrongTier",
  },
  { type: "error", inputs: [], name: "ZeroKeyId" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// RegistrationAccount
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const registrationAccountAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "entryPoint_",
        internalType: "contract IEntryPoint",
        type: "address",
      },
      { name: "owner_", internalType: "address", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "entryPoint",
    outputs: [{ name: "", internalType: "contract IEntryPoint", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "target", internalType: "address", type: "address" },
      { name: "value", internalType: "uint256", type: "uint256" },
      { name: "data", internalType: "bytes", type: "bytes" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      {
        name: "calls",
        internalType: "struct BaseAccount.Call[]",
        type: "tuple[]",
        components: [
          { name: "target", internalType: "address", type: "address" },
          { name: "value", internalType: "uint256", type: "uint256" },
          { name: "data", internalType: "bytes", type: "bytes" },
        ],
      },
    ],
    name: "executeBatch",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "getNonce",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "owner",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      {
        name: "userOp",
        internalType: "struct PackedUserOperation",
        type: "tuple",
        components: [
          { name: "sender", internalType: "address", type: "address" },
          { name: "nonce", internalType: "uint256", type: "uint256" },
          { name: "initCode", internalType: "bytes", type: "bytes" },
          { name: "callData", internalType: "bytes", type: "bytes" },
          {
            name: "accountGasLimits",
            internalType: "bytes32",
            type: "bytes32",
          },
          {
            name: "preVerificationGas",
            internalType: "uint256",
            type: "uint256",
          },
          { name: "gasFees", internalType: "bytes32", type: "bytes32" },
          { name: "paymasterAndData", internalType: "bytes", type: "bytes" },
          { name: "signature", internalType: "bytes", type: "bytes" },
        ],
      },
      { name: "userOpHash", internalType: "bytes32", type: "bytes32" },
      { name: "missingAccountFunds", internalType: "uint256", type: "uint256" },
    ],
    name: "validateUserOp",
    outputs: [{ name: "validationData", internalType: "uint256", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "error",
    inputs: [
      { name: "index", internalType: "uint256", type: "uint256" },
      { name: "error", internalType: "bytes", type: "bytes" },
    ],
    name: "ExecuteError",
  },
  { type: "error", inputs: [], name: "InvalidDeployment" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// RegistrationPaymaster
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const registrationPaymasterAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "entryPoint_",
        internalType: "contract IStakeManager",
        type: "address",
      },
      { name: "registry_", internalType: "address", type: "address" },
      { name: "service_", internalType: "address", type: "address" },
      { name: "admin_", internalType: "address", type: "address" },
      { name: "maxCost_", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "unstakeDelaySec", internalType: "uint32", type: "uint32" }],
    name: "addStake",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [],
    name: "admin",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "deposit",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [],
    name: "entryPoint",
    outputs: [{ name: "", internalType: "contract IStakeManager", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "getDeposit",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "maxCost",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "", internalType: "enum IPaymaster.PostOpMode", type: "uint8" },
      { name: "", internalType: "bytes", type: "bytes" },
      { name: "", internalType: "uint256", type: "uint256" },
      { name: "", internalType: "uint256", type: "uint256" },
    ],
    name: "postOp",
    outputs: [],
    stateMutability: "pure",
  },
  {
    type: "function",
    inputs: [],
    name: "registry",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "service",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "unlockStake",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      {
        name: "userOp",
        internalType: "struct PackedUserOperation",
        type: "tuple",
        components: [
          { name: "sender", internalType: "address", type: "address" },
          { name: "nonce", internalType: "uint256", type: "uint256" },
          { name: "initCode", internalType: "bytes", type: "bytes" },
          { name: "callData", internalType: "bytes", type: "bytes" },
          {
            name: "accountGasLimits",
            internalType: "bytes32",
            type: "bytes32",
          },
          {
            name: "preVerificationGas",
            internalType: "uint256",
            type: "uint256",
          },
          { name: "gasFees", internalType: "bytes32", type: "bytes32" },
          { name: "paymasterAndData", internalType: "bytes", type: "bytes" },
          { name: "signature", internalType: "bytes", type: "bytes" },
        ],
      },
      { name: "", internalType: "bytes32", type: "bytes32" },
      { name: "maxCost_", internalType: "uint256", type: "uint256" },
    ],
    name: "validatePaymasterUserOp",
    outputs: [
      { name: "context", internalType: "bytes", type: "bytes" },
      { name: "validationData", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "to", internalType: "address payable", type: "address" }],
    name: "withdrawStake",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "to", internalType: "address payable", type: "address" },
      { name: "amount", internalType: "uint256", type: "uint256" },
    ],
    name: "withdrawTo",
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "error", inputs: [], name: "InvalidDeployment" },
  { type: "error", inputs: [], name: "NotAdmin" },
  { type: "error", inputs: [], name: "NotEntryPoint" },
  {
    type: "error",
    inputs: [
      {
        name: "refusal",
        internalType: "enum RegistrationPaymaster.Refusal",
        type: "uint8",
      },
    ],
    name: "NotSponsored",
  },
  { type: "error", inputs: [], name: "PostOpNotUsed" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TrusteeRegistry
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const trusteeRegistryAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "panels",
        internalType: "struct TrusteeRegistry.PanelInput[]",
        type: "tuple[]",
        components: [
          { name: "threshold", internalType: "uint8", type: "uint8" },
          { name: "quorum", internalType: "uint8", type: "uint8" },
          { name: "keys", internalType: "bytes", type: "bytes" },
          {
            name: "points",
            internalType: "uint256[2][]",
            type: "uint256[2][]",
          },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "stubHash", internalType: "bytes32", type: "bytes32" },
      { name: "transcriptHash", internalType: "bytes32", type: "bytes32" },
      { name: "panelId", internalType: "bytes32", type: "bytes32" },
      { name: "threshold", internalType: "uint8", type: "uint8" },
      { name: "panelSize", internalType: "uint8", type: "uint8" },
    ],
    name: "ceremonyRecorded",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "eventAccumulator",
    outputs: [
      { name: "accumulator", internalType: "bytes32", type: "bytes32" },
      { name: "count", internalType: "uint64", type: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "panelId", internalType: "bytes32", type: "bytes32" },
      { name: "index", internalType: "uint256", type: "uint256" },
    ],
    name: "keyOf",
    outputs: [
      { name: "x", internalType: "uint256", type: "uint256" },
      { name: "y", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "stubHash", internalType: "bytes32", type: "bytes32" },
      { name: "panelId", internalType: "bytes32", type: "bytes32" },
    ],
    name: "keySetOf",
    outputs: [
      { name: "keySetHash", internalType: "bytes32", type: "bytes32" },
      { name: "seats", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "panelCount",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "panelIds",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "panelId", internalType: "bytes32", type: "bytes32" }],
    name: "panelOf",
    outputs: [
      { name: "threshold", internalType: "uint8", type: "uint8" },
      { name: "size", internalType: "uint8", type: "uint8" },
      { name: "quorum", internalType: "uint8", type: "uint8" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "registration", internalType: "bytes", type: "bytes" }],
    name: "registerCeremony",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "stubHash", internalType: "bytes32", type: "bytes32" },
      { name: "panelId", internalType: "bytes32", type: "bytes32" },
      { name: "index", internalType: "uint256", type: "uint256" },
    ],
    name: "signingKeyOf",
    outputs: [
      { name: "x", internalType: "uint256", type: "uint256" },
      { name: "y", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "stubHash", internalType: "bytes32", type: "bytes32" },
      { name: "panelId", internalType: "bytes32", type: "bytes32" },
    ],
    name: "transcriptOf",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "stubHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "panelId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "transcriptHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "registration",
        internalType: "bytes",
        type: "bytes",
        indexed: false,
      },
    ],
    name: "CeremonyRegistered",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "panelId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "threshold",
        internalType: "uint8",
        type: "uint8",
        indexed: false,
      },
      { name: "quorum", internalType: "uint8", type: "uint8", indexed: false },
      { name: "keys", internalType: "bytes", type: "bytes", indexed: false },
    ],
    name: "PanelPinned",
  },
  {
    type: "error",
    inputs: [
      { name: "stubHash", internalType: "bytes32", type: "bytes32" },
      { name: "panelId", internalType: "bytes32", type: "bytes32" },
    ],
    name: "AlreadyRecorded",
  },
  {
    type: "error",
    inputs: [
      { name: "seats", internalType: "uint256", type: "uint256" },
      { name: "quorum", internalType: "uint8", type: "uint8" },
    ],
    name: "BelowQuorum",
  },
  {
    type: "error",
    inputs: [{ name: "blockNumber", internalType: "uint256", type: "uint256" }],
    name: "BlockNumberTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "chainId", internalType: "uint256", type: "uint256" }],
    name: "ChainIdTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "length", internalType: "uint256", type: "uint256" }],
    name: "DataTooLong",
  },
  {
    type: "error",
    inputs: [{ name: "index", internalType: "uint8", type: "uint8" }],
    name: "DuplicateSigningKey",
  },
  {
    type: "error",
    inputs: [
      { name: "position", internalType: "uint256", type: "uint256" },
      {
        name: "reason",
        internalType: "enum TrusteeRegistry.PanelError",
        type: "uint8",
      },
    ],
    name: "InvalidPanel",
  },
  {
    type: "error",
    inputs: [{ name: "index", internalType: "uint8", type: "uint8" }],
    name: "InvalidSignature",
  },
  {
    type: "error",
    inputs: [{ name: "index", internalType: "uint8", type: "uint8" }],
    name: "InvalidSigningKey",
  },
  {
    type: "error",
    inputs: [{ name: "index", internalType: "uint8", type: "uint8" }],
    name: "KeySetSeatsOutOfOrder",
  },
  {
    type: "error",
    inputs: [
      { name: "seats", internalType: "uint256", type: "uint256" },
      { name: "threshold", internalType: "uint8", type: "uint8" },
    ],
    name: "KeySetTooSmall",
  },
  { type: "error", inputs: [], name: "MalformedRegistration" },
  { type: "error", inputs: [], name: "NoPanels" },
  { type: "error", inputs: [], name: "NonCanonicalCalldata" },
  {
    type: "error",
    inputs: [{ name: "index", internalType: "uint8", type: "uint8" }],
    name: "SeatsOutOfOrder",
  },
  {
    type: "error",
    inputs: [{ name: "timestamp", internalType: "uint256", type: "uint256" }],
    name: "TimestampTooLarge",
  },
  {
    type: "error",
    inputs: [{ name: "count", internalType: "uint256", type: "uint256" }],
    name: "TopicCount",
  },
  {
    type: "error",
    inputs: [{ name: "panelId", internalType: "bytes32", type: "bytes32" }],
    name: "UnknownPanel",
  },
  { type: "error", inputs: [], name: "ZeroTranscriptHash" },
] as const;
