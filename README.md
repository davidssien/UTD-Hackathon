# Egress

Current build status and decisions: [Plan.md](Plan.md). Backend handoff and verified NVIDIA/Maincloud results: [docs/BACKEND_HANDOFF.md](docs/BACKEND_HANDOFF.md). Preserved frontend references: [docs/UI_REFERENCE.md](docs/UI_REFERENCE.md). Blender and 3D workflow: [docs/3D_ASSET_PLAN.md](docs/3D_ASSET_PLAN.md).

The product direction is one 3D scene with top-down-only editing, transitioning to isometric/freecam outside Edit. The current ExitCraft frontend has not yet adopted all of those decisions; Plan.md records the agreed direction.

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
