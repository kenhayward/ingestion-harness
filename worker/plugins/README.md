# Recipe plugin packages

Python packages of recipe plugins, built into the worker image when `WORKER_PLUGINS` in
`deploy/.env` names them (as `plugins/<folder>`). How to write one:
[docs/plugins/writing-plugins.md](../../docs/plugins/writing-plugins.md).

- `example/`: `example.label_value@1`, the guide's worked example. The worker installs it as a
  dev dependency for its tests; deployments get it only if `WORKER_PLUGINS` names it.
