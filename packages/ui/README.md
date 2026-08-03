# @wts/ui

Web components shared by the userscript and the SvelteKit frontend.

**Empty on purpose.** How these are authored is an open decision — Svelte compiled to custom
elements, or Lit — and the answer changes every file in here.

See [packages/ui — shared web components #20](https://github.com/mia-riezebos/wplace-template-server/issues/20).

Two constraints already hold whichever way it goes:

- **Shadow DOM is mandatory.** These components mount inside wplace's own DOM, and wplace ships
  Tailwind + DaisyUI. Without isolation the styles collide in both directions.
- **Guard `customElements.get()` before defining.** Userscripts get injected twice, and other
  wplace userscripts exist.
