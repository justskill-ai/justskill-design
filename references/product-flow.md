# The product flow

<!-- Hand-written, like references/images.md: a playbook, not a rendering of
     the format table. The route it expands is the table in SKILL.md. -->

`SKILL.md` has the route in one table. This file is how to walk it: which
request takes which lane, the questions worth asking, what to show the user at
each stage, the canvas handshake, and the handoff to code.

The order exists because two mistakes are expensive: designing a page before the
product is agreed gives a beautiful answer to the wrong question, and writing
code before the user has approved a screen is work done twice. Every stage
below removes one of those risks. None of them is a lock on the user.

## Contents

1. Which request is which
2. Stage 1 — Idea
3. Stage 2 — Feature breakdown
4. Stage 3 — Feature confirmation
5. Stage 4 — Design takeover
6. Stage 5 — Design first
7. Stage 6 — Canvas
8. Stage 7 — UI adjustment
9. Stage 8 — Page sign-off
10. Stage 9 — Code
11. Keeping it soft
12. One conversation, end to end

## Which request is which

| The request sounds like | Lane | Start at |
|---|---|---|
| "I want an app that…", "a tool for…", "help me build…" | new product | Stage 1 |
| "add a feature", "change how checkout works", "let users…" | feature change | Stage 2 |
| "make this card rounder", "this title is too big", a pasted node id | edit in an existing design | Stage 7 |
| "just build it", "write the code first", "skip the design" | explicit shortcut | what they asked for; mention the screen once, then drop it |
| "fix this bug", an unrelated code task | not a design request | do the work; do not hijack it |

Two entry points get the route: a new product idea, and a feature to add or
change — including when the user never says "design", "UI" or "page", because a
feature is product design before it is code.

A concrete edit inside an existing design is not a product request. "Add a
pricing row to this page", "make that card rounder", "this headline is too
big": the screen and the content are already decided, so make the edit with the
CLI or on the canvas and skip the route. When the two are mixed — "add a
pricing row" inside a feature that does not exist yet — the feature part is
product-shaped; agree that first, then the row is an edit.

When it is genuinely unclear whether a request changes what the product does or
only how it looks, ask one question: "Is this a new capability, or a change to
the screen as it stands?" One question, not a form.

## Stage 1 — Idea

The goal is to understand the product well enough to propose screens, not to
interview the user. Ask at most the three questions that change the screens:

1. Who is it for, and what do they do today instead? (audience decides density,
   tone, and how long the flow can be)
2. What is the one thing a user must be able to do? (the core loop decides the
   first screen)
3. What is out of the first version? (scope decides how many screens exist)

Do not ask for colours, fonts, a layout preference or "do you want a
dashboard?". Those are design decisions, and design is your job. If the user
offers a brand or a reference, take it; if they do not, decide.

Then restate the product in one sentence — "A tool for freelancers to send an
invoice and chase it without leaving the app" — and go straight into Stage 2 in
the same message. Do not send the restatement alone and wait.

If the user already answered these questions in their first message, ask
nothing; go to Stage 2.

## Stage 2 — Feature breakdown

Propose the smallest first version that answers the core loop, in one message
short enough to read without scrolling. This is product design: screens are
chosen by the job they do, not by what would look good on the canvas.

```
<Who> can <core loop> without <the thing they do today>.

Screens:
| Screen | Job | Key content | States |
|---|---|---|---|
| Home | see what needs doing | ... | empty, loading |
| ... | ... | ... | ... |

Data: what each screen shows, and where it comes from. Static sample data for
v1 is fine; say so.
Out of scope for v1: the features deliberately left out, and why.
```

The breakdown is a proposal, not a survey. Keep it to one to five screens for a
first version; three is usually right for an app, one for a tool. Every screen
carries a job in the second column — if the job is "show the other screens", the
screen is navigation, not a screen. Name the states that matter: a list needs an
empty state, a form needs an error state, anything that loads needs a loading
state. Write real copy in the table, not lorem ipsum; the copy is part of the
product.

For a feature change on an existing product, the same table is shorter: the
screens the change touches, what changes on each, the new states, and what stays
as it is. If the change is one line of behaviour, the breakdown is three lines,
and you go straight to design.

