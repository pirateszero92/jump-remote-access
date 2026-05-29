FROM guacamole/guacd:1.5.5

USER root

WORKDIR /app

RUN apk add --no-cache \
    nodejs \
    npm \
    python3 \
    py3-pip \
    && rm -rf /var/cache/apk/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:/opt/guacamole/sbin:${PATH}"
ENV LD_LIBRARY_PATH="/opt/guacamole/lib"
RUN pip install --no-cache-dir websockify==0.13.0

COPY package.json ./
RUN npm install --omit=dev

COPY . .
COPY docker/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 8080
EXPOSE 6080

CMD ["sh", "/usr/local/bin/start.sh"]
