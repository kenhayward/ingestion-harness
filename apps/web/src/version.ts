import { DEV_VERSION, type VersionInfo } from '@ih/shared';

/** This build's version (ADR 0014), baked in by app.Dockerfile; a dev build otherwise. */
export const BUILD_VERSION: VersionInfo = {
  version: import.meta.env.VITE_APP_VERSION || DEV_VERSION.version,
  previous: import.meta.env.VITE_APP_VERSION_PREVIOUS || null,
  commit: import.meta.env.VITE_APP_COMMIT || DEV_VERSION.commit,
};
