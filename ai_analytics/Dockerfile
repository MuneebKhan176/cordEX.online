FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN addgroup --system app \
    && adduser --system --ingroup app app

COPY ai_analytics/requirements.txt ./ai_analytics/requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r ai_analytics/requirements.txt

COPY --chown=app:app ai_analytics ./ai_analytics

USER app

EXPOSE 8001

CMD ["uvicorn", "ai_analytics.app:app", "--host", "0.0.0.0", "--port", "8001"]
