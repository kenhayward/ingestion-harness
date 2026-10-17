/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The build's calendar version, the tag before it and the commit (ADR 0014). */
  readonly VITE_APP_VERSION?: string;
  readonly VITE_APP_VERSION_PREVIOUS?: string;
  readonly VITE_APP_COMMIT?: string;
}
