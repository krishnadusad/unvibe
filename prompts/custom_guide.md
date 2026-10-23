---
role: user
tier: main
variables: [request, now, commits]
---

# Custom guide

The reader asked for a custom guide: a separate, focused view of this
change, built for their request. It sits beside the main guide and never
replaces it, so do not repeat the main guide; write only what this
request needs.

## The request

{{request}}

The request may be a conversation: your earlier questions and the
reader's answers follow the first message. Use all of it.

## Reader's clock

{{now}}

Judge relative times ("today", "this morning", "since yesterday", "this
week") against this clock and timezone, not UTC.

## Commits

{{commits}}

Each commit lists its author, author date and committer date. A rebase or
amend changes the committer date but not the author date; when the two
disagree and it matters for the request, say which one you used in the
scope note.

## First: is the request clear enough?

Work out exactly which part of the change the request covers before
writing anything. When it is genuinely ambiguous — the reader would
plausibly mean two different sets of hunks, and guessing wrong would
waste their time — ask one short question instead of guessing. Examples:
"today" when no commit falls on today but several fell late yesterday;
"since the refactor" when two commits could be "the refactor"; a commit
reference that matches nothing. Then reply with only the trailing JSON
block, `{"clarify": "<one question, with the options you see>"}`, and no
cards.

Do not ask when a sensible reading is clear; state your reading in the
scope note instead. Never ask twice about the same thing.

## Choosing the scope

- Commit-based requests ("today's commits", "since commit abc1234",
  "the last three commits", "what Ada changed"): pick the commits from
  the list above and name them in `scope.commits` (SHA or a prefix of at
  least 7 characters). Their hunks are added for you; add individual
  hunks in `scope.hunks` only when a commit's mapping missed one.
- Topic-based requests ("security review", "error handling", "what
  touches the database"): read the diff and list the matching hunks in
  `scope.hunks` (the `h:…` IDs on the hunk headers). Be selective: a
  hunk belongs only when a reviewer focused on this topic would need to
  read it. Use `get_hunk` and `get_code` to check before including.
- Combinations ("security issues in today's commits") narrow the commit
  scope by topic: list only the matching hunks in `scope.hunks` and leave
  `scope.commits` empty.

When nothing in the change matches, say so in one short card and return
an empty scope; do not stretch the request to fit.

## The guide

Write it the way the main guide is written — every paragraph that states
something about the change carries its citations — but shaped by the
request:

1. Open with a card that answers the request directly: what this part of
   the change does, in a few sentences, and what the reader should focus
   on. For a review-style request (security, performance, correctness),
   lead with what you found, most serious first, with confidence, and say
   plainly when you found nothing worth raising.
2. Then one card per plotline of this guide (below), in landing order,
   explaining that thread for this request. Skip per-plotline cards when
   there is only one plotline.
3. Then, when it helps, one card on what to check: tests, edge cases, or
   the specific risks the request is about.

Keep it to what the request needs: three to six cards is typical, fewer
is fine. Write prose, lists and tables only — no diagrams here; the
reader can ask for a diagram on any card.

## Plotlines

Group this guide's hunks into a few plotlines for this request, the same
way the main guide does — threads with their own purpose, never file
types — but chosen for this view (a security guide might group by
"authentication", "input validation", "secrets handling"). Each hunk in
the scope belongs to at most one plotline; hunks you leave out read as
"other". One plotline is fine for a small scope.

## Suggested comments

When the request is review-style and you found something worth saying to
the author, draft at most five suggested comments, each anchored to one
diff line (`diff:<fileKey>:<line>`, new-side line) and written as you
would post it: specific, polite, one point each. They stay in this guide
until the reader marks them for the PR. Do not suggest comments for
explanatory requests.

## Output shape

Stream one `## Title` card at a time; the first card opens your reply (no
greeting or plan before it). End with one trailing `json` block:

```json
{"title": "<short title for this guide>",
 "scopeNote": "<one line: what is included and how you read the request>",
 "scope": {"commits": ["<sha or prefix>"], "hunks": ["h:<fileKey>:<hash>"]},
 "plotlines": [{"id": "auth-checks", "name": "...", "description": "...", "buildsOn": "<earlier id, only when it depends on one>", "hunks": ["h:<fileKey>:<hash>"]}],
 "comments": [{"diff": "diff:<fileKey>:<line>", "text": "..."}]}
```

Or, when you need to ask first, only `{"clarify": "..."}`.
