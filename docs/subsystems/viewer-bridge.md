# Subsystem: FKLD Viewer Bridge

The viewer bridge connects the TypeScript shell to the embedded FKLD viewer
iframe.

## Files

| File | Role |
| --- | --- |
| `src/view/viewer-frame.ts` | Shell-side iframe wrapper and postMessage bridge. |
| `public/viewer/index.html` | Embedded viewer application. |
| `fkld/bridge.coffee` | FKLD bridge logic reused by the viewer/tooling. |
| `fkld/spec.coffee` | FKLD extension key registry. |

## Message Contract

Shell to viewer:

```ts
{
  type: "kirigamizer:load",
  fkld: FoldFile,
  name: string
}
```

Viewer to shell:

```ts
{
  type: "kirigamizer:viewer-ready"
}
```

```ts
{
  type: "kirigamizer:viewer-loaded",
  fkld: FoldFile,
  name: string
}
```

## Shell Behavior

`ViewerFrame`:

- creates the iframe;
- points it at `./viewer/index.html`;
- buffers `kirigamizer:load` until the viewer posts ready;
- records the currently displayed FKLD/FOLD object;
- notifies the controller when the viewer loads a model by any path.

The recorded current object matters because 3D Sim folds what the viewer is
showing, not necessarily what the convert panel last loaded.

## Data Flow

```text
AppController.viewer.show(fkld, name)
  -> ViewerFrame queues or posts message
  -> public/viewer/index.html receives kirigamizer:load
  -> viewer renders FKLD/FOLD
  -> viewer posts kirigamizer:viewer-loaded
  -> ViewerFrame.current() updates
  -> SimModal enablement updates
```

## Extension Rules

- Add new viewer messages as explicit string literal contracts.
- Keep viewer readiness buffering inside `ViewerFrame`.
- Do not let `AppController` talk to `iframe.contentWindow` directly.
- Do not parse FKLD metadata in the iframe if the shell already needs it;
  parse in model presenters.

## Troubleshooting

If the viewer does not update:

1. Confirm `kirigamizer:viewer-ready` was received.
2. Confirm `ViewerFrame.pending` is flushed after ready.
3. Confirm payload key is `fkld`, not `fold` or `object`.
4. Confirm the viewer posts `kirigamizer:viewer-loaded` after loading.

If 3D Sim folds an old model:

1. Check `ViewerFrame.current()`.
2. Check `kirigamizer:viewer-loaded` messages from iframe-originated loads.
3. Check controller provider fallback order.

