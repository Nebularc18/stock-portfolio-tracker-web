ARG BUILDPLATFORM

FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend_builder

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FRONTEND_STATIC_DIR=/app/frontend-dist

WORKDIR /app

RUN groupadd --system appuser \
    && useradd --system --gid appuser --create-home --home-dir /home/appuser appuser \
    && mkdir -p /app /app/frontend-dist \
    && chown -R appuser:appuser /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=appuser:appuser backend/ /app
COPY --from=frontend_builder --chown=appuser:appuser /frontend/dist /app/frontend-dist

EXPOSE 8000

USER appuser

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
