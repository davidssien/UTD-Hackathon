# ExitCraft

The web application lives in [`frontend/`](frontend/). This includes the editor, assets, tests, dependencies, and Next.js configuration.

## Run the frontend

```sh
cd frontend
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
