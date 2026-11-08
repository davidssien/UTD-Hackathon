# ExitCraft

The web application lives in [`frontend/`](frontend/). This includes the editor, assets, tests, dependencies, and Next.js configuration.

## Run the frontend

```sh
npm install
npm run dev
```

Open [the local preview](http://localhost:3000/).

## Validate

Run from `frontend/`:

```sh
npm test
npx tsc --noEmit
npm run build
```

See the [frontend guide](frontend/README.md) for editor controls and implementation details.

The root npm workspace also contains the shared `packages/`, backend `services/`, and `spacetimedb/` module. The backend reference UI is available at `/dev`. Run `npm run test:backend` and `npm run typecheck:backend` from the repository root.
