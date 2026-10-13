import { BoardMap, Count, StatFigure } from "@abolishus/ui";

import { ANCHORS, AS_OF } from "./board-data.ts";
import { MAP_LABELS } from "./board-place-page.tsx";
import { countKinds, fmt, LEVY_BOARD, LEVY_MINE } from "./board-place-data.ts";
import { LEVY } from "./fixtures.ts";
import { MockShell, PageHead } from "./shell.tsx";

const COUNTS = countKinds(LEVY_BOARD);
const LAST = ANCHORS[0]!;

export interface BoardMapHeroProps {
  /** Arrived from a receipt: mark its entry. */
  withEntry?: boolean;
}

/**
 * The board page's hero for one poll's board: every entry at once, an hour to
 * a block, with the anchors under them, before the ledger that lists them.
 */
export function BoardMapHero({ withEntry = false }: BoardMapHeroProps) {
  return (
    <MockShell current="/board">
      <PageHead
        eyebrow={`The board · ${LEVY.title}`}
        title="Every entry, at once"
        lede={`Each square is one entry on the public board, in the order it was appended: ${fmt(LEVY_BOARD.kinds.length)} of them, from the poll's registration to the trustees' last statement. Each hour's entries form a block, anchored to Ethereum when the hour ended.`}
      />
      <div className="mx-auto grid max-w-6xl gap-10 px-4 pb-16">
        <div className="grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          <StatFigure
            value={<Count value={LEVY_BOARD.kinds.length} />}
            label="Entries"
            scope={`As of ${AS_OF}`}
          />
          <StatFigure
            value={<Count value={COUNTS[0]!} />}
            label="Ballots"
            scope="Every cast, including replaced ones"
          />
          <StatFigure
            value={<Count value={LEVY_BOARD.segments.length} />}
            label="Segments"
            scope="One per hour with entries"
          />
          <StatFigure
            value={<Count value={LAST.block} />}
            label="Last anchor"
            scope={`Ethereum block, ${LAST.at}`}
          />
        </div>
        <BoardMap
          kinds={LEVY_BOARD.kinds}
          segments={LEVY_BOARD.segments}
          labels={MAP_LABELS}
          maxHeight={560}
          {...(withEntry ? { mine: LEVY_MINE } : {})}
        />
      </div>
    </MockShell>
  );
}
