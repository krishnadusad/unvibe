/**
 * Thread hooks for guide blocks (web-guide owner).
 *
 * Threads themselves are a later milestone (comments agent). Until then:
 * - `blockThreads(annotations, cardId, blockId)` returns the thread
 *   annotations anchored on the block. Anchors store `cardId#blockId`
 *   (service form, exact owner + block match — #116); the legacy
 *   prototype bare block ID form no longer matches.
 * - `onOpenBlockThread` is the seam the threads milestone plugs into.
 */
import { useMemo } from "react";
import type { Annotation } from "@unvibe/shared";
import { useVisibleAnnotations } from "../state/store.js";
import { anchorMatchesBlock } from "./guideUtils.js";

export type OpenThreadHandler = (threadId: string, blockId: string, opts?: { scroll?: boolean }) => void;

let openHandler: OpenThreadHandler | null = null;

/** Threads milestone: register the real open-thread behaviour here. */
export function onOpenBlockThread(fn: OpenThreadHandler): () => void {
  openHandler = fn;
  return () => {
    if (openHandler === fn) openHandler = null;
  };
}

/** Default: no full thread UI yet — hovering the marker previews it. */
export function openBlockThread(commentId: string, blockId: string): void {
  openHandler?.(commentId, blockId);
}

/**
 * Issue #205: a block's comment marker opens every comment on the block,
 * stacked in order (only the first scrolls into view).
 */
export function openBlockThreads(commentIds: string[], blockId: string): void {
  commentIds.forEach((id, i) => openHandler?.(id, blockId, { scroll: i === 0 }));
}

/** All comment annotations anchored on a guide card + block. */
export function blockThreads(
  annotations: Annotation[],
  cardId: string,
  blockId: string,
): Annotation[] {
  return annotations.filter(
    (a) =>
      a.type === "comment" &&
      a.anchor.host.kind === "block" &&
      anchorMatchesBlock(a.anchor.host.blockId, cardId, blockId),
  );
}

/** Open (in-place) conversation annotations anchored on a card + block. */
export function blockExpansions(
  annotations: Annotation[],
  cardId: string,
  blockId: string,
): Annotation[] {
  return annotations.filter(
    (a) =>
      a.type === "conversation" &&
      a.open &&
      a.anchor.host.kind === "block" &&
      anchorMatchesBlock(a.anchor.host.blockId, cardId, blockId),
  );
}

export function useBlockThreads(cardId: string, blockId: string): Annotation[] {
  const annotations = useVisibleAnnotations();
  return useMemo(
    () => (annotations ? blockThreads(annotations, cardId, blockId) : []),
    [annotations, cardId, blockId],
  );
}

export function useBlockExpansions(cardId: string, blockId: string): Annotation[] {
  const annotations = useVisibleAnnotations();
  return useMemo(
    () => (annotations ? blockExpansions(annotations, cardId, blockId) : []),
    [annotations, cardId, blockId],
  );
}
