# Debug quality workflow

This example checks a request, maps the repair work, and merges the result
before producing a final report.

<!-- yolo:workflow-structure:start -->
- id: input-request
  kind: input
  label: Request
  step: steps/input/STEP.md
- id: agent-diagnose
  kind: agent
  label: Diagnose
  step: steps/diagnose/STEP.md
- id: condition-quality
  kind: condition
  label: Quality gate
  step: steps/quality/STEP.md
- id: map-agent-repair
  kind: mapAgent
  label: Repair findings
  step: steps/repair/STEP.md
- id: merge-report
  kind: merge
  label: Merge report
  step: steps/merge/STEP.md
- id: output-report
  kind: output
  label: Final report
  step: steps/output/STEP.md
<!-- yolo:workflow-structure:end -->

<!-- yolo:workflow-topology:start -->
{
  "revision": 1,
  "nodes": [
    {
      "id": "input-request",
      "kind": "input",
      "label": "Request",
      "stepPath": "steps/input/STEP.md",
      "position": { "x": 64, "y": 120 }
    },
    {
      "id": "agent-diagnose",
      "kind": "agent",
      "label": "Diagnose",
      "stepPath": "steps/diagnose/STEP.md",
      "position": { "x": 320, "y": 120 },
      "stage": "analysis",
      "modelId": "default",
      "outputSchema": { "type": "object" }
    },
    {
      "id": "condition-quality",
      "kind": "condition",
      "label": "Quality gate",
      "stepPath": "steps/quality/STEP.md",
      "position": { "x": 576, "y": 120 },
      "gateType": "ifElse",
      "predicate": "findings.length > 0"
    },
    {
      "id": "map-agent-repair",
      "kind": "mapAgent",
      "label": "Repair findings",
      "stepPath": "steps/repair/STEP.md",
      "position": { "x": 832, "y": 48 },
      "stage": "repair",
      "modelId": "default"
    },
    {
      "id": "merge-report",
      "kind": "merge",
      "label": "Merge report",
      "stepPath": "steps/merge/STEP.md",
      "position": { "x": 1088, "y": 120 }
    },
    {
      "id": "output-report",
      "kind": "output",
      "label": "Final report",
      "stepPath": "steps/output/STEP.md",
      "position": { "x": 1344, "y": 120 },
      "outputSchema": { "type": "object", "required": ["summary"] }
    }
  ],
  "edges": [
    { "id": "edge-input-diagnose", "source": "input-request", "target": "agent-diagnose" },
    { "id": "edge-diagnose-quality", "source": "agent-diagnose", "target": "condition-quality" },
    { "id": "edge-quality-true", "source": "condition-quality", "target": "map-agent-repair", "branch": "true", "label": "findings" },
    { "id": "edge-quality-false", "source": "condition-quality", "target": "merge-report", "branch": "false", "label": "clean" },
    { "id": "edge-repair-merge", "source": "map-agent-repair", "target": "merge-report" },
    { "id": "edge-merge-output", "source": "merge-report", "target": "output-report" }
  ]
}
<!-- yolo:workflow-topology:end -->
