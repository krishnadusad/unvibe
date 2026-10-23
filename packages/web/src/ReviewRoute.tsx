/** Review route: shell + WS subscription + floating UI slots. */
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { api } from "./api/client.js";
import { connectEvents } from "./api/ws.js";
import { GuideThreadHooks } from "./comments/GuideThreads.js";
import { CustomGuideSync } from "./guide/CustomGuides.js";
import { ExpansionHighlights } from "./guide/expansions/ExpansionHighlights.js";
import { HoverPopover } from "./floating/HoverPopover.js";
import { SelectionToolbar } from "./floating/SelectionToolbar.js";
import { Toast } from "./floating/Toast.js";
import { Tooltip } from "./floating/Tooltip.js";
import { AppShell } from "./shell/AppShell.js";
import { useReview } from "./state/store.js";

export function ReviewRoute() {
  const { id } = useParams<{ id: string }>();
  const reviewId = id ?? "demo";
  const applyEvent = useReview((s) => s.applyEvent);
  const setConnected = useReview((s) => s.setConnected);
  const resyncSeq = useReview((s) => s.resyncSeq);

  // The store is global: drop the snapshot when leaving a review, so the
  // next review never renders (or patches) the previous one's guide.
  useEffect(() => () => useReview.getState().clear(), [reviewId]);

  useEffect(() => {
    return connectEvents({ reviewId, onEvent: applyEvent, onStatus: setConnected });
  }, [reviewId, applyEvent, setConnected]);

  // Patch-gap resync: when queued patches don't chain onto the snapshot
  // (stale fetch, pre-snapshot patches, dropped socket), the store raises
  // `resyncSeq`. Refetch the confirmed server snapshot; the store drains
  // queued patches against it, so no confirmed state is lost.
  useEffect(() => {
    if (resyncSeq === 0) return;
    let cancelled = false;
    api
      .review(reviewId)
      .then((snap) => {
        if (!cancelled) useReview.getState().setSnapshot(snap);
      })
      .catch(() => {
        // A failed resync keeps the queued patches; the next gap or
        // patch retries.
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, resyncSeq]);

  return (
    <>
      <AppShell reviewId={reviewId} />
      <CustomGuideSync reviewId={reviewId} />
      <GuideThreadHooks />
      <ExpansionHighlights />
      <HoverPopover />
      <Tooltip />
      <SelectionToolbar />
      <Toast />
    </>
  );
}
