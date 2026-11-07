# Design software after the app

*By [西瓜飞船](https://xhslink.cn/o/42rk3ZEEuzY)*

*Notes on software as a skill — and on what a design tool becomes when the agent
does the drawing.*

中文版：[docs/zh/paradigm.md](zh/paradigm.md)

## The loop kept breaking in the same place

I kept running into the same failure when I asked an agent to design a product
screen. The model could write the markup. The tools could not accept it. Every
round trip went through a screenshot or an export, and every round trip lost
something: a spacing value, a state, the reason a card was there. The agent was
writing into a format it could not check, and the design was living in a place
the code could not read.

Design tools are built for a person in a browser, and they are very good at
that. But when the agent becomes the one doing the work, the app is in the way:
the design is in the tool's document, the agent reaches it through a plugin or a
screenshot, and the handoff to code is a second translation. Nothing in that
chain can be refused by a machine. You find out in the browser.

The other direction fails differently. Prompt an app builder and you get a
running app — but the design is a side effect of the code. There is nothing to
review before the code exists, nothing to diff when it changes, and no durable
specification to hold the next change against.

Both loops skip the same artifact: a design that is simple enough for a model to
write well, strict enough for a tool to check, and plain enough to live in your
repository.

That artifact is what this project is about.

## Two bets

**The design artifact should be plain text the machine can check.** Not a
private format with a renderer — the markup itself. A format that can accept a
declaration, refuse it with a reason, and keep one intent to one spelling is a
format an agent can iterate inside without a human watching every step.

**The tool should be a skill, not an app.** An app has an install, an account, a
cloud, an update channel, a process to keep alive. A skill is a directory an
agent reads when it needs it. The agent opens the tool when the work starts and
puts it down when the work ends. I call that *on demand*: 随用随开.

The two bets fit together. If the artifact is a file, the tool does not need to
own it, host it, or keep it warm. If the tool is a skill, there is nothing to
install before the first design and nothing to migrate when the design is done.

## The artifact is a file, not a document

Open the design in a browser and it is there. No renderer, no app, no account.
It is a valid HTML file with inline styles, one element per node, and a page is
a `<section>` — so the same artifact that the agent assembles is the artifact a
person can double-click.

That has three consequences I care about:

- **It diffs.** A change to a heading is a line in a diff, not a frame in a
  recording. The design can be reviewed in a pull request, beside the code that
  implements it.
- **It distributes.** Send the file. Put it on a disk. Attach it to a ticket. The
  recipient does not need this tool, or any tool.
- **It is one file per design, not one file per screen.** A whole product is
  pages in the same file, which is what makes the diff and the distribution
  claims survive scale.

What the tool adds is not a container. It is a set of guarantees around the
file: every declaration is accepted or reported, the file is kept in canonical
form, a file nobody edited comes back byte for byte, and every element has a
`data-id` so an edit is a byte range rather than a rewrite.

## The tool is a skill, not an app

| Not | What it means |
|---|---|
| No MCP server | No process to start, no client config to edit, no protocol between the model and the file. The model runs the same command a person types. |
| No app to install | No application to download, update or keep running. The skill is a directory; the canvas is a local page the CLI serves on demand and closes when you are done. |
| No account | No sign-in, no plan, no cloud copy, no usage report. The design file is the only state, and it lives in your checkout. |
| No build step | The source is what runs. Edit the checkout and the installed skill follows. |
| No `npm install` | No dependencies and no lockfile. Nothing to install, audit or update. |

Each absence removes a way to fail before the design exists — a process that did
not start, a session that expired, a package that resolved to something else, a
build older than its source. What is left is an HTML file you can open, diff and
commit, and a command set that will not let it be wrong in silence.

## The tool is source, not a binary

An app hands you a feature set. A skill hands you the tool: the CLI, the format,
the canvas and the validator are files in a directory, and the agent that runs
them can also read them. That changes what customisation means. In an app, a need
the vendor did not anticipate becomes a plugin, a feature request or a
workaround. Here it becomes a diff: the agent reads the command that needs to be
different and changes it, for this project, today.

That is not a small convenience. It is the difference between a tool and a
material. Every project that uses this skill can end up with a slightly
different one — a token naming rule, an extra validator, a canvas that shows the
things this team cares about — and all of those variants still share the same
format, so files stay portable between them. One base, endless variants.

This is what I mean by AI-native, beyond "a model writes the markup": the
frontier is not only that agents can use software, it is that software can be
read, forked and changed by the agent that uses it. A binary can be used; a
source can be grown. When the tool is source, the tool stops being the
bottleneck of what it can become.

## What stays human

A fully agent-driven tool can still be a tool that overrides you. I did not want
that. The agent makes the design decisions; the person keeps the decisions that
matter:

- **Approval.** The agent proposes screens and asks; it does not ship them
  silently.
- **Direction.** Point at an element on the canvas, copy the pointer, say what to
  change. The agent reads that node from the file and applies one operation —
  one at a time, each with a receipt.
- **Review.** The design is a file in the repository. It can be reviewed in a
  pull request, reverted, diffed, and compared against the code that implements
  it.

That is the shape I want from a new generation of design software: the machine
does the work, the person keeps the judgment. Not a chat that produces pixels,
and not an app that pretends the agent is a mouse.

## In practice: the loop

The nine stages are how that division of labour shows up in a real session. The
agent owns 4 through 8 — the part with a format, a CLI and a canvas. Stages 1–3
are the product conversation; stage 9 is code, which the agent writes in your
repository and which this format does not cover.

| # | Stage | What the agent does | What you do |
|---|---|---|---|
| 1 | Idea | Restates the product in one sentence and asks only the questions that change the screens. | Answer, and correct the restatement if it is wrong. |
| 2 | Feature breakdown | Sketches the smallest first version: the core loop, 1–5 screens with a job each, the empty, loading and error states, the data, and what is explicitly out of scope. | Read it, and name what is missing or out of scope. |
| 3 | Feature confirmation | Asks one clear confirmation question. You can add or remove features; after that it does not ask again. | Confirm, add, or remove. |
| 4 | Design takeover | Says it will design the screens, proposes the page list and one visual direction, then creates the design file and its tokens — or opens the existing file when the product already has one. | Push back on the page list or the direction, or let it proceed. |
| 5 | Design first | States the order once: design → approval → code. | — |
| 6 | Canvas | Opens the local canvas, then builds the pages one by one, so the design appears gradually in the open canvas. | Keep the canvas open and watch the screens arrive. |
| 7 | UI adjustment | Reads the node you point at from the file and applies one op at a time: `set`, `move`, `add`, `remove`, or `tokens`. | Select an element on the canvas, press ⌘C (Ctrl+C on Windows/Linux), paste the copied pointer into the agent chat, and say what to change. You can also drag on the canvas. |
| 8 | Page sign-off | Validates, walks the checklist — screens, states, copy, images, tokens — and asks for explicit approval. | Approve, or send it back. |
| 9 | Code | Implements the approved design in your stack, screen by screen; the validated design file is the spec. | Review the code. |

The route is soft guidance, not a required gate: the agent starts without asking
permission, every stage can be skipped, "just do it" wins, and the breakdown
scales to the risk. Two entry points start it — a new product idea, and a request
to add or change a feature, even when the word "design" is not used. A concrete
edit inside an existing design skips the route.

## What this costs

The format is deliberately narrow: flexbox, absolute positioning, a fixed
property set, inline SVG, one run of text per element. No grid, no fixed
positioning, no animation, no responsive breakpoints, no rich text, no
multiplayer, no component library.

That narrowness buys the thing the whole project is for: the agent can be refused
by name instead of discovered in the browser, and the artifact stays small enough
to read. But it is a real cost, and some screens belong in a different tool. If
the design needs a live component system, prototype interactions, or a team
drawing at the same time, a design app is still the right answer.

The bet can also be wrong in a deeper way: if interfaces become something agents
assemble and nobody reviews, the review surface this project is built around
stops mattering. I do not think that is where this goes — the more the agent
builds, the more the point of review moves from drawing to approving — but it is
the assumption to watch.

## Where I think this goes

If a tool can be a skill, most tools that exist to produce a file can be a skill.
The app was never the value; the artifact is. What changes when the tool is a
directory an agent reads on demand is not just distribution — it is that the
artifact becomes the interface between the agent, the person and the code.

This repository is one instance of that idea, chosen because design is where I
could test it end to end: a format agents can check, a canvas humans can review,
and an HTML file that survives both. The same shape fits documents, charts, and
anything else whose real output is a file someone has to trust.
