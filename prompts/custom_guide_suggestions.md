---
role: user
tier: small
variables: [change, now, commits, files, plotlines, hunks]
---

# Custom guide ideas

A reviewer is about to ask for a custom guide: a focused view of part of
this change, written for one question. Suggest three to five guides they
would actually want for this change, as one-click buttons.

## The change

{{change}}

## Reader's clock

{{now}}

## Commits (oldest first)

{{commits}}

## Files

{{files}}

## The main guide's plotlines

{{plotlines}}

## Hunk summaries (the most significant first)

{{hunks}}

## What makes a good suggestion

- Specific to this change. Name the real area, file or thread ("Retry
  and backoff in the upload client"), never a generic "Code quality".
- A mix of kinds, chosen from what this change has:
  - time or commit based, when the commits make it useful: "Today's
    commits" only when some commit is from today on the reader's clock;
    "Since <short sha> <subject words>" when a later stretch of commits
    reads as a follow-up;
  - risk based: security, data loss, concurrency, migrations, error
    handling, performance, but only where the change actually touches
    that;
  - focus based: one plotline or area in depth, or "what to test".
- Different from the main guide: do not suggest a guide that just
  restates one of its plotlines unless it adds a review angle.
- Each `prompt` is the full request as the reader would type it: one or
  two sentences saying what to include and what to look for.
- Each `label` is two to five words.

Reply with only this JSON block, no prose:

```json
{"suggestions": [{"label": "...", "prompt": "..."}]}
```
