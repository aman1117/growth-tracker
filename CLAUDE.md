## Engineering Guidelines (must follow)

### 1) Code quality
- Write maintainable, scalable, modular code with clear separation of concerns.
- Prefer small pure functions, typed interfaces, and single-responsibility components.
- Avoid “clever” code; optimize for readability.

### 2) Logging and debuggability
- Add structured logs at important boundaries:
  - navigation events, API calls, state transitions, errors, retries, and user actions.
- Logs must be:
  - meaningful (no noise), consistent tags, and safe (no secrets / PII).
- For failures: log context + error cause + recovery action.

### 3) Edge cases and robustness
- Enumerate edge cases up front (as a checklist) before coding.
- Handle: loading, empty state, partial data, network errors, timeout, auth errors, race conditions, double-clicks, back/forward navigation, slow devices, and offline/unstable network.
- Ensure graceful fallbacks and no UI dead-ends.

### 4) No breaking changes
- Do not change existing public APIs, route paths, or component props unless explicitly told.
- Keep current behavior unless improving it safely.
- If a behavior must change, document it clearly and include migration notes.

### 5) UI/UX and design system
- UI must remain concise, consistent, and aligned with our glass-morphism style in both light and dark mode.
- Use existing theme tokens, spacing, typography, and motion guidelines.
- Respect accessibility: keyboard navigation, focus states, aria labels, contrast.

### 6) Reusable components first
- Prefer existing generic/shared components over custom one-offs.
- If a new component is needed, make it generic and reusable with clear props and docs.
- Avoid duplicating patterns (buttons, modals, toasts, loaders, cards).

### 7) Plan + TODOs + verification (required output format)
- Start with a brief plan and a TODO checklist.
- Implement every TODO completely.
- Include:
  - files changed list,
  - key decisions,
  - how to verify manually (step-by-step),
  - any risks/assumptions.