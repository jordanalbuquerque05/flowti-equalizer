# ─── Stage: Build ────────────────────────────────────────────────────────────
FROM oraclelinux:8-slim AS base

# Install Node.js 20 from Oracle repo + system utilities
RUN microdnf install -y oracle-release-el8 && \
    microdnf module enable -y nodejs:20 && \
    microdnf install -y \
      nodejs \
      npm \
      openssh-clients \
      libnsl \
      libaio \
      bc \
      curl \
      tar \
      gzip \
      mysql \
    && microdnf clean all

# Install Oracle Instant Client (Basic + SQL*Plus) from official Oracle repo
RUN microdnf install -y oracle-instantclient-release-el8 && \
    microdnf install -y \
      oracle-instantclient-basic \
      oracle-instantclient-sqlplus \
    && microdnf clean all

# Configure Oracle Instant Client library path
RUN echo /usr/lib/oracle/21/client64/lib > /etc/ld.so.conf.d/oracle-instantclient.conf && \
    ldconfig

# Set Oracle env vars so sqlplus works out of the box
ENV ORACLE_HOME=/usr/lib/oracle/21/client64
ENV PATH=$PATH:$ORACLE_HOME/bin
ENV LD_LIBRARY_PATH=$ORACLE_HOME/lib

# ─── App ─────────────────────────────────────────────────────────────────────
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install Node dependencies (production only, skip devDeps)
RUN npm ci --omit=dev

# Copy the application source
COPY . .

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
