- Use shadcn as visual/design reference. Do not copy implementation directly unless intentionally choosing compatible components.
- Use shadcn design system e.g. spaces, font sizes, colors, shadows, borders etc.
- Use shadcn b38BALLhg preset as UI reference.
- Local shadcn reference app: `/tmp/pi-web-shadcn-ref` (Next.js + shadcn CLI, initialized with the `b38BALLhg` preset). Use it to inspect generated components or run `npx shadcn@latest add <component>` when comparing implementation details.
- Use lucide icons for icons.

## Browser UI primitives

Avoid visible native browser UI primitives when a shadcn-like component would provide better UX or visual consistency.

Do not use:
- `alert`, `confirm`, or `prompt`; use custom modals/dialogs instead.
- Native `<select>` / `<option>`; use or build a shadcn-like select/listbox/combobox instead.
- Native `<dialog>`; use custom modal/dialog UI instead.
- Native `<details>` / `<summary>`; use or build a shadcn-like collapsible/disclosure instead.
- Visible native checkbox/radio/switch controls; use or build shadcn-like checkbox/switch controls instead.
- Native `datalist`, popover, date/time/color/range controls unless intentionally approved.

Allowed exceptions:
- Styled text inputs, password/search inputs, and textareas.
- Hidden `input type="file"` behind a custom button; native OS file picker is unavoidable.
- Browser APIs that do not show native UI, e.g. clipboard APIs.

