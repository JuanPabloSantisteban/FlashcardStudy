# Guide: adding flashcards (for Claude)

Paste this whole file into a Claude chat, then give Claude the material to turn into cards.
Claude's job is to write deck files in the exact format below. The owner then pastes them into the
repository (or Claude Code commits them directly).

## How the app works

- A static site on GitHub Pages. No build step: the app reads text files from `cards/`.
- There are three **categories**: `School`, `IB preparation`, `General Concepts`.
- The user picks a category, optionally filters by **course** and **topic**, and reviews cards on demand.
- Each card has a **front** (a term or short question) and a **back** (the explanation).
  The user flips the card and marks it green (knew it) or red (didn't). There is no spaced repetition.
- About 85% of the content is from an economics master's degree, so most cards go in `School`.

## Cards added from the app

The user can also add cards in the web app (the "+ Add" screen). The app appends them to the matching
deck file in the same format (or creates `cards/<category-folder>/<course-slug>.md` and lists it in
`cards/index.json`). Treat those cards like any other: keep their ids, and check them for duplicates
before adding new ones. `cards/index.json` also holds `"repo"` and `"branch"`, which the app needs; leave them as they are.

## Where files go

```
cards/
  index.json                      ← lists every deck file (must be updated for new files)
  school/<course-slug>.md         ← one file per course, e.g. school/macroeconomics.md
  ib-preparation/<topic>.md
  general-concepts/<topic>.md
```

**Adding cards to an existing deck:** append them to the end of that file. Nothing else changes.

**Creating a new deck file:** create the file, then add its path (relative to `cards/`) to the
`"decks"` list in `cards/index.json`. A file not listed there is ignored.

```json
{
  "categories": [ ... leave as is ... ],
  "decks": [
    "school/macroeconomics.md",
    "school/econometrics.md",
    "school/new-course.md"
  ]
}
```

## Deck file format

```
---
category: School
course: Macroeconomics
---

id: macro-solow-steady-state
topic: Growth
front: Solow model: steady-state condition
back: Investment per effective worker equals break-even investment:
$$s\,f(k^*) = (n + g + \delta)\,k^*$$
where $s$ is the saving rate and $\delta$ depreciation.

===

id: macro-golden-rule
topic: Growth
front: Golden Rule level of capital
back: The steady state that **maximizes consumption** per effective worker:
$$f'(k_{GR}) = n + g + \delta$$
```

Rules:

1. **Header** between `---` lines at the top of the file:
   - `category:` required, exactly one of `School`, `IB preparation`, `General Concepts`.
   - `course:` the course name for every card in this file. Use it for `School`; optional elsewhere.
   - `topic:` optional default topic for every card in the file.
2. **Cards are separated** by a line containing only `===`.
3. **Inside a card**, in this order:
   - `id:` required. Unique across the whole repository, lowercase with hyphens, starting with a short
     course prefix (`macro-`, `micro-`, `metrics-`, `ib-`, `gen-` …). **Never change an id once it
     exists**: the user's green/red marks are stored by id.
   - `topic:` the topic inside the course (e.g. `Growth`, `Consumption`, `OLS`). Reuse existing topic
     names exactly (same spelling and capitalisation) so filters stay clean.
   - `course:` only if this card differs from the file's course (rare).
   - `front:` the term or short question. Can continue on following lines.
   - `back:` the answer. **Everything after `back:` until the next `===` is the back**, including blank
     lines, so `back:` must be the last field.
4. Lines starting with `//` before `front:` are comments and are ignored.

## Text and math

- Text is Markdown: `**bold**`, `*italics*`, lists (`- item`), tables, line breaks.
- Math is LaTeX, rendered with KaTeX:
  - Inline: `$\beta$` or `\(\beta\)`
  - Display (own line): `$$ ... $$` or `\[ ... \]`
  - Use single backslashes as normal LaTeX (`\frac`, `\delta`). The files are plain text, not JSON,
    so **do not double the backslashes**.
- A literal dollar sign (money) must be written `\$`, e.g. `costs \$5`.
- Supported: most of standard LaTeX math, `\operatorname{}`, `\text{}`, `\mathbb{}`, `aligned`,
  `cases`, `pmatrix`. Not supported: `\label`, `\eqref`, packages, custom `\newcommand` across cards.
- For multi-line derivations use `$$\begin{aligned} a &= b \\ &= c \end{aligned}$$`.

## Images

- Images live in the `images/` folder at the repository root and are referenced from the front or
  back with Markdown: `![Proof of OLS unbiasedness](images/ols-unbiasedness-proof.jpg)`.
  The path is relative to the site root, so always start it with `images/`.
- In the app, the "Add image" button (or pasting an image into the text box) uploads the picture,
  shrinks it to at most 1800px, and inserts this line for you.
- Claude Chat can't upload files. If an image is needed, write the card text with the image line and
  tell the user which file to add to `images/` (or let them use the app).
- Tapping an image on a card opens it full screen.

## Writing good cards

- **One idea per card.** If the back needs a heading, split it into two cards.
- **Front:** short and specific. A name ("Golden Rule level of capital") or a direct question
  ("Why is OLS biased if a relevant variable is omitted?"). Avoid yes/no questions.
- **Back:** the key statement first, in 1–3 sentences or one formula. Then, if useful, one line of
  intuition (`**Intuition:** …`) or define the symbols. Aim for what fits on a phone screen
  without scrolling.
- For formulas, always say what the symbols mean unless they are standard (like $r$ or $\beta$).
- Don't duplicate cards that already exist. If the user shares the current deck, check it first.
- Prefer the user's course wording and notation when material is provided.

## What to output

When asked to create cards, respond with:

1. The file path(s), e.g. `cards/school/macroeconomics.md`.
2. The text to append (or the full new file), in a code block, ready to paste.
3. If a new file was created, the updated `"decks"` list for `cards/index.json`.

## Checking the result

After the files are pushed, open the site. If any card is malformed, a red box at the top of the page
lists the file and card number with the problem (missing `back:`, duplicate id, unknown category).