## Stage 3 — Feature confirmation

Send the breakdown, then one question with two parts at most: which of these
must be in the first version, and what is missing. Then wait. A confirmation the
user already gave is not asked again, and a "you decide" is an answer: mark your
assumptions in one line — "I'll keep it to these three screens and the empty
state" — and move on.

Fold the answer back into a short agreed scope, in the chat:

```
V1: open an invoice, chase it, see what is overdue.
Not now: settings, team accounts, exports.
```

That list is the contract for the rest of the route. A screen that appears later
without being on it is new scope: add it deliberately, not by accident. If the
user wants a written brief, put this list in a short Markdown file beside the
design file; otherwise the chat is enough, and a stale brief file becomes a
third truth to maintain.

State the order in the same message, as a statement rather than a second
question: "After this I'll design the screens, you approve them, and then the
code." That is the design-first step, delivered without a round trip; Stage 5
below does not ask it again.

## Stage 4 — Design takeover

Announce that you are taking over the screens. Do not ask permission for a step
the user has already asked for; say what you are going to do and start.

Offer the page list, one line per page, and one visual direction in a sentence.
A direction covers the palette, the type scale, the density, the corner radius
and the kind of imagery — enough that the user can say "warmer" or "more
serious". One direction is enough. Two are only useful when the user is visibly
undecided, and a screen of options is not a decision; the canvas is where a
direction becomes real.

If the product already has a design file — the usual case for a feature change —
work in that file. `node design.mjs ls design.html --pages` first, then add or
change only the affected screens and leave the existing pages and tokens alone.
A second file splits the tokens, and the theme stops being one edit.

Otherwise create the file with `node design.mjs new design.html --name home
--title "<the product>"`, then set the tokens before the content: the brand
colour, the neutral surface, the spacing scale and the radius scale. A palette
chosen in the token block is one edit to change later; a palette typed into
forty elements is forty. Use `node design.mjs tokens design.html set
color.accent '#…'` for each token you want.

If the user has a brand — a colour, a logo, a font, an existing app — use it and
say so. If they do not, choose and name the choice in one sentence.

## Stage 5 — Design first

The order is normally stated at Stage 3, in the same message as the feature
confirmation: the screens come first, the user approves them, and then the code
is written. This stage is where that order becomes real — the canvas opens after
it — not a second gate in front of the same question.

- Already stated and answered, or the user asked for a mockup: proceed. Do not
  repeat it as a question.
- Not stated yet (the features were confirmed in a different message, or the
  order got lost): state it once, then proceed.
- The user says "code first": do it. Say once that the screens will be drawn
  from the code, and keep the design file available as the place to adjust
  appearance.
- The user says nothing after the stated order: proceed. Silence is not a
  refusal.

The point is not a ceremony. It is to keep the code from being written twice,
and to give the user one moment where the whole product is a picture instead of
a task list.

## Stage 6 — Canvas

The canvas is where the user approves the work, so it opens before the first
screen, not after the last one. That is what "the design appears gradually"
requires: the user watches the screens arrive, instead of receiving a finished
file.

Start the service in the background — it stays in the foreground by design, so
run it in the background of your shell or tool — and read the URL it prints.
On a POSIX shell that looks like this; where the tool has a background-task
mode, use that instead:

```sh
node design.mjs serve design.html > /tmp/justskill-canvas.log 2>&1 &
# the URL is in /tmp/justskill-canvas.log; the browser opens on its own
```

`serve --json` prints one `{ url, port, file, revision }` line when the output
has to be parsed, and `--no-open` leaves the browser to you; with `--json`,
pass `--open` as well if the browser should still open.

Give the user the URL, and say what is coming first. Then build in this order:

1. The page shell: the file, the root frame, the background and the first token
   set. Run `validate` once so the page loads clean.
2. One screen at a time, in the order of the user's core loop. A new page is one
   `add` whose fragment root is a `<section data-type="page">`; leave `--in`
   out, because a page fragment lands in `<body>`. The file holds every page, so
   this is how the design grows without a rewrite.
3. Between screens, one line: "The invoice list is up — next is the invoice
   itself." The user does not need a report, only to know what they are looking
   at.
