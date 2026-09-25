# @rendered-review/design-tokens

The Rendered Review design tokens as CSS custom properties: colours (`light-dark()` pairs that follow
`color-scheme`, or `<html data-theme="light|dark">`), fonts, type sizes, reading measure, radii and shadow.

```css
@import "@rendered-review/design-tokens/tokens.css";
```

Only app-agnostic tokens live here. Layout sizes that belong to the review app's chrome (top bar, toolbar,
sidebar and rail widths, document gutter) stay in `apps/web/src/ui/styles.css`.
