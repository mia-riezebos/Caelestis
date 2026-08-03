# Recon: wplace colour palette

Type: research
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/10

## Question

What is the exact wplace palette, and how should transparency and unavailable colours be handled?

- The full ordered colour list with exact RGB values, and wplace's own index for each.
- Free vs premium/paid colours — does the split matter for validation or for progress accounting?
  (A template using a colour a given member cannot place is a real UX problem.)
- How transparency is represented on the canvas, and which index if any is reserved.
- Is the palette stable, or does it grow? If it grows, uploads validated today must not break later.

Output should be a machine-readable list we can commit as the validation source of truth, since
upload rejects any pixel outside it.