4. After each screen, `validate` the file; a screen that refuses is not a screen
   the user can approve.
5. If the canvas closes (tab closed, machine slept past the idle timeout), start
   the service again and give the user the new URL. The design file did not
   disappear.

The canvas watches the file and shows each `add` and `set` as it lands, so the
design grows in front of the user. That means: build with `add` and `set`, in
small steps, even when one big fragment would be faster. The visible steps are
the point — they are also the undo steps.

When a screen needs a photograph and the user supplied none, take one from
`references/images.md` by subject. A solid colour is the honest placeholder when
no catalogue photo fits.

## Stage 7 — UI adjustment

This is the loop the canvas exists for, and it has one teachable handshake. Say
it once, when the canvas opens:

> Select an element on the canvas. Hover outlines the container (solid) and its
> direct children (dashed); click takes the dashed box under the pointer, and
> clicking again goes one rung deeper. Escape goes back up. A row in the layer
> tree selects the same thing. With something selected, press ⌘C (Ctrl+C on
> Windows and Linux) — that copies a pointer to the element, not a screenshot.
> Paste it here and tell me what to change.

What the user pastes is generated by the canvas and looks like this:

```
Use justSkill tools. Current file file:///Users/you/app/design.html. Page id: home. Selected node ids: home__invoice-total
```

Read it as three things: the file to edit, the page the element lives on, and the
element's id. The canvas confirms the copy with a toast. When the selected node
is a page instead of an element, there is no `Page id:` clause: the page is the
selected id.

The file is written as a `file://` URL, because that is what a chat box can
linkify. Every command takes a plain path, so convert it first: drop the
`file://` scheme, percent-decode the rest (`%20` is a space, `%3A` is `:`,
`%2F` is `/`), and on Windows drop the leading `/` before the drive letter —
`file:///c%3A/app/design.html` is `c:/app/design.html`. If the path does not
match the file you have open, the one in the paste wins, because that is the one
the user is looking at.

Then, per paste:

1. Read the element: `node design.mjs show design.html home__invoice-total --json`.
   For a parent or a group, `node design.mjs ls design.html --in home__invoice
   --depth 2` shows what is in it.
2. Choose the smallest op:
   - appearance — `set --style 'font-size:24px;font-weight:700'`
   - text — `set --text "…"`
   - structure — `add`, `move`, `remove`
   - theme — `tokens set color.accent '#…'`
   - a new name — `rename`
3. Apply it, read the receipt, and say what changed in one line: "Total is
   24px and bold now." The receipt is not a report to paste; it is what tells
   you the file holds what you asked for.
4. `validate` after a batch of changes, not after every single one.

The user can also drag, resize and nudge on the canvas; that goes through the
same write funnel and the same file. Both writers re-read first, so an edit you
make while the user is dragging is not lost. If the user drags, do not redo the
change by command; the drag already wrote it.

Some pastes will be thin:

- **A pointer and no request** ("make it better"): make one concrete proposal
  with a reason, and apply it if the user says go. Do not ask three design
  questions instead of making the change.
- **An id that no longer exists**: `ls` the parent and say which ids are there;
  the user can click the element again. Never guess a replacement id silently.
- **A refusal**: read the refusal, not the user. It names what to write instead
  (`grid` becomes a flex row, a one-sided margin becomes the shorthand,
  `position:fixed` becomes `absolute` with `left` and `top`). Tell the user in
  product language and make the change the refusal points to.

Never rewrite the whole file to adjust one property. One op is one undo step,
and the user may be dragging on the canvas while you write.

## Stage 8 — Page sign-off

Before asking for approval, check the work, not the user's patience:

- `node design.mjs validate design.html --json` — zero errors.
- `node design.mjs ls design.html --pages` — every screen on the agreed list is
  there, and no screen is there that was not agreed.
- Every screen on the list has the states the breakdown promised; a list with an
  empty state, a form with an error state.
- The copy is real sentences in the product's language, not placeholder text.
- Images have `alt` text that says what a person sees, and a catalogue photo
  keeps its credit.
- Colours and spacing that repeat come from tokens, so the theme stays one edit.
- The canvas Problems badge is empty (or every entry is known and named).

