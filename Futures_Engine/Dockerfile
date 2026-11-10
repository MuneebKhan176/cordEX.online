# Build the Futures C++ TCP engine on Linux.
FROM debian:bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ libasio-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY Futures_Engine/futures_engine.cpp ./futures_engine.cpp

RUN g++ -std=c++20 -O2 -pthread futures_engine.cpp -o /usr/local/bin/futures-engine

# Keep the runtime image small.
FROM debian:bookworm-slim
COPY --from=build /usr/local/bin/futures-engine /usr/local/bin/futures-engine

EXPOSE 9001
CMD ["/usr/local/bin/futures-engine"]
