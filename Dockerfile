FROM python:3.12-slim
WORKDIR /app
COPY server.py planner.py walkgraph.py ./
COPY static ./static
ENV PYTHONUNBUFFERED=1 PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "python server.py --host 0.0.0.0 --port ${PORT}"]
