/**
 * Active-filter chip for an open custom guide: the diff shows only the
 * guide's hunks; × returns to the main guide (the route change clears
 * the filter's `guideId`, see `CustomGuideSync`).
 */
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

export function GuideFilterChip({
  reviewId,
  title,
  hunks,
}: {
  reviewId: string;
  title: string;
  hunks: number;
}): ReactNode {
  const navigate = useNavigate();
  return (
    <span className="fchip" data-filterchip="guide">
      Guide: {title} · {hunks} {hunks === 1 ? "hunk" : "hunks"}
      <button
        type="button"
        aria-label="Back to the main guide"
        data-tip="Back to the main guide"
        onClick={() => navigate(`/review/${reviewId}`)}
      >
        ×
      </button>
    </span>
  );
}
