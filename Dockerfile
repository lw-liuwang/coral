FROM python:3.9-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/
COPY routes/ routes/
COPY templates/ templates/
COPY static/ static/
COPY tools/ tools/
COPY config.example.yaml config.yaml

ENV CORAL_DATA_DIR=/data
VOLUME /data
EXPOSE 8300

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8300"]
