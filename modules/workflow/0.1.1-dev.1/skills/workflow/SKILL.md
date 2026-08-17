---
name: workflow
description: Create, inspect, and maintain Markdown-first visual workflows made of WORKFLOW.md and ordered STEP.md files.
---

# Workflow

Use `workflow_read` before reasoning about an existing workflow. Use
`workflow_create` only when the user asks to create a new workflow.

`WORKFLOW.md` contains the human execution order and validated topology.
Each listed node points to its own `STEP.md`. Preserve node ids, kinds,
edges, condition gates, branch labels, and positions when editing.

Never overwrite an existing workflow. The visual editor authors the files;
execution stays in the current Session.

See `examples/debug-quality-workflow/WORKFLOW.md` for the file format.
