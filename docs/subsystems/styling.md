# Styling

This subsystem covers the global CSS surface used by the app shell, panels,
viewer area, and modal experiences.

## Files

| File | Responsibility |
| --- | --- |
| `src/styles.css` | Global app stylesheet and component class definitions. |
| `src/view/*.ts` | View components that emit class names consumed by the stylesheet. |
| `index.html` | Mount point and global document shell. |

## Styling Model

The app currently uses one global stylesheet rather than CSS modules or
component-scoped styles. Class names are therefore part of the view contract.

Guidelines:

| Rule | Reason |
| --- | --- |
| Keep classes semantic. | Tests and docs can reason about UI roles. |
| Group styles by subsystem. | App shell, controls, metadata, viewer, modal, and export styles should stay findable. |
| Avoid one-off inline styles in view code. | View modules should describe structure, not visual rules. |
| Preserve responsive behavior when changing layout. | The viewer and panels must work on desktop and narrow screens. |

## Main Style Areas

| Area | Typical Classes |
| --- | --- |
| App shell | Header, page grid, side panels, status blocks. |
| Input/drop zone | File picker, drag/drop affordances, conversion controls. |
| Metadata | Derived facts, FKLD metadata, validation summaries. |
| Viewer | iframe frame, current-model state, viewer fallback messaging. |
| Simulation modal | Modal shell, canvas container, control rows. |
| Export modal | SVG previews, layer controls, download actions. |

## View Contract

View components in `src/view/` should emit stable, semantic class names and
delegate presentation to `src/styles.css`.

If a view needs new visual state:

| Step | Action |
| --- | --- |
| 1 | Add a semantic class or data attribute in the view module. |
| 2 | Add the visual rule in `src/styles.css` near related styles. |
| 3 | Keep controller logic out of CSS state decisions. |
| 4 | Add or update tests if the DOM contract changed. |

## Modal Styling

Simulation and export modals share lifecycle concepts but have different
content needs. Keep shared modal shell styles generic and content-specific
styles under simulation/export sections.

Avoid coupling modal CSS to service-layer names. CSS should reflect UI role,
not the TypeScript function that opened the modal.

## Change Checklist

Before merging styling changes:

| Check | Reason |
| --- | --- |
| Desktop layout still shows controls and viewer without overlap. | The primary workflow is model conversion and inspection. |
| Narrow layout keeps modals usable. | Export/simulation dialogs must remain reachable. |
| Focus and button affordances remain visible. | Keyboard and accessibility behavior depend on it. |
| Class names still match view tests. | View tests often assert structure through selectors. |

