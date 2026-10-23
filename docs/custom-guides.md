# Custom guides

A custom guide is a view of the change that the reader asks for in their
own words, next to the main guide:

- "What changed in today's commits?"
- "Since commit abc1234"
- "Security review: only the hunks that handle untrusted input"

Each guide has its own sections (cards), plotlines, scope (the hunks it
covers) and suggested comments. Comments, Explain/Ask, depth and the rest
work on its cards the usual way. It never changes the main guide.

## Lifecycle

```
POST /api/reviews/:id/guides {prompt}
  → guide { status: "working", jobId }          sections stream into page gp-<id>
  → "ready"        scope, plotlines, assignment, suggested comments written
  → "needs-input"  the agent asked one question (guide.question)
       POST …/guides/:gid/answer {answer} → "working" → …
  → "failed"       guide.error; POST …/regenerate retries
refresh to version n+1 → guide.stale = true (Regenerate)
DELETE …/guides/:gid  → guide, its pages and unmarked suggestions removed
```

## How the request is read

The `custom-guide` job (`Pipeline.runCustomGuide`,
`prompts/custom_guide.md`) forks the review's base session, so it already
has the diff, the commit list with hunk ids, and the main guide. On top of
that it gets:

- the request turns;
- the reader's local clock and timezone;
- one line per commit with author, author date and committer date.

The agent interprets "today", "since X", "what Ada changed" itself. When
two readings would select different hunks, it returns only
`{"clarify": "…"}` instead of guessing. The guide then waits in
"needs-input" until the reader answers, and the answer is appended to the
request turns for the next run.

The reply's trailing JSON names `scope.commits` (SHA prefixes) and/or
`scope.hunks`. `resolveCustomGuideScope` (shared) turns it into the
guide's hunk set: the hunks of the named commits, plus explicit hunks,
plus every hunk a plotline claims, keeping only known hunks, in diff
order.

## Isolation from the main guide

| Concern | How custom guides stay out |
|---|---|
| Pages | `Page.guideId`; the root page has kind `"guide"`. Pages opened from a guide card inherit `guideId`. |
| Base cache key | `guideRevisionForSnapshot` skips guide pages, so streaming a guide doesn't rebuild the base for later asks. |
| Main-guide context and hunk visibility | `toPromptSnapshot`'s cited set and `isCitedByGuide` skip guide pages. |
| Plotlines | Stored on the guide (`plotlines`, `assignment`), never on `hunkStates`. |
| Diff filter | `DiffFilter.guideId` scopes the diff to the guide's hunks; `plotline` then refers to the guide's plotlines. |
| Shared context | Guide turns run with `skipIngest`: their contributions don't reach later main-guide turns. |
| Update pass | Guide cards are not sent to the update pass. A new version marks the guide `stale`, and the reader regenerates it. |
| Comments | Suggestions carry `guideId` and show only inside their guide until marked for the PR (`post: true`, `annotationVisibleIn`). |

## Not yet

- Inline diagrams in guide sections: the prompt asks for prose only, and
  the reader can add a diagram from any card.
- Go-deeper placeholders inside a guide.
- Recomputing a stale guide's scope automatically.