Then send a short checklist and one question: are these pages approved, and is
anything to be changed? Offer the deliverables the user needs:
`node design.mjs export design.html --all -o dist` for one HTML file per page.
`--all` is HTML; an image is one page at a time —
`node design.mjs export design.html --page home --format png -o home.png`, and
the same with `svg` when the user needs a vector file.

A "looks good" that is followed by "now code it" is approval. A change request
goes back to Stage 7; it is not a rejection of the whole route.

## Stage 9 — Code

The approved file is the spec. Read it as data rather than re-imagining it:

- `node design.mjs ls design.html --pages --json` for the page list, and
  `node design.mjs ls design.html --in <page> --depth 2 --json` for one page's
  element tree.
- `node design.mjs show design.html <id> --json` for one element's exact values.
- `node design.mjs export design.html --all -o dist` for one HTML file per page
  to look at while implementing.

Implement screen by screen, in the approved order, in the user's stack. Read the
repository to learn the stack; if it is genuinely ambiguous, ask once rather
than inventing a framework:

- Map the token names (`--color-accent`, `--space-md`, `--radius-card`) onto the
  stack's theme variables. The token block is the design's smallest API; keeping
  it means a later colour change stays one edit.
- Map `data-id` onto component names, test ids or selectors. They are stable,
  human names chosen for how the screen reads.
- Match the approved layout with flex and `gap`, not with margin tweaks and not
  with a rewrite in a different visual language. The code is not the place to
  improve the design; the design file is.
- After each screen, compare the running result with the design — the canvas or
  the exported page next to the app. List the mismatches, then fix the code or
  the design, deliberately.
- When implementation reveals a missing screen or state, go back to Stage 6 and
  design it first. A state invented only in code is a state the user never
  approved.
- Keep the design file in the repository and commit it with the code. It is the
  reference for the next feature request.

A later feature request returns to Stage 2. Change the design first, get the
screen approved, then change the code — the file stays the truth for as long as
the product lives.

## Keeping it soft

The route is a default, not a gate. The ways it stops being soft are worth
naming:

- **Opening with a questionnaire.** Eight questions before anything happens is
  not product design; ask the two or three that change the screens.
- **Asking permission to begin.** "Shall I break down the features?" is a step
  the user already asked for. Do it, then let them redirect.
- **Re-asking a confirmation.** Once the user has answered, the next question is
  about the work, not the answer.
- **Building ten screens for a three-screen first version.** Scope is set at
  Stage 3 and stays set until someone changes it on purpose.
- **Opening the canvas after the design is done.** The user then reviews a
  finished surprise instead of watching the product appear.
- **Writing the whole file in one rewrite.** It removes the gradual reveal and
  the per-step undo the canvas gives the user.
- **Forcing the route on a bug fix or a one-line edit.** An edit is an edit.
- **A wall of CSS in the chat.** The user is reading a product, not a diff. One
  line per change is enough.

Match the user's pace. A user who moves fast can approve three stages in one
message; a user who thinks slowly gets smaller steps. The route is there to be
walked, not recited.

## One conversation, end to end

A compressed version of the route, to show the size of each step:

> **User:** I want a small tool for freelancers to manage invoices. Create,
> chase, see what got paid.
>
> **Agent:** A tool where a freelancer sends an invoice, chases it, and sees
> what is overdue — without leaving the app. First version: Home (what needs
> doing today), Invoice (one invoice and its status), Chase (the reminder).
> Empty and loading states for the list; sample data, no backend yet. Out of
> scope: settings, teams, exports. Is that the first version, or is something
> missing?
>
> **User:** That's it. Design first, then code.
>
> **Agent:** I'm taking the screens now — the three above, one direction: warm
> neutrals, one accent for money, a 16px type scale, 12px cards. Screens first,
> your approval, then the code. Opening the canvas.

The agent creates the file, starts the canvas, and builds page by page. The user
selects a total, presses ⌘C, pastes the pointer, and says "make this bigger and
bold". The agent runs `show`, applies one `set`, and says what changed. When the
screens validate clean it asks for approval, exports the pages, and implements
them with the file as the spec.
