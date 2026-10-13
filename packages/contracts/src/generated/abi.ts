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
      { name: "tier", internalType: "uint8", type: "uint8" },
      { name: "rootL2Block", internalType: "uint64", type: "uint64" },
      { name: "blockNumber", internalType: "uint256", type: "uint256" },
    ],
    name: "RootNotInPast",
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
    ],
    stateMutability: "nonpayable",
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
    inputs: [{ name: "tier", internalType: "uint8", type: "uint8" }],
    name: "createGroup",
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
  { type: "error", inputs: [], name: "MalformedRecord" },
  { type: "error", inputs: [], name: "NonCanonicalCalldata" },
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
    inputs: [{ name: "tier", internalType: "uint8", type: "uint8" }],
    name: "UnsupportedTier",
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
