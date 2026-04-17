# Project Notes

## Overview

- This project is a Docker app for a stock portfolio tracker.
- Stack: React 18 + TypeScript + Vite frontend, FastAPI + SQLAlchemy backend, PostgreSQL 15 database.
- The root `Dockerfile` builds the frontend and serves the built assets from the FastAPI app on port `8000`.
- The app has `frontend` and `backend` directories. Check both sides before making cross-cutting changes.
- A remote server is available on the local network at `http://10.11.18.163:8080/` if you need to inspect live data or compare behavior.

## Running Locally

- Copy `.env.example` to `.env` before running locally; Docker Compose and the backend both read the root `.env`.
- Start the app with `docker compose up -d --build`.
- Local app/API/docs:
  - App and API: `http://localhost:8000`
  - API docs: `http://localhost:8000/docs`
- `docker-compose.yml` exposes:
  - app: host `8000` -> container `8000`
  - postgres: host `5432` -> container `5432`
- Persistent Docker volumes are used for Postgres data, backend cache data, and static/logo data.

## Development

- Frontend code lives in `frontend/src`; frontend API calls use same-origin `/api`.
- Backend code lives in `backend/app`; routers are in `backend/app/routers` and services are in `backend/app/services`.
- Backend startup validates auth-related env vars including `DEFAULT_USERNAME`, `DEFAULT_PASSWORD`, `GUEST_USERNAME`, and `AUTH_TOKEN_SECRET`.
- Do not commit real `.env` secrets or production credentials.
- External market data integrations include Yahoo Finance/yfinance, Finnhub, Marketstack, exchange-rate providers, Brandfetch/logo fetching, and Avanza mappings. Avoid excessive live refreshes because data sources may rate limit.

## Checks

- Frontend:
  - `cd frontend`
  - `npm test`
  - `npm run build`
- Backend tests are under `backend/tests` and use `pytest`.
- If running backend tests outside Docker, make sure Python dependencies from `backend/requirements.txt` and any test runner dependencies are installed.

## Database

- Schema migrations are plain Python scripts in `backend/migrations`, not Alembic.
- Run migrations through the app container when using Docker, for example:
  - `docker compose exec app python migrations/20260317_add_stocks_position_entries.py upgrade`
- Validate migrations on a staging copy first when they touch production data, especially timezone and position-entry migrations.

## Working Guidelines

- Prefer using the existing `Dockerfile` and `docker-compose.yml` when building, running, or debugging.
- Keep changes scoped to the task and avoid unrelated refactors.
- Preserve the existing split between frontend UI, frontend services, backend routers, and backend services.
