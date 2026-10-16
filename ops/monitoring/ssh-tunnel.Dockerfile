FROM alpine:3.22

ARG AIHUB_MONITORING_UID_GID=1004:1004

# ssh needs a passwd entry when Compose runs it as the host-matched numeric UID.
RUN tunnel_uid="${AIHUB_MONITORING_UID_GID%:*}" \
    && tunnel_gid="${AIHUB_MONITORING_UID_GID#*:}" \
    && addgroup -S -g "$tunnel_gid" tunnel \
    && adduser -S -D -H -u "$tunnel_uid" -G tunnel tunnel \
    && apk add --no-cache openssh-client
