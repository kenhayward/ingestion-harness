# Extra certificate authorities for the delivery bridge

The `bridge` service mounts this folder read-only at `/etc/ct-bridge/certs`. Put here the root
certificate of a certificate authority the bridge should trust besides the system's, for an
external sink (`BRIDGE_SINKS`) served over https with a locally issued certificate, then name it
in `deploy/.env`:

```
BRIDGE_EXTRA_CA_CERTS=/etc/ct-bridge/certs/lan-root.crt
```

and recreate the bridge: `docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d bridge`.

Everything in this folder but this file is git-ignored. See "External sinks" in
[deploy/README.md](../README.md).
