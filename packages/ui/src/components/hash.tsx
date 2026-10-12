import { useId } from "react";

/** Splits a hex string into groups of `size` characters, the last possibly shorter. */
export function groupHex(value: string, size = 4): string[] {
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError("group size must be a positive integer");
  const groups: string[] = [];
  for (let i = 0; i < value.length; i += size) groups.push(value.slice(i, i + size));
  return groups;
}

export interface HashProps {
  /** Lowercase hex, exactly as the board or receipt holds it. */
  value: string;
  /** What the hash is, translated by the caller ("Receipt hash"). */
  label: string;
}

/**
 * Evidence, shown in Plex Mono ("Show your work"). The groups are spaced by
 * margin, not by characters, so selecting and copying the hash yields the
 * exact value to compare with the board. `translate="no"` keeps browser
 * translation from rewriting it.
 */
export function Hash({ value, label }: HashProps) {
  const labelId = useId();
  if (!/^[0-9a-f]+$/.test(value)) throw new RangeError("Hash takes lowercase hex");
  // The caption names the figure explicitly: not every assistive technology
  // derives a figure's name from its figcaption.
  return (
    <figure className="m-0" aria-labelledby={labelId}>
      <figcaption id={labelId} className="text-sm text-muted-foreground">
        {label}
      </figcaption>
      <code translate="no" className="font-mono text-base break-all text-foreground">
        {groupHex(value).map((group, i) => (
          <span key={i} className="mr-[0.5ch] last:mr-0">
            {group}
          </span>
        ))}
      </code>
    </figure>
  );
}
