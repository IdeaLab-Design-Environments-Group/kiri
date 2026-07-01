# Subsystem: Modal Lifecycle

Modal views provide secondary workflows without putting workflow logic in the
controller.

## Files

| File | Modal | Purpose |
| --- | --- | --- |
| `src/view/sim-modal.ts` | `SimModal` | 3D fold simulation modal. |
| `src/view/export-modal.ts` | `ExportModal` | SVG cut/score export modal. |
| `src/view/sim-canvas.ts` | `SimCanvas` | Lazy-loaded rendering surface used by `SimModal`. |
| `src/controller/app-controller.ts` | providers | Supplies modal providers and enabled state. |

For the export modal's specific SVG/STL provider routing, see
`export-modal.md`.

## Shared Pattern

Both modals use:

1. trigger button mounted into header actions;
2. `setProvider(...)`;
3. `setEnabled(...)`;
4. open overlay;
5. pull fresh payload on open;
6. close on overlay click or Escape.

Providers are functions, not stored payloads. This ensures the modal uses the
latest viewer/store state.

## SimModal Lifecycle

```text
trigger click
  -> open()
  -> lazy import SimCanvas
  -> provider()
  -> canvas.setScene(scene)
  -> apply fold slider
  -> canvas.start()
```

On close:

```text
overlay hidden
canvas.stop()
```

Reset rebuilds from provider, not from stale scene data.

## ExportModal Lifecycle

```text
trigger click
  -> open()
  -> provider()
  -> render previews
  -> enable downloads
```

Downloads:

- ZIP: registered cut and score SVG files.
- Combined SVG: single color-coded file.
- Tiles STL: separated 3D-printable tiles.

The modal creates object URLs only at download time and revokes them
immediately after click.

## Enablement

Controller owns enablement:

- Sim enablement depends on `canSimulate(source)`.
- Export enablement depends on presence of a fold source.

Views should not recompute these policies.

## Testing

Modal tests should assert:

- trigger starts disabled;
- `setEnabled` toggles trigger;
- provider called on open;
- empty provider shows a useful status;
- close hides overlay and stops resources;
- download buttons are disabled without payload.
