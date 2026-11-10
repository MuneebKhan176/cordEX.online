# Build the Spot C++ TCP engine on Linux.
FROM debian:bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ libasio-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY Spot_Engine/trade_engine.cpp ./trade_engine.cpp

RUN g++ -std=c++20 -O2 -pthread trade_engine.cpp -o /usr/local/bin/spot-engine

# Keep the runtime image small.
FROM debian:bookworm-slim
COPY --from=build /usr/local/bin/spot-engine /usr/local/bin/spot-engine

EXPOSE 9000
CMD ["/usr/local/bin/spot-engine"]
