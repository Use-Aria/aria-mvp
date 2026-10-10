# Aria syllabus parser (V2-08). Same image runs locally (docker compose) and on Cloud Run.
# Base pinned by digest (multi-arch index for python:3.13-slim, looked up 2026-10-10).
FROM python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080

WORKDIR /srv

# Full transitive closure with hashes; wheels only (no compilers in the image).
COPY requirements.lock ./
RUN pip install --no-deps --require-hashes --only-binary=:all: -r requirements.lock

COPY app/ ./app/
# Precompile so a read-only root filesystem never needs to write __pycache__.
RUN python -m compileall -q app \
 && useradd --uid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app

USER 10001
EXPOSE 8080
CMD ["python", "-m", "app"]
