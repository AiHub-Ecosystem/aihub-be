FROM alpine:3.22

RUN apk add --no-cache iptables ip6tables
COPY docker-user-guard.sh /usr/local/bin/docker-user-guard
ENTRYPOINT ["/bin/sh", "/usr/local/bin/docker-user-guard"]
