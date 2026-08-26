FROM python:3.13-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8765 \
    DATA_DIR=/app/data

WORKDIR /app
RUN addgroup -S research && adduser -S research -G research \
    && mkdir -p /app/data && chown -R research:research /app

COPY --chown=research:research server.py /app/server.py
COPY --chown=research:research static /app/static

USER research
EXPOSE 8765
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8765/api/bootstrap || exit 1

CMD ["python", "server.py"]

