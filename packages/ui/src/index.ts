export {
  BoardLedger,
  type BoardLedgerProps,
  type LedgerEntry,
} from "./components/board-ledger.tsx";
export {
  AnchorMark,
  BOARD_KINDS,
  BoardMap,
  boardKindCode,
  KindSwatch,
  type BoardEntryKind,
  type BoardMapLabels,
  type BoardMapProps,
  type BoardMapSegment,
} from "./components/board-map.tsx";
export {
  BOARD_ZOOM_VIEWS,
  BoardZoom,
  BoardZoomGraphic,
  type BoardZoomEntry,
  type BoardZoomGraphicProps,
  type BoardZoomProps,
  type BoardZoomView,
} from "./components/board-zoom.tsx";
export {
  InclusionPath,
  type InclusionAnchor,
  type InclusionPathLabels,
  type InclusionPathProps,
  type InclusionSibling,
  type InclusionVerdict,
} from "./components/inclusion-path.tsx";
export { auditPath, type AuditStep, type EntryRange } from "./lib/board-tree.ts";
export { Button, buttonVariants, type ButtonProps } from "./components/ui/button.tsx";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
export { Count, type CountProps } from "./components/count.tsx";
export {
  Fingerprint,
  FINGERPRINT_BITS,
  FINGERPRINT_SIZE,
  fingerprintCells,
  type FingerprintCell,
  type FingerprintProps,
} from "./components/fingerprint.tsx";
export { groupHex, Hash, type HashProps } from "./components/hash.tsx";
export { QrCode, type QrCodeProps } from "./components/qr-code.tsx";
export {
  encodeQr,
  QR_MAX_VERSION,
  QR_MIN_VERSION,
  QR_QUIET_ZONE,
  type QrLevel,
  type QrMode,
  type QrOptions,
  type QrSymbol,
} from "./lib/qr.ts";
export { ScrollScene, type ScrollSceneProps } from "./components/scroll-scene.tsx";
export { SectionMark, type SectionMarkProps } from "./components/section-mark.tsx";
export { StatFigure, type StatFigureProps } from "./components/stat-figure.tsx";
export { ReceiptStub, type ReceiptStubProps } from "./components/receipt-stub.tsx";
export {
  StatusTrail,
  type StatusStep,
  type StatusTrailProps,
  type StepState,
} from "./components/status-trail.tsx";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  tabsListVariants,
} from "./components/ui/tabs.tsx";
export { TallyBars, type TallyBarsProps, type TallyRow } from "./components/tally-bars.tsx";
export { TierSwitcher, type Tier, type TierSwitcherProps } from "./components/tier-switcher.tsx";
export * from "./i18n/index.ts";
export { useActiveStep } from "./hooks/use-active-step.ts";
export { useScrollProgress } from "./hooks/use-scroll-progress.ts";
export { cn } from "cn";
