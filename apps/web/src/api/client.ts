import type {
  RetriedRuns,
  StepAttempts,
  BackupView,
  QueueControlView,
  RestoreStartBody,
  RestoreStatus,
  UploadStartBody,
  UploadView,
  GitHubLinkBody,
  GitHubLinkView,
  PushOutcome,
  RemoteListing,
  RemoteListingView,
  SyncSettingsBody,
  SyncSettingsView,
  VersionSync,
  GitHubRepo,
  Role,
  MaintenanceBody,
  MaintenanceNotice,
  MaintenanceView,
  Profile,
  ProfileBody,
  GraphPreviewView,
  ModelSettingsBody,
  OntologySuggestionsView,
  ShaclReport,
  LinkedDataBody,
  LinkedDataView,
  Neighbourhood,
  OntologyDetail,
  OntologyFromUrlBody,
  OntologySettings,
  OntologyPatch,
  OntologyListItem,
  OntologySummary,
  OntologyBatchResult,
  OntologyVersionView,
  TermDetail,
  TermGroup,
  TermLabels,
  TermLabelsBody,
  MappingMemoryDetail,
  MappingMemoryPage,
  MemoryCreateBody,
  MemoryListQuery,
  MemoryPatchBody,
  TermPage,
  Brief,
  BriefBody,
  ChoiceCreateInput,
  ChoicePatchBody,
  BriefVersionView,
  DataPolicy,
  DraftStage,
  EndpointCreateInput,
  EndpointPatchBody,
  EditRequest,
  EvaluationSet,
  FeedbackItem,
  FeedbackTarget,
  PublishGateView,
  ProjectOverview,
  IterationSummary,
  ComparisonView,
  IterationView,
  ExportView,
  JobDetail,
  JobLive,
  JobSummary,
  KeepableStage,
  LlmChoicesView,
  LlmChoiceView,
  LlmEndpointView,
  PublishTargetView,
  TargetChoice,
  PluginInfo,
  PluginPreviewView,
  TargetConnection,
  MyConnections,
  TargetCreateBody,
  TargetPatchBody,
  TargetTestBody,
  TargetTestResult,
  ModelChoice,
  PreparedText,
  ProjectListPage,
  ProjectListQuery,
  ProposalView,
  DraftLog,
  Publication,
  ProjectView,
  Reference,
  ReferenceDetail,
  ReferenceRow,
  RerunRequest,
  ResultDetail,
  ResultSummary,
  ResultShow,
  RevisePreview,
  ReviewEdit,
  Retirement,
  SampleRole,
  SampleView,
  SegmentDocument,
  SegmentationView,
  SpecSummary,
  StageView,
  StepRun,
  QueueSummary,
  TestRun,
  Template,
  TemplateChange,
  SettingsBody,
  VersionLabel,
  VersionLabelBody,
} from '@ih/shared';

/** document.json written by the worker for template documents. */
export interface ReviewDocument {
  document_id: string;
  page_count?: number;
  fields: Record<string, { value: unknown; evidence: string | null; page: number | null }>;
  tables: Record<string, Record<string, unknown>[]>;
  checks: Record<
    string,
    {
      rows: {
        value: string;
        status: 'match' | 'alias' | 'near' | 'unmatched' | 'unused';
        matched: string | null;
        distance: number | null;
        count: number;
        /** A check plugin's own words on this value, when it gave any. */
        message?: string | null;
      }[];
    }
  >;
  issues: {
    step: string;
    target: string;
    row: number | null;
    column: string | null;
    raw: unknown;
    message: string;
  }[];
  [key: string]: unknown;
}

export interface ReviewData {
  job: JobDetail;
  template: Template;
  document: ReviewDocument;
  edits: ReviewEdit[];
}

export interface TemplateListItem {
  id: string;
  name: string;
  description: string | null;
  published: number | null;
  draft: number | null;
  /** Set when the document type is retired (hidden from new work); null when it is not. */
  retired: Retirement | null;
  versions: {
    version: number;
    status: 'draft' | 'published';
    updatedAt: string;
    /** What the version is for (#144); null when unlabelled. */
    label?: string | null;
  }[];
  /** Card summary of the version shown (draft first). */
  summary: TemplateSummary;
}

export interface TemplateSummary {
  sections: number;
  fields: number;
  tables: number;
  references: number;
  /** Validation issues of the draft; null when there is no draft. */
  draftIssues: number | null;
  /** Last finished regression of the version shown; matched = references scoring 1. */
  lastRegression: { version: number; matched: number; total: number; at: string } | null;
  /** A regression run of that version is still queued or running (no score yet). */
  regressionRunning: boolean;
}

/** `GET /api/templates/:id/github`: the type's link and every version's sync state. */
export interface GitHubSyncView {
  link: GitHubLinkView | null;
  versions: VersionSync[];
  canPush: boolean;
  reason: string | null;
}

/** What a publish answers: the record, and the automatic push's outcome (null: not attempted). */
export type PublishedTemplateView = TemplateRecordView & { github?: PushOutcome | null };

export interface TemplateRecordView {
  record: {
    id: string;
    version: number;
    status: 'draft' | 'published';
    definition: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    publishedAt: string | null;
  } & Partial<VersionLabel>;
  /** `severity: 'warning'` never blocks publishing (an unmapped output, ADR 0011). */
  issues: { path: string; message: string; severity?: 'warning' }[];
}

export interface RegressionReport {
  items: {
    reference: { id: string; name: string };
    job: { id: string; status: string; error: string | null } | null;
    comparison: {
      score: number;
      fields: { id: string; expected: unknown; actual: unknown; match: boolean }[];
      tables: {
        id: string;
        expected: number;
        actual: number;
        matched: number;
        missing: Record<string, unknown>[];
        extra: Record<string, unknown>[];
        changed?: {
          expected: Record<string, unknown>;
          actual: Record<string, unknown>;
          columns: string[];
        }[];
        cells?: number;
        cellsTotal?: number;
      }[];
    } | null;
  }[];
  summary: { references: number; completed: number; averageScore: number | null };
}

/** GET /api/templates/:id/metrics (see apps/api/src/metrics.ts). */
export interface TemplateMetrics {
  templateId: string;
  versions: {
    version: number;
    jobs: number;
    testJobs: number;
    byStatus: Record<string, number>;
    reviewed: number;
    reviewRate: number | null;
    editsPerReviewed: number | null;
    avgProcessingSeconds: number | null;
  }[];
  steps: {
    stepId: string;
    runs: number;
    reruns: number;
    failures: number;
    avgAttempts: number;
    avgOutputTokens: number | null;
    avgSeconds: number | null;
  }[];
  topEdited: { target: string; edits: number }[];
}

/** One row of `GET /api/templates/:id/versions` (#144), newest first. */
export interface TemplateVersionItem extends VersionLabel {
  version: number;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface VersionDiff {
  from: number;
  to: number;
  changes: {
    kind: 'added' | 'removed' | 'changed';
    path: string;
    before?: unknown;
    after?: unknown;
  }[];
}

export interface UploadRequest {
  file: File;
  specId: string;
  specVersion?: number;
  model?: string;
}

export interface OutputUrlOptions {
  stage?: 'draft' | 'published';
  /** Serve with content-disposition inline (previews) instead of attachment. */
  inline?: boolean;
}

export function outputPath(
  base: string,
  jobId: string,
  outputId: string,
  opts: OutputUrlOptions = {},
): string {
  const params = new URLSearchParams();
  if (opts.stage) params.set('stage', opts.stage);
  if (opts.inline) params.set('inline', '1');
  const qs = params.toString();
  return `${base}/jobs/${jobId}/outputs/${outputId}${qs ? `?${qs}` : ''}`;
}

export interface CleanupRequest {
  olderThanDays: number;
  dryRun: boolean;
  /** Regression runs feed scores and metrics: kept unless included. */
  includeRegression: boolean;
  /** The preview's cutoff, so the delete matches what was previewed. */
  cutoff?: string;
}

export interface CleanupResult {
  /** dryRun: how many jobs match. */
  count?: number;
  /** delete: how many this request deleted, and how many still match. */
  deleted?: number;
  remaining?: number;
  cutoff: string;
}

/** API port — components take this as a prop so tests can pass a fake. */
export interface JobWatchHandlers {
  update(live: JobLive): void;
  gone(): void;
  error(): void;
}

/** Fields of an ontology import; a new ontology needs `label`. */
export interface OntologyImportFields {
  id: string;
  label?: string;
  description?: string;
  tags?: string[];
  localOnly?: boolean;
}

/** `POST /api/ontologies/batch`: a folder or zip, merged into one ontology or one per file. */
export type OntologyBatchFields =
  | {
      mode: 'merge';
      id: string;
      label?: string;
      description?: string;
      tags?: string[];
      localOnly?: boolean;
    }
  | { mode: 'separate'; idPrefix: string; tags?: string[]; localOnly?: boolean };

/** One page of an ontology version's terms (`root` or `parent` for the tree, `q` to search). */
export interface OntologyTermQuery {
  group?: TermGroup;
  q?: string;
  parent?: string;
  root?: boolean;
  offset?: number;
  limit?: number;
}

/** `GET /api/backup`. */
export interface BackupStatus {
  /** The running backup, else the newest one (a failed one carries its error). */
  backup: BackupView | null;
  /** The newest successful backup: the one to download. */
  lastSucceeded: BackupView | null;
  restore: RestoreStatus | null;
  queue: QueueControlView;
}

export interface Api {
  /** Current session, or null when not signed in (401). */
  me(): Promise<Me | null>;
  /**
   * Sign in with an email address (or `admin`) and a password; sets the session cookie. Rejects
   * with an ApiError: 401, 403 (disabled, expired one-time password) or 429 (a locked account
   * carries `body.lockedUntil`; a client over the per-IP limit does not).
   */
  login(login: string, password: string): Promise<SignedIn>;
  logout(): Promise<void>;
  /** Change the signed-in user's password (the first sign-in step with a one-time password). */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** The signed-in user's own profile (docs/design/profile.md). */
  getProfile(): Promise<Profile>;
  /** Saves the name and details (409: the name is taken). */
  updateProfile(body: ProfileBody): Promise<Profile>;
  /** Where the browser goes to link a GitHub account (a navigation: GitHub, then back). */
  gitHubConnectUrl(): string;
  unlinkGitHub(): Promise<void>;
  /** Repositories the linked account can push to. */
  listGitHubRepos(): Promise<GitHubRepo[]>;
  /** The repository recipe YAML will be stored in; null: none. */
  setGitHubRepo(repo: string | null): Promise<Profile>;
  /** Called when any API call answers 401 (session ended). Returns an unsubscribe. */
  onUnauthorized(listener: () => void): () => void;
  /**
   * Called when any API call answers 503 for maintenance (only admins get in): with the notice.
   * Returns an unsubscribe.
   */
  onMaintenance(listener: (notice: MaintenanceNotice) => void): () => void;
  /** Whether CT Studio is under maintenance; needs no session (the sign-in page shows it). */
  getMaintenanceNotice(): Promise<MaintenanceNotice>;
  /** Admins: maintenance mode with who changed it. */
  getMaintenance(): Promise<MaintenanceView>;
  /** Admins: switch maintenance on or off, with the message for users. */
  setMaintenance(body: MaintenanceBody): Promise<MaintenanceView>;
  /** Admins: the latest backup, the newest successful one, the restore and the job queue. */
  getBackupStatus(): Promise<BackupStatus>;
  /** Admins: start a backup in the background (409 while a backup or restore runs). */
  startBackup(): Promise<BackupView>;
  /** Where the browser goes to download a finished backup. */
  backupDownloadUrl(id: string): string;
  /** Admins: pause or resume the job queue. */
  setQueuePaused(paused: boolean): Promise<QueueControlView>;
  /** Admins: start a resumable upload of a backup to restore. */
  startUpload(body: UploadStartBody): Promise<UploadView>;
  /** Which parts of an upload have arrived. */
  getUpload(id: string): Promise<UploadView>;
  /** One part as raw bytes; with `onProgress`, the bytes of this part sent so far. */
  uploadPart(
    id: string,
    n: number,
    blob: Blob,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<UploadView>;
  /** Joins the parts once every one has arrived. */
  completeUpload(id: string): Promise<{ key: string }>;
  /** Starts the check of a completed upload; `token` follows the restore once sessions end. */
  startRestore(body: RestoreStartBody): Promise<{ status: RestoreStatus; token: string }>;
  getRestore(id: string, token: string): Promise<RestoreStatus>;
  confirmRestore(id: string, instanceName: string, token: string): Promise<RestoreStatus>;
  /** Gives up a checked restore that was not confirmed. */
  cancelRestore(id: string, token: string): Promise<void>;
  listUsers(): Promise<User[]>;
  /** A new user: the one-time `password` is only ever returned here and by reissuePassword. */
  addUser(user: { name: string; email: string; role: User['role'] }): Promise<WithPassword>;
  updateUser(
    id: string,
    patch: Partial<{ name: string; email: string; role: User['role'] }>,
  ): Promise<User>;
  /** Enable (or unlock) and disable. Disabling signs the user out everywhere. */
  setUserEnabled(id: string, enabled: boolean): Promise<User>;
  reissuePassword(id: string): Promise<WithPassword>;
  /** Recent sign-ins, newest first (admins). */
  listSignIns(opts?: { userId?: string; limit?: number }): Promise<SignInEvent[]>;
  /** Read-only S3 keys for the data lake (ADR 0008). Rejects with a 404 ApiError when off. */
  listS3Keys(): Promise<S3KeysOverview>;
  /** A new consumer and key: `secretAccessKey` is only ever returned here and by rotate. */
  createS3Key(label: string, expiresInDays: number | null, targets: string[]): Promise<IssuedS3Key>;
  setS3KeyTargets(consumerId: string, targets: string[]): Promise<S3Consumer>;
  /** Another key for the consumer; its other active keys expire within `graceDays`. */
  rotateS3Key(
    consumerId: string,
    expiresInDays: number | null,
    graceDays: number,
  ): Promise<IssuedS3Key>;
  revokeS3Key(keyId: string): Promise<void>;
  deleteS3Consumer(consumerId: string): Promise<void>;
  /** LLM endpoints and their models (admins; ADR 0010). */
  listLlmEndpoints(): Promise<LlmEndpointView[]>;
  /** Publishing targets with what uses each (admins; Administration > Published outputs). */
  listPublishTargets(): Promise<PublishTargetView[]>;
  createPublishTarget(body: TargetCreateBody): Promise<PublishTargetView>;
  updatePublishTarget(id: string, patch: TargetPatchBody): Promise<PublishTargetView>;
  deletePublishTarget(id: string): Promise<void>;
  /** Through the delivery bridge: writes, reads back and deletes a small file. */
  testPublishTarget(body: TargetTestBody): Promise<TargetTestResult>;
  /** The delivery bridge's shared connections an external target may use (admins). */
  listSharedConnections(): Promise<TargetConnection[]>;
  /** Opens the bridge's connections page in a new tab (a one-time link for this user). */
  openConnections(): Promise<void>;
  /** The signed-in user's personal connections on the delivery bridge (never a credential). */
  listMyConnections(): Promise<MyConnections>;
  /** What a recipe's Publish to picker offers (any designer or admin). */
  listPublishTargetChoices(): Promise<TargetChoice[]>;
  /** The plugins recipe steps can run, as the workers published them (recipe plugins 3b). */
  listPlugins(): Promise<PluginInfo[]>;
  /** The ontology library (ADR 0011); retired ontologies only when asked. */
  listOntologies(opts?: { retired?: boolean }): Promise<OntologyListItem[]>;
  /** One ontology with every version, newest first. */
  getOntology(id: string): Promise<OntologyDetail>;
  /** Admin: import a file as the next version of `fields.id`. */
  importOntology(file: File, fields: OntologyImportFields): Promise<OntologyVersionView>;
  /** Admin: a folder's ontology files (with their paths), or one .zip, in one import. */
  importOntologyBatch(
    files: { file: File; path: string }[],
    fields: OntologyBatchFields,
  ): Promise<OntologyBatchResult>;
  /** Admin: name, description, tags, local only, retired. */
  updateOntology(id: string, patch: OntologyPatch): Promise<OntologySummary>;
  /** Admin: delete a version that is ready or failed. */
  deleteOntologyVersion(id: string, version: number): Promise<void>;
  /** Tree levels, search hits. */
  listOntologyTerms(id: string, version: number, query: OntologyTermQuery): Promise<TermPage>;
  /** One term with its neighbours. */
  getOntologyTerm(id: string, version: number, iri: string): Promise<TermDetail>;
  /** The readable names of a mapping's terms (the Mapping tab). */
  termLabels(body: TermLabelsBody): Promise<TermLabels>;
  /** The mapping memory: what designers accepted (docs/design/mapping-memory.md). */
  listMappingMemory(query?: MemoryListQuery): Promise<MappingMemoryPage>;
  getMappingMemoryEntry(id: string): Promise<MappingMemoryDetail>;
  /** Confirm, reject or correct a remembered mapping (any designer). */
  reviewMappingMemoryEntry(id: string, patch: MemoryPatchBody): Promise<MappingMemoryDetail>;
  /** Add a remembered mapping by hand (it starts confirmed). */
  addMappingMemoryEntry(body: MemoryCreateBody): Promise<MappingMemoryDetail>;
  deleteMappingMemoryEntry(id: string): Promise<void>;
  /** Admin: import an ontology the worker fetches from an allowlisted URL. */
  importOntologyFromUrl(body: OntologyFromUrlBody): Promise<OntologyVersionView>;
  /** Allowed hosts for URL imports and the size limit. */
  getOntologySettings(): Promise<OntologySettings>;
  /** Admin: the customer and base IRI RDF is minted under (ADR 0011). */
  getLinkedData(): Promise<LinkedDataView>;
  /** Admin: save them; `confirm` repeats the new base once RDF was published. */
  saveLinkedData(body: LinkedDataBody): Promise<LinkedDataView>;
  /** The base IRI RDF is minted under (null until an admin sets the customer). */
  getEffectiveBase(): Promise<string | null>;
  /** Render the open draft's mapping over the newest finished run of each dev sample. */
  startGraphPreview(projectId: string, sampleIds?: string[]): Promise<GraphPreviewView>;
  getGraphPreview(projectId: string, jobId: string): Promise<GraphPreviewView>;
  /** Run the open draft's plugin step on the dev samples (recipe plugins 3c). */
  startPluginPreview(
    projectId: string,
    stepId: string,
    sampleIds?: string[],
  ): Promise<PluginPreviewView>;
  getPluginPreview(projectId: string, jobId: string): Promise<PluginPreviewView>;
  getOntologySuggestions(projectId: string): Promise<OntologySuggestionsView>;
  refreshOntologySuggestions(projectId: string): Promise<OntologySuggestionsView>;
  /** A term and what it is related to, for the graph view. */
  getNeighbourhood(id: string, version: number, iri: string, depth?: 1 | 2): Promise<Neighbourhood>;
  createLlmEndpoint(body: EndpointCreateInput): Promise<LlmEndpointView>;
  /** `apiKey`: a new key (stored encrypted), or null to remove the stored one. */
  updateLlmEndpoint(name: string, patch: EndpointPatchBody): Promise<LlmEndpointView>;
  /** Exactly these models are offered in the pickers. */
  setLlmEndpointModels(name: string, models: string[]): Promise<LlmEndpointView>;
  /** A model's output limit or parallel calls (admin; a key left out is kept, null clears). */
  setLlmModelSettings(
    name: string,
    modelId: string,
    body: ModelSettingsBody,
  ): Promise<LlmEndpointView>;
  deleteLlmEndpoint(name: string): Promise<void>;
  /** Asks the workers to list every endpoint's models now (suggestions appear shortly). */
  discoverLlmEndpoint(name: string): Promise<void>;
  /** Model choices and pipeline settings (admins; ADR 0010 phase 4b). */
  listModelChoices(): Promise<LlmChoicesView>;
  createModelChoice(body: ChoiceCreateInput): Promise<LlmChoiceView>;
  updateModelChoice(id: string, patch: ChoicePatchBody): Promise<LlmChoiceView>;
  deleteModelChoice(id: string): Promise<void>;
  setLlmSettings(body: SettingsBody): Promise<LlmChoicesView>;
  /** Document types for upload; `retired: 'include'` lists retired ones too (old jobs' names). */
  listSpecs(options?: { retired?: 'include' }): Promise<SpecSummary[]>;
  /** Admins: retire a document type (all its versions). Unretiring is API-only (D14). */
  retireType(id: string): Promise<{ id: string; retired: Retirement }>;
  /** The model choices every picker offers, the default first (ADR 0010, phase 4c). */
  listPickerChoices(): Promise<ModelChoice[]>;
  /** mine: only the jobs the signed-in token queued (`?mine=1`, matched by its label). */
  listJobs(opts?: { mine?: boolean }): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobDetail>;
  /**
   * Follow a job live (Server-Sent Events, `GET /api/jobs/:id/events`): `update` on every change
   * until it leaves queued and running, `gone` once deleted, `error` when the stream is not
   * available (the caller polls instead). Returns stop.
   */
  watchJob(id: string, on: JobWatchHandlers): () => void;
  /** model: a ref to retry with, or null for the spec default (clears the override). */
  retryJob(id: string, model?: string | null): Promise<JobSummary>;
  cancelJob(id: string): Promise<JobSummary>;
  deleteJob(id: string): Promise<void>;
  /** Bulk delete of finished jobs (see CleanupRequest); repeat while `remaining` > 0. */
  cleanupJobs(req: CleanupRequest): Promise<CleanupResult>;
  upload(req: UploadRequest): Promise<JobSummary>;
  outputUrl(jobId: string, outputId: string, opts?: OutputUrlOptions): string;
  /** Published or draft output body as text (Results previews). Rejects with the API error. */
  getOutputText(jobId: string, outputId: string, stage: 'draft' | 'published'): Promise<string>;
  /** The job's SHACL report of its graph (ADR 0011 step 5); null when it has none. */
  getShaclReport(jobId: string): Promise<ShaclReport | null>;
  listResults(query?: {
    templateId?: string;
    /** File name substring (case-insensitive). */
    q?: string;
    /** Reviewed, published without review, or with issues only. */
    show?: ResultShow;
    before?: string;
    beforeId?: string;
  }): Promise<ResultSummary[]>;
  getResult(jobId: string): Promise<ResultDetail>;
  getReview(jobId: string): Promise<ReviewData>;
  addEdit(jobId: string, edit: EditRequest): Promise<ReviewEdit>;
  approve(jobId: string, body: { reviewer?: string; note?: string }): Promise<JobSummary>;
  reject(jobId: string, body: { reviewer?: string; reason: string }): Promise<JobSummary>;
  pageUrl(jobId: string, page: number): string;
  /** The job's uploaded PDF, served inline (Open PDF). */
  documentUrl(jobId: string): string;
  /** Every published output of a result as one ZIP download. */
  archiveUrl(jobId: string): string;
  getStepRuns(jobId: string): Promise<StepRun[]>;
  /** A step's runs that needed a retry, newest first (the step's model log). */
  listRetriedStepRuns(templateId: string, stepId: string): Promise<RetriedRuns>;
  /** One run's saved attempts of a step: prompts, replies and the errors that sent them back. */
  getStepAttempts(jobId: string, stepId: string): Promise<StepAttempts>;
  rerunStep(jobId: string, stepId: string, body: RerunRequest): Promise<JobSummary>;
  getMetrics(templateId: string): Promise<TemplateMetrics>;
  listReferences(templateId: string, version?: number): Promise<Reference[]>;
  createReference(templateId: string, jobId: string, name: string): Promise<Reference>;
  deleteReference(templateId: string, referenceId: string): Promise<void>;
  runRegression(templateId: string, version: number): Promise<{ jobs: JobSummary[] }>;
  getRegression(templateId: string, version: number): Promise<RegressionReport>;
  diffVersions(templateId: string, from: number, to: number): Promise<VersionDiff>;
  listTemplates(): Promise<TemplateListItem[]>;
  createTemplate(id: string, name: string): Promise<TemplateRecordView>;
  getTemplate(id: string, version: number): Promise<TemplateRecordView>;
  /** `baseUpdatedAt`: the version's `updatedAt` the edit started from (409 when it moved). */
  saveTemplate(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    baseUpdatedAt?: string,
  ): Promise<TemplateRecordView>;
  publishTemplate(id: string, version: number): Promise<PublishedTemplateView>;
  newDraft(id: string, from: number): Promise<TemplateRecordView>;
  /** Renames the type in its open draft (started when none is) and its Workbench project. */
  renameTemplate(id: string, name: string): Promise<TemplateRecordView>;
  /** Every version of a document type, newest first, with its label and note (#144). */
  listVersions(id: string): Promise<TemplateVersionItem[]>;
  /** Sets a version's label and note: a field left out is kept, null clears it. */
  setVersionLabel(id: string, version: number, body: VersionLabelBody): Promise<TemplateRecordView>;
  /** Writes version `from` into the open draft `version` (409 when it changed since `baseUpdatedAt`). */
  restoreVersion(
    id: string,
    version: number,
    from: number,
    baseUpdatedAt?: string,
  ): Promise<TemplateRecordView>;
  deleteDraft(id: string, version: number): Promise<void>;
  /** GitHub sync (admins link and change settings; anyone with a linked account pushes and pulls). */
  getGitHubSync(id: string): Promise<GitHubSyncView>;
  /** Admin: link the type to a repository, or change the link. */
  setGitHubLink(id: string, body: GitHubLinkBody): Promise<GitHubLinkView>;
  /** Admin: unlink (the files on GitHub stay). */
  removeGitHubLink(id: string): Promise<void>;
  /** Pushes a published version (or its changed label); 409 when GitHub changed since. */
  pushVersion(id: string, version: number): Promise<PushOutcome>;
  /** The versions on the type's repository, with how each compares with the version here. */
  listGitHubRemote(id: string): Promise<RemoteListingView>;
  /** Copies the label and note on GitHub (at `commit`) onto a published version. */
  takeGitHubLabel(id: string, version: number, commit: string): Promise<TemplateRecordView>;
  /** Writes a version on GitHub into the draft; `baseUpdatedAt` is the open draft's, if any. */
  useGitHubVersionAsDraft(
    id: string,
    body: {
      instance: string;
      typeId: string;
      version: number;
      commit: string;
      baseUpdatedAt?: string;
    },
  ): Promise<TemplateRecordView>;
  /** Admin: this deployment's instance name and default folder. */
  getGitHubSettings(): Promise<SyncSettingsView>;
  setGitHubSettings(body: SyncSettingsBody): Promise<SyncSettingsView>;
  /** Repositories the linked account can read (for browsing and importing). */
  listReadableGitHubRepos(): Promise<GitHubRepo[]>;
  /** Recipe versions under a folder of a repository, from any deployment. */
  browseGitHub(query: { repo: string; branch: string; root: string }): Promise<RemoteListing>;
  /** Creates a new document type from a version on GitHub (a v1 draft). */
  importFromGitHub(body: {
    repo: string;
    branch: string;
    path: string;
    commit: string;
    id?: string;
    name?: string;
    link: boolean;
  }): Promise<TemplateRecordView & { linked: boolean }>;
  importTemplate(yaml: string, publish: boolean): Promise<TemplateRecordView>;
  exportUrl(id: string, version: number): string;
  /** Upload a sample against a (draft) version as a test run (never published). */
  /** `model`: a model choice's id for every step; null or absent: the template's models. */
  testRun(file: File, id: string, version: number, model?: string | null): Promise<JobSummary>;
  // --- workbench (ADR 0007) ---
  /** One page of the project list; only the params that are set are sent. */
  listProjectPage(
    query: Partial<Omit<ProjectListQuery, 'ids'>> & { ids?: string[] },
  ): Promise<ProjectListPage>;
  /** Ids of the projects the caller pinned. */
  listPins(): Promise<string[]>;
  pin(projectId: string): Promise<void>;
  unpin(projectId: string): Promise<void>;
  /** New project; omit `name` to open an existing document type. */
  createProject(id: string, name?: string): Promise<ProjectView>;
  /** Rejects with an ApiError (404 when there is no project yet). */
  getProject(id: string): Promise<ProjectView>;
  /** Deletes a project whose type was never published (409 otherwise). */
  deleteProject(id: string): Promise<void>;
  /** Starts the project again, keeping its samples and the brief's written sections. */
  resetProject(id: string): Promise<ProjectView>;
  setDataPolicy(projectId: string, dataPolicy: DataPolicy): Promise<ProjectView>;
  /** Queue the project's drafting bundle (replaces its previous export). */
  startExport(projectId: string): Promise<ExportView>;
  listExports(projectId: string): Promise<ExportView[]>;
  exportBundleUrl(projectId: string, jobId: string): string;
  /** Import a bundle as a new local project; `id`/`name` default to the manifest's. */
  importBundle(file: File, fields: { id?: string; name?: string }): Promise<ProjectView>;
  startStage(projectId: string, stage: DraftStage): Promise<ProposalView>;
  listProposals(projectId: string): Promise<ProposalView[]>;
  /** Cancel a waiting or running drafting run; the proposal then reads as failed: cancelled. */
  cancelProposal(projectId: string, proposalId: string): Promise<ProposalView>;
  /** A proposal's model log: what the drafting model was sent and answered, tools included. */
  getProposalLog(projectId: string, proposalId: string): Promise<DraftLog>;
  decideProposal(
    projectId: string,
    proposalId: string,
    decision: 'accepted' | 'rejected',
    /** Indexes of the changes to apply (outputs/sections/steps); omitted = all. */
    changes?: number[],
  ): Promise<ProposalView>;
  skipStage(projectId: string, stage: DraftStage): Promise<StageView[]>;
  /** Keep a stale stage as it is (handoff SC1): no new proposal, the draft is unchanged. */
  confirmStage(projectId: string, stage: KeepableStage): Promise<StageView[]>;
  /** Reference rows for the dev samples, or (set = 'holdout') the holdout samples. */
  listReferenceRows(projectId: string, set?: EvaluationSet): Promise<ReferenceRow[]>;
  /** One sample's reference with each output's provenance (handoff RF2). */
  getReferenceDetail(projectId: string, sampleId: string): Promise<ReferenceDetail>;
  /** Queue draft-model runs on unverified dev samples. */
  proposeReferences(projectId: string): Promise<JobSummary[]>;
  /** `uncached` makes every step call its model (the step cache is not read). */
  startEvaluation(
    projectId: string,
    /** A model choice's id; null: the recipe's own models. */
    model: string | null,
    options?: { uncached?: boolean; set?: EvaluationSet },
  ): Promise<IterationView>;
  /** Queue template runs on unverified holdout samples. */
  startHoldoutReferenceRuns(projectId: string): Promise<JobSummary[]>;
  /** One sample's reference run again, to re-verify it (dev: the drafting model; holdout: the template's). */
  runSampleReference(projectId: string, sampleId: string): Promise<JobSummary[]>;
  setPublishThreshold(projectId: string, threshold: number): Promise<ProjectView>;
  getPublishGate(projectId: string): Promise<PublishGateView>;
  /** Rail, header and Overview tab in one call (Workbench redesign W2). */
  getProjectOverview(projectId: string): Promise<ProjectOverview>;
  /** Rejects with an ApiError (409, the gate reason) below the threshold without an override. */
  publish(
    projectId: string,
    overrideReason?: string,
  ): Promise<{ publication: Publication; project: ProjectView; github?: PushOutcome | null }>;
  listPublications(projectId: string): Promise<Publication[]>;
  /** Evaluate the draft on every comparison model at once. */
  /** `models`: the choices to compare, in order (absent: every one the project may use). */
  startComparison(
    projectId: string,
    options?: { uncached?: boolean; models?: string[] },
  ): Promise<ComparisonView>;
  getComparison(projectId: string, groupId: string): Promise<ComparisonView>;
  listIterations(projectId: string): Promise<IterationSummary[]>;
  getIteration(projectId: string, iterationId: string): Promise<IterationView>;
  restoreIteration(projectId: string, iterationId: string): Promise<ProjectView>;
  listFeedback(projectId: string): Promise<FeedbackItem[]>;
  addFeedback(
    projectId: string,
    body: {
      target: FeedbackTarget;
      targetId: string;
      body: string;
      sampleId?: string;
      iterationId?: string;
    },
  ): Promise<FeedbackItem>;
  deleteFeedback(projectId: string, feedbackId: string): Promise<void>;
  /** RV1: exactly what the next revision would send, and what it never sends. */
  getRevisePreview(projectId: string): Promise<RevisePreview>;
  listStages(projectId: string): Promise<StageView[]>;
  listSamples(projectId: string): Promise<SampleView[]>;
  /** With `onProgress`, reports the bytes sent of the upload (#142). */
  uploadSample(
    projectId: string,
    file: File,
    role: SampleRole,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<SampleView>;
  setSampleRole(projectId: string, sampleId: string, role: SampleRole): Promise<SampleView>;
  removeSample(projectId: string, sampleId: string): Promise<void>;
  getSampleText(projectId: string, sampleId: string): Promise<PreparedText>;
  saveBrief(projectId: string, body: BriefBody): Promise<Brief>;
  listBriefVersions(projectId: string): Promise<BriefVersionView[]>;
  /** TP1: the open draft's change log, newest first. */
  listDraftChanges(projectId: string): Promise<TemplateChange[]>;
  getBriefVersion(projectId: string, version: number): Promise<Brief>;
  /**
   * Test-run the open draft on the ready dev samples (handoff TR1): `sampleIds` picks some (all
   * when absent); `model` is a model choice's id for every step (null or absent: the template's).
   */
  runDevTests(
    projectId: string,
    opts?: { model?: string | null; sampleIds?: string[] },
  ): Promise<{ jobs: JobSummary[] }>;
  /** The project's jobs except preparation, with batches and live step progress (TR2, TR3). */
  listTestRuns(projectId: string): Promise<TestRun[]>;
  /** The queue a new run waits behind, with a rough wait (TR4). */
  getQueueSummary(): Promise<QueueSummary>;
  /** Preview anchors over the prepared samples; omit `document` to use the draft's. */
  startSegmentation(projectId: string, document?: SegmentDocument): Promise<SegmentationView>;
  getSegmentation(projectId: string, jobId: string): Promise<SegmentationView>;
}

/** A user as listed to admins (ADR 0013; never a password). */
export interface User {
  id: string;
  name: string;
  /** null only for the admin from the log, who signs in as `admin`. */
  email: string | null;
  role: Role;
  /** `locked` = temporarily, until `lockedUntil`. */
  status: 'admin-from-log' | 'active' | 'must-change' | 'locked' | 'disabled';
  createdAt: string;
  createdBy: string | null;
  lastSignInAt: string | null;
  /** Consecutive failed sign-ins since the last success. */
  failedSignIns: number;
  lastFailedAt: string | null;
  lockedUntil: string | null;
  disabledAt: string | null;
  disabledReason: 'admin' | 'failed-sign-ins' | null;
  disabledBy: string | null;
  oneTimeExpiresAt: string | null;
}

/** A user and their one-time password, shown once. */
export interface WithPassword {
  user: User;
  password: string;
}

/** One sign-in attempt or password change (GET /api/sign-ins). */
export interface SignInEvent {
  id: string;
  at: string;
  /** null for an email that matches nobody. */
  userId: string | null;
  name: string | null;
  result:
    | 'ok'
    | 'wrong-password'
    | 'unknown-login'
    | 'locked'
    | 'disabled'
    | 'expired-one-time'
    | 'password-changed'
    | 'password-change-refused';
  failures: number | null;
  lockedUntil: string | null;
  ip: string;
  userAgent: string | null;
}

/** An S3 access key as listed to admins (never its secret). */
export interface S3Key {
  id: string;
  accessKeyId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

/** A data-lake consumer (one SeaweedFS user) and its keys, newest first. */
export interface S3Consumer {
  id: string;
  label: string;
  userName: string;
  createdAt: string;
  keys: S3Key[];
  /** The internal publishing targets (ids) its keys may read. */
  targets: string[];
}

/** What the lake is configured with besides a key pair; `endpoint` null = not configured. */
export interface S3KeysOverview {
  endpoint: string | null;
  /** The internal publishing targets a key can be granted on. */
  internalTargets: TargetChoice[];
  consumers: S3Consumer[];
}

export interface IssuedS3Key {
  consumer: S3Consumer;
  key: S3Key;
  secretAccessKey: string;
  endpoint: string | null;
}

/** Signed-in identity (GET /api/auth/me). `label` is the user's name. */
export interface Me {
  /** The user id: what jobs record as `createdByUser`. */
  userId: string;
  role: Role;
  label: string;
  /** null for the admin from the log. */
  email: string | null;
  /** Signed in with a one-time password: only the password change works until it is done. */
  mustChangePassword: boolean;
  /** The linked GitHub account's picture; null or absent: initials. */
  avatarUrl?: string | null;
}

/** The sign-in answer: Me plus the failed attempts it cleared (tell the person). */
export interface SignedIn extends Me {
  failedSinceLastSignIn: number;
  lastFailedAt: string | null;
}

const unauthorizedListeners = new Set<() => void>();
const maintenanceListeners = new Set<(notice: MaintenanceNotice) => void>();

/** The notice in a maintenance 503's body (`{ error, maintenance }`), else null. */
export function maintenanceOf(body: unknown): MaintenanceNotice | null {
  const notice = (body as { maintenance?: MaintenanceNotice } | null)?.maintenance;
  return notice && typeof notice.enabled === 'boolean' ? notice : null;
}

/** 401s that mean "not signed in yet / wrong password", not "your session ended". */
const SIGN_IN_CALLS = ['/auth/login', '/auth/me'];

/**
 * fetch for API calls: a 401 from any other call (user management included) means the session
 * ended (expired, disabled, admin password rotated), so listeners can send the user back to
 * sign-in.
 */
const apiFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = String(input);
  if (res.status === 401 && !SIGN_IN_CALLS.some((path) => url.endsWith(path))) {
    for (const listener of unauthorizedListeners) listener();
  }
  // Maintenance began mid-use: everyone but admins is refused until it ends.
  if (res.status === 503 && maintenanceListeners.size) {
    const notice = maintenanceOf(
      await res
        .clone()
        .json()
        .catch(() => null),
    );
    if (notice) for (const listener of maintenanceListeners) listener(notice);
  }
  return res;
};

/** An API error carrying its HTTP status (e.g. 401, 429 on sign-in) and its JSON body. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * The message of an error response. `error` is a message, or the Zod issues of a body that failed
 * validation (the API's ErrorBody), read as `path: message` so a list never shows as
 * "[object Object]"; anything else falls back to the status.
 */
async function errorMessage(res: Response): Promise<string> {
  return messageOf(res, await res.json().catch(() => ({})));
}

/** A rejected response as an ApiError, keeping its body (e.g. a lock's `lockedUntil`). */
async function apiError(res: Response): Promise<ApiError> {
  const body: Record<string, unknown> = await res.json().catch(() => ({}));
  return new ApiError(messageOf(res, body), res.status, body);
}

function messageOf(res: Response, body: { error?: unknown }): string {
  const { error } = body;
  if (typeof error === 'string' && error) return error;
  if (Array.isArray(error)) {
    const issues = error
      .map((i: { path?: unknown; message?: unknown }) => {
        if (typeof i?.message !== 'string') return null;
        const path = Array.isArray(i.path) ? i.path.join('.') : '';
        return path ? `${path}: ${i.message}` : i.message;
      })
      .filter((m): m is string => m !== null);
    if (issues.length) return issues.join('; ');
  }
  return `${res.status} ${res.statusText}`.trim();
}

/**
 * A multipart POST through XMLHttpRequest, for its upload progress: answers and refusals read as
 * they do through `apiFetch` (a 401 ends the session, an error body becomes the ApiError).
 */
function xhrPost<T>(
  url: string,
  body: FormData,
  onProgress: (sent: number, total: number) => void,
): Promise<T> {
  return xhrSend<T>('POST', url, body, onProgress);
}

function xhrSend<T>(
  method: string,
  url: string,
  body: FormData | Blob,
  onProgress: (sent: number, total: number) => void,
  contentType?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (contentType) xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new Error('upload failed: the connection was lost'));
    xhr.onload = () => {
      const res = new Response(xhr.responseText || null, { status: xhr.status });
      if (res.status === 401) for (const listener of unauthorizedListeners) listener();
      json<T>(res).then(resolve, reject);
    };
    xhr.send(body);
  });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await apiError(res);
  return res.json() as Promise<T>;
}

/** For 204 responses: throws the API error like json() does. */
async function noContent(response: Promise<Response>): Promise<void> {
  const res = await response;
  if (!res.ok) throw await apiError(res);
}

function post<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  return apiFetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<T>);
}

export function createHttpApi(base = '/api'): Api {
  return {
    me: async () => {
      const res = await apiFetch(`${base}/auth/me`);
      return res.status === 401 ? null : json<Me>(res);
    },
    login: (login, password) => post<SignedIn>(`${base}/auth/login`, { login, password }),
    logout: async () => {
      await apiFetch(`${base}/auth/logout`, { method: 'POST' });
    },
    changePassword: async (currentPassword, newPassword) => {
      await noContent(
        apiFetch(`${base}/auth/password`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        }),
      );
    },
    getProfile: () => apiFetch(`${base}/profile`).then(json<Profile>),
    updateProfile: (body) => post<Profile>(`${base}/profile`, body, 'PUT'),
    gitHubConnectUrl: () => `${base}/profile/github/connect`,
    unlinkGitHub: () => noContent(apiFetch(`${base}/profile/github`, { method: 'DELETE' })),
    listGitHubRepos: () => apiFetch(`${base}/profile/github/repos`).then(json<GitHubRepo[]>),
    setGitHubRepo: (repo) => post<Profile>(`${base}/profile/github/repo`, { repo }, 'PUT'),
    listUsers: () => apiFetch(`${base}/users`).then(json<User[]>),
    addUser: (user) => post<WithPassword>(`${base}/users`, user),
    updateUser: (id, patch) =>
      post<User>(`${base}/users/${encodeURIComponent(id)}`, patch, 'PATCH'),
    setUserEnabled: (id, enabled) =>
      apiFetch(`${base}/users/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
      }).then(json<User>),
    reissuePassword: (id) =>
      apiFetch(`${base}/users/${encodeURIComponent(id)}/one-time-password`, {
        method: 'POST',
      }).then(json<WithPassword>),
    listSignIns: (opts = {}) => {
      const q = new URLSearchParams();
      if (opts.userId) q.set('userId', opts.userId);
      if (opts.limit) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return apiFetch(`${base}/sign-ins${qs ? `?${qs}` : ''}`).then(json<SignInEvent[]>);
    },
    listLlmEndpoints: () => apiFetch(`${base}/llm/endpoints`).then(json<LlmEndpointView[]>),
    listPublishTargets: () =>
      apiFetch(`${base}/publish-targets`)
        .then(json<{ targets: PublishTargetView[] }>)
        .then((r) => r.targets),
    createPublishTarget: (body) => post<PublishTargetView>(`${base}/publish-targets`, body),
    updatePublishTarget: (id, patch) =>
      post<PublishTargetView>(`${base}/publish-targets/${encodeURIComponent(id)}`, patch, 'PATCH'),
    deletePublishTarget: (id) =>
      noContent(
        apiFetch(`${base}/publish-targets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      ),
    testPublishTarget: (body) => post<TargetTestResult>(`${base}/publish-targets/test`, body),
    openConnections: async () => {
      const { url } = await post<{ url: string }>(`${base}/bridge/connections-link`, {});
      // A new tab, not a frame (the page keeps its own session), and no window.opener for it.
      window.open(url, '_blank', 'noopener');
    },
    listMyConnections: () => apiFetch(`${base}/profile/connections`).then(json<MyConnections>),
    listSharedConnections: () =>
      apiFetch(`${base}/publish-targets/connections`)
        .then(json<{ connections: TargetConnection[] }>)
        .then((r) => r.connections),
    listPlugins: () => apiFetch(`${base}/plugins`).then(json<PluginInfo[]>),
    listPublishTargetChoices: () =>
      apiFetch(`${base}/publish-targets/choices`)
        .then(json<{ choices: TargetChoice[] }>)
        .then((r) => r.choices),
    listOntologies: (opts = {}) =>
      apiFetch(`${base}/ontologies${opts.retired ? '?retired=include' : ''}`).then(
        json<OntologyListItem[]>,
      ),
    getOntology: (id) =>
      apiFetch(`${base}/ontologies/${encodeURIComponent(id)}`).then(json<OntologyDetail>),
    importOntology: (file, fields) => {
      const form = new FormData();
      // Fields precede the file part: the API reads them from the file's preamble.
      form.append('id', fields.id);
      if (fields.label) form.append('label', fields.label);
      if (fields.description) form.append('description', fields.description);
      if (fields.tags?.length) form.append('tags', fields.tags.join(','));
      if (fields.localOnly) form.append('localOnly', 'true');
      form.append('file', file);
      return apiFetch(`${base}/ontologies`, { method: 'POST', body: form }).then(
        json<OntologyVersionView>,
      );
    },
    importOntologyBatch: (files, fields) => {
      const form = new FormData();
      // Fields, then the paths (multipart drops folders from file names), then the files.
      form.append('mode', fields.mode);
      if (fields.mode === 'merge') {
        form.append('id', fields.id);
        if (fields.label) form.append('label', fields.label);
        if (fields.description) form.append('description', fields.description);
      } else {
        form.append('idPrefix', fields.idPrefix);
      }
      if (fields.tags?.length) form.append('tags', fields.tags.join(','));
      if (fields.localOnly) form.append('localOnly', 'true');
      form.append('paths', JSON.stringify(files.map((f) => f.path)));
      for (const { file } of files) form.append('file', file);
      return apiFetch(`${base}/ontologies/batch`, { method: 'POST', body: form }).then(
        async (res) => {
          // A proxy in front of the API (the app's nginx, NGINX Proxy Manager) refuses with its
          // own page, not the API's JSON.
          if (res.status === 413) {
            const body: unknown = await res
              .clone()
              .json()
              .catch(() => null);
            if (body === null || typeof body !== 'object') {
              throw new ApiError(
                'the files are over the upload limit of the proxy in front of CT Studio',
                413,
              );
            }
          }
          return json<OntologyBatchResult>(res);
        },
      );
    },
    listMappingMemory: (query = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      return apiFetch(`${base}/ontologies/memory${qs ? `?${qs}` : ''}`).then(
        json<MappingMemoryPage>,
      );
    },
    getMappingMemoryEntry: (id) =>
      apiFetch(`${base}/ontologies/memory/${encodeURIComponent(id)}`).then(
        json<MappingMemoryDetail>,
      ),
    reviewMappingMemoryEntry: (id, patch) =>
      post<MappingMemoryDetail>(
        `${base}/ontologies/memory/${encodeURIComponent(id)}`,
        patch,
        'PATCH',
      ),
    addMappingMemoryEntry: (body) => post<MappingMemoryDetail>(`${base}/ontologies/memory`, body),
    deleteMappingMemoryEntry: (id) =>
      noContent(
        apiFetch(`${base}/ontologies/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      ),
    updateOntology: (id, patch) =>
      post<OntologySummary>(`${base}/ontologies/${encodeURIComponent(id)}`, patch, 'PATCH'),
    deleteOntologyVersion: (id, version) =>
      noContent(
        apiFetch(`${base}/ontologies/${encodeURIComponent(id)}/versions/${version}`, {
          method: 'DELETE',
        }),
      ),
    listOntologyTerms: (id, version, query) => {
      const params = new URLSearchParams();
      if (query.group) params.set('group', query.group);
      if (query.q) params.set('q', query.q);
      if (query.parent) params.set('parent', query.parent);
      if (query.root) params.set('root', '1');
      if (query.offset) params.set('offset', String(query.offset));
      if (query.limit) params.set('limit', String(query.limit));
      const qs = params.toString();
      return apiFetch(
        `${base}/ontologies/${encodeURIComponent(id)}/versions/${version}/terms${qs ? `?${qs}` : ''}`,
      ).then(json<TermPage>);
    },
    importOntologyFromUrl: (body) => post<OntologyVersionView>(`${base}/ontologies/from-url`, body),
    termLabels: (body) => post<TermLabels>(`${base}/ontologies/term-labels`, body),
    getOntologySettings: () => apiFetch(`${base}/ontology-settings`).then(json<OntologySettings>),
    getLinkedData: () => apiFetch(`${base}/linked-data/settings`).then(json<LinkedDataView>),
    saveLinkedData: (body) => post<LinkedDataView>(`${base}/linked-data/settings`, body, 'PUT'),
    getEffectiveBase: () =>
      apiFetch(`${base}/linked-data/base`)
        .then(json<{ effectiveBase: string | null }>)
        .then((r) => r.effectiveBase),
    startGraphPreview: (projectId, sampleIds) =>
      post<GraphPreviewView>(
        `${base}/workbench/projects/${encodeURIComponent(projectId)}/graph-previews`,
        sampleIds ? { sampleIds } : {},
      ),
    getOntologySuggestions: (projectId) =>
      apiFetch(
        `${base}/workbench/projects/${encodeURIComponent(projectId)}/ontology-suggestions`,
      ).then(json<OntologySuggestionsView>),
    refreshOntologySuggestions: (projectId) =>
      post<OntologySuggestionsView>(
        `${base}/workbench/projects/${encodeURIComponent(projectId)}/ontology-suggestions`,
        {},
      ),
    startPluginPreview: (projectId, stepId, sampleIds) =>
      post<PluginPreviewView>(
        `${base}/workbench/projects/${encodeURIComponent(projectId)}/plugin-previews`,
        sampleIds ? { stepId, sampleIds } : { stepId },
      ),
    getPluginPreview: (projectId, jobId) =>
      apiFetch(
        `${base}/workbench/projects/${encodeURIComponent(projectId)}/plugin-previews/${encodeURIComponent(jobId)}`,
      ).then(json<PluginPreviewView>),
    getGraphPreview: (projectId, jobId) =>
      apiFetch(
        `${base}/workbench/projects/${encodeURIComponent(projectId)}/graph-previews/${encodeURIComponent(jobId)}`,
      ).then(json<GraphPreviewView>),
    getNeighbourhood: (id, version, iri, depth = 1) =>
      apiFetch(
        `${base}/ontologies/${encodeURIComponent(id)}/versions/${version}/neighbourhood?iri=${encodeURIComponent(iri)}&depth=${depth}`,
      ).then(json<Neighbourhood>),
    getOntologyTerm: (id, version, iri) =>
      apiFetch(
        `${base}/ontologies/${encodeURIComponent(id)}/versions/${version}/term?iri=${encodeURIComponent(iri)}`,
      ).then(json<TermDetail>),
    createLlmEndpoint: (body) => post<LlmEndpointView>(`${base}/llm/endpoints`, body),
    updateLlmEndpoint: (name, patch) =>
      post<LlmEndpointView>(`${base}/llm/endpoints/${encodeURIComponent(name)}`, patch, 'PATCH'),
    setLlmEndpointModels: (name, models) =>
      post<LlmEndpointView>(
        `${base}/llm/endpoints/${encodeURIComponent(name)}/models`,
        { models },
        'PUT',
      ),
    setLlmModelSettings: (name, modelId, body) =>
      post<LlmEndpointView>(
        `${base}/llm/endpoints/${encodeURIComponent(name)}/models/${encodeURIComponent(modelId)}`,
        body,
        'PATCH',
      ),
    deleteLlmEndpoint: (name) =>
      noContent(
        apiFetch(`${base}/llm/endpoints/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      ),
    discoverLlmEndpoint: (name) =>
      noContent(
        apiFetch(`${base}/llm/endpoints/${encodeURIComponent(name)}/discover`, { method: 'POST' }),
      ),
    listModelChoices: () => apiFetch(`${base}/llm/choices`).then(json<LlmChoicesView>),
    createModelChoice: (body) => post<LlmChoiceView>(`${base}/llm/choices`, body),
    updateModelChoice: (id, patch) =>
      post<LlmChoiceView>(`${base}/llm/choices/${encodeURIComponent(id)}`, patch, 'PATCH'),
    deleteModelChoice: (id) =>
      noContent(apiFetch(`${base}/llm/choices/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    setLlmSettings: (body) => post<LlmChoicesView>(`${base}/llm/settings`, body, 'PUT'),
    listS3Keys: () => apiFetch(`${base}/access/s3-keys`).then(json<S3KeysOverview>),
    createS3Key: (label, expiresInDays, targets) =>
      post<IssuedS3Key>(`${base}/access/s3-keys`, { label, expiresInDays, targets }),
    setS3KeyTargets: (consumerId, targets) =>
      post<S3Consumer>(`${base}/access/s3-keys/${consumerId}/targets`, { targets }, 'PUT'),
    rotateS3Key: (consumerId, expiresInDays, graceDays) =>
      post<IssuedS3Key>(`${base}/access/s3-keys/${consumerId}/rotate`, {
        expiresInDays,
        graceDays,
      }),
    revokeS3Key: async (keyId) => {
      await noContent(apiFetch(`${base}/access/s3-keys/keys/${keyId}/revoke`, { method: 'POST' }));
    },
    deleteS3Consumer: async (consumerId) => {
      await noContent(apiFetch(`${base}/access/s3-keys/${consumerId}`, { method: 'DELETE' }));
    },
    onUnauthorized: (listener) => {
      unauthorizedListeners.add(listener);
      return () => unauthorizedListeners.delete(listener);
    },
    onMaintenance: (listener) => {
      maintenanceListeners.add(listener);
      return () => maintenanceListeners.delete(listener);
    },
    getMaintenanceNotice: () => fetch(`${base}/maintenance`).then(json<MaintenanceNotice>),
    getMaintenance: () => apiFetch(`${base}/maintenance/settings`).then(json<MaintenanceView>),
    setMaintenance: (body) => post<MaintenanceView>(`${base}/maintenance`, body, 'PUT'),
    getBackupStatus: () => apiFetch(`${base}/backup`).then(json<BackupStatus>),
    startBackup: () =>
      apiFetch(`${base}/backup/backups`, { method: 'POST' }).then(json<BackupView>),
    backupDownloadUrl: (id) => `${base}/backup/backups/${encodeURIComponent(id)}/file`,
    setQueuePaused: (paused) => post<QueueControlView>(`${base}/backup/queue`, { paused }, 'PUT'),
    startUpload: (body) => post<UploadView>(`${base}/backup/uploads`, body),
    getUpload: (id) =>
      apiFetch(`${base}/backup/uploads/${encodeURIComponent(id)}`).then(json<UploadView>),
    uploadPart: (id, n, blob, onProgress) => {
      const url = `${base}/backup/uploads/${encodeURIComponent(id)}/parts/${n}`;
      const type = 'application/octet-stream';
      // fetch cannot report upload progress; XMLHttpRequest can.
      if (onProgress) return xhrSend<UploadView>('PUT', url, blob, onProgress, type);
      return apiFetch(url, {
        method: 'PUT',
        headers: { 'content-type': type },
        body: blob,
      }).then(json<UploadView>);
    },
    completeUpload: (id) =>
      apiFetch(`${base}/backup/uploads/${encodeURIComponent(id)}/complete`, {
        method: 'POST',
      }).then(json<{ key: string }>),
    startRestore: (body) =>
      post<{ status: RestoreStatus; token: string }>(`${base}/backup/restores`, body),
    getRestore: (id, token) =>
      apiFetch(`${base}/backup/restores/${encodeURIComponent(id)}`, {
        headers: { 'x-restore-token': token },
      }).then(json<RestoreStatus>),
    confirmRestore: (id, instanceName, token) =>
      apiFetch(`${base}/backup/restores/${encodeURIComponent(id)}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-restore-token': token },
        body: JSON.stringify({ instanceName }),
      }).then(json<RestoreStatus>),
    cancelRestore: (id, token) =>
      noContent(
        apiFetch(`${base}/backup/restores/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'x-restore-token': token },
        }),
      ),
    listSpecs: (options) =>
      apiFetch(`${base}/specs${options?.retired ? `?retired=${options.retired}` : ''}`).then(
        json<SpecSummary[]>,
      ),
    retireType: (id) =>
      post<{ id: string; retired: Retirement }>(
        `${base}/specs/${encodeURIComponent(id)}/retirement`,
        {},
        'PUT',
      ),
    listPickerChoices: () =>
      apiFetch(`${base}/models/choices`)
        .then(json<{ choices: ModelChoice[] }>)
        .then((r) => r.choices),
    listJobs: (opts) =>
      apiFetch(`${base}/jobs${opts?.mine ? '?mine=1' : ''}`).then(json<JobSummary[]>),
    getJob: (id) => apiFetch(`${base}/jobs/${id}`).then(json<JobDetail>),
    watchJob: (id, on) => watchJobEvents(`${base}/jobs/${id}/events`, on),
    retryJob: (id, model) =>
      post<JobSummary>(`${base}/jobs/${id}/retry`, model === undefined ? {} : { model }),
    cancelJob: (id) => post<JobSummary>(`${base}/jobs/${id}/cancel`, {}),
    deleteJob: async (id) => {
      const res = await apiFetch(`${base}/jobs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res));
    },
    cleanupJobs: (req) => post<CleanupResult>(`${base}/jobs/cleanup`, req),
    upload: ({ file, specId, specVersion, model }) => {
      // Fields must precede the file part — the API reads them from the file's preamble.
      const form = new FormData();
      form.append('specId', specId);
      if (specVersion !== undefined) form.append('specVersion', String(specVersion));
      if (model) form.append('model', model);
      form.append('file', file);
      return apiFetch(`${base}/documents`, { method: 'POST', body: form }).then(json<JobSummary>);
    },
    createProject: (id, name) =>
      post<ProjectView>(`${base}/workbench/projects`, name ? { id, name } : { id }),
    getProject: (id) => apiFetch(`${base}/workbench/projects/${id}`).then(json<ProjectView>),
    listProjectPage: (query) => {
      const params = new URLSearchParams();
      if (query.q) params.set('q', query.q);
      if (query.filter) params.set('filter', query.filter);
      if (query.phase) params.set('phase', query.phase);
      if (query.policy) params.set('policy', query.policy);
      if (query.retired) params.set('retired', query.retired);
      if (query.sort) params.set('sort', query.sort);
      if (query.ids?.length) params.set('ids', query.ids.join(','));
      if (query.page) params.set('page', String(query.page));
      if (query.size) params.set('size', String(query.size));
      const qs = params.toString();
      return apiFetch(`${base}/workbench/projects${qs ? `?${qs}` : ''}`).then(
        json<ProjectListPage>,
      );
    },
    listPins: () => apiFetch(`${base}/workbench/pins`).then(json<string[]>),
    pin: (id) =>
      noContent(apiFetch(`${base}/workbench/pins/${encodeURIComponent(id)}`, { method: 'PUT' })),
    unpin: (id) =>
      noContent(apiFetch(`${base}/workbench/pins/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    deleteProject: (id) =>
      noContent(apiFetch(`${base}/workbench/projects/${id}`, { method: 'DELETE' })),
    resetProject: (id) => post<ProjectView>(`${base}/workbench/projects/${id}/reset`, {}),
    startExport: (id) => post<ExportView>(`${base}/workbench/projects/${id}/export`, {}),
    listExports: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/exports`).then(json<ExportView[]>),
    exportBundleUrl: (id, jobId) => `${base}/workbench/projects/${id}/exports/${jobId}/bundle`,
    importBundle: (file, fields) => {
      // Fields must precede the file part — the API reads them from the file's preamble.
      const form = new FormData();
      if (fields.id) form.append('id', fields.id);
      if (fields.name) form.append('name', fields.name);
      form.append('bundle', file);
      return apiFetch(`${base}/workbench/projects/import`, { method: 'POST', body: form }).then(
        async (res) => {
          // A proxy in front of the API (nginx, NGINX Proxy Manager) refuses with its own page.
          if (res.status === 413) {
            const body: unknown = await res
              .clone()
              .json()
              .catch(() => null);
            if (body === null || typeof body !== 'object') {
              throw new ApiError('bundle too large for the proxy', 413);
            }
          }
          return json<ProjectView>(res);
        },
      );
    },
    setDataPolicy: (id, dataPolicy) =>
      post<ProjectView>(`${base}/workbench/projects/${id}/data-policy`, { dataPolicy }, 'PUT'),
    startStage: (id, stage) =>
      post<ProposalView>(`${base}/workbench/projects/${id}/stages/${stage}`, {}),
    listProposals: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/proposals`).then(json<ProposalView[]>),
    cancelProposal: (id, proposalId) =>
      post<ProposalView>(`${base}/workbench/projects/${id}/proposals/${proposalId}/cancel`, {}),
    getProposalLog: (id, proposalId) =>
      apiFetch(`${base}/workbench/projects/${id}/proposals/${proposalId}/log`).then(json<DraftLog>),
    decideProposal: (id, proposalId, decision, changes) =>
      post<ProposalView>(
        `${base}/workbench/projects/${id}/proposals/${proposalId}/decision`,
        changes ? { decision, changes } : { decision },
      ),
    skipStage: (id, stage) =>
      post<StageView[]>(`${base}/workbench/projects/${id}/stages/${stage}/skip`, {}),
    confirmStage: (id, stage) =>
      post<StageView[]>(`${base}/workbench/projects/${id}/stages/${stage}/confirm`, {}),
    listReferenceRows: (id, set) =>
      apiFetch(
        `${base}/workbench/projects/${id}/references${set === 'holdout' ? '?set=holdout' : ''}`,
      ).then(json<ReferenceRow[]>),
    getReferenceDetail: (id, sid) =>
      apiFetch(`${base}/workbench/projects/${id}/references/${sid}`).then(json<ReferenceDetail>),
    proposeReferences: (id) =>
      post<{ jobs: JobSummary[] }>(`${base}/workbench/projects/${id}/stages/references`, {}).then(
        (r) => r.jobs,
      ),
    startEvaluation: (id, model, options) =>
      post<IterationView>(`${base}/workbench/projects/${id}/evaluations`, {
        ...(model ? { model } : {}),
        ...(options?.uncached ? { uncached: true } : {}),
        ...(options?.set === 'holdout' ? { set: 'holdout' } : {}),
      }),
    startHoldoutReferenceRuns: (id) =>
      post<{ jobs: JobSummary[] }>(
        `${base}/workbench/projects/${id}/holdout/reference-runs`,
        {},
      ).then((r) => r.jobs),
    runSampleReference: (id, sampleId) =>
      post<{ jobs: JobSummary[] }>(
        `${base}/workbench/projects/${id}/references/${sampleId}/run`,
        {},
      ).then((r) => r.jobs),
    setPublishThreshold: (id, publishThreshold) =>
      post<ProjectView>(`${base}/workbench/projects/${id}`, { publishThreshold }, 'PATCH'),
    getPublishGate: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/publish-gate`).then(json<PublishGateView>),
    getProjectOverview: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/overview`).then(json<ProjectOverview>),
    publish: (id, overrideReason) =>
      post<{ publication: Publication; project: ProjectView; github?: PushOutcome | null }>(
        `${base}/workbench/projects/${id}/publish`,
        overrideReason ? { overrideReason } : {},
      ),
    listPublications: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/publications`).then(json<Publication[]>),
    startComparison: (id, options) =>
      post<ComparisonView>(`${base}/workbench/projects/${id}/evaluations/compare`, {
        ...(options?.models ? { models: options.models } : {}),
        ...(options?.uncached ? { uncached: true } : {}),
      }),
    getComparison: (id, groupId) =>
      apiFetch(`${base}/workbench/projects/${id}/comparisons/${groupId}`).then(
        json<ComparisonView>,
      ),
    listIterations: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/iterations`).then(json<IterationSummary[]>),
    getIteration: (id, iid) =>
      apiFetch(`${base}/workbench/projects/${id}/iterations/${iid}`).then(json<IterationView>),
    listFeedback: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/feedback`).then(json<FeedbackItem[]>),
    addFeedback: (id, body) =>
      post<FeedbackItem>(`${base}/workbench/projects/${id}/feedback`, body),
    deleteFeedback: (id, fid) =>
      noContent(apiFetch(`${base}/workbench/projects/${id}/feedback/${fid}`, { method: 'DELETE' })),
    getRevisePreview: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/stages/revise/preview`).then(json<RevisePreview>),
    restoreIteration: (id, iid) =>
      post<ProjectView>(`${base}/workbench/projects/${id}/iterations/${iid}/restore`, {}),
    listStages: (id) => apiFetch(`${base}/workbench/projects/${id}/stages`).then(json<StageView[]>),
    listSamples: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/samples`).then(json<SampleView[]>),
    uploadSample: (id, file, role, onProgress) => {
      const form = new FormData();
      form.append('role', role); // fields before the file part
      form.append('file', file);
      const url = `${base}/workbench/projects/${id}/samples`;
      // fetch cannot report upload progress; XMLHttpRequest can.
      if (onProgress) return xhrPost<SampleView>(url, form, onProgress);
      return apiFetch(url, { method: 'POST', body: form }).then(json<SampleView>);
    },
    setSampleRole: (id, sampleId, role) =>
      post<SampleView>(`${base}/workbench/projects/${id}/samples/${sampleId}`, { role }, 'PATCH'),
    removeSample: (id, sampleId) =>
      noContent(
        apiFetch(`${base}/workbench/projects/${id}/samples/${sampleId}`, { method: 'DELETE' }),
      ),
    getSampleText: (id, sampleId) =>
      apiFetch(`${base}/workbench/projects/${id}/samples/${sampleId}/text`).then(
        json<PreparedText>,
      ),
    saveBrief: (id, body) => post<Brief>(`${base}/workbench/projects/${id}/brief`, body, 'PUT'),
    listDraftChanges: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/draft/changes`).then(json<TemplateChange[]>),
    listBriefVersions: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/briefs`).then(json<BriefVersionView[]>),
    getBriefVersion: (id, version) =>
      apiFetch(`${base}/workbench/projects/${id}/briefs/${version}`).then(json<Brief>),
    runDevTests: (id, opts) =>
      post<{ jobs: JobSummary[] }>(`${base}/workbench/projects/${id}/test-runs`, {
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.sampleIds ? { sampleIds: opts.sampleIds } : {}),
      }),
    listTestRuns: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/test-runs`).then(json<TestRun[]>),
    getQueueSummary: () => apiFetch(`${base}/queue/summary`).then(json<QueueSummary>),
    startSegmentation: (id, document) =>
      post<SegmentationView>(
        `${base}/workbench/projects/${id}/segmentations`,
        document ? { document } : {},
      ),
    getSegmentation: (id, jobId) =>
      apiFetch(`${base}/workbench/projects/${id}/segmentations/${jobId}`).then(
        json<SegmentationView>,
      ),
    outputUrl: (jobId, outputId, opts) => outputPath(base, jobId, outputId, opts),
    getOutputText: async (jobId, outputId, stage) => {
      const res = await apiFetch(outputPath(base, jobId, outputId, { stage, inline: true }));
      if (!res.ok) throw new Error(await errorMessage(res));
      return res.text();
    },
    getShaclReport: async (jobId) => {
      const res = await apiFetch(`${base}/jobs/${jobId}/shacl-report`);
      if (res.status === 404) return null;
      return json<ShaclReport>(res);
    },
    listResults: (query = {}) => {
      const params = new URLSearchParams();
      if (query.templateId) params.set('templateId', query.templateId);
      // The API accepts up to 100 characters: a longer filter is clamped, not refused.
      if (query.q?.trim()) params.set('q', query.q.trim().slice(0, 100));
      if (query.show) params.set('show', query.show);
      if (query.before) params.set('before', query.before);
      if (query.beforeId) params.set('beforeId', query.beforeId);
      const qs = params.toString();
      return apiFetch(`${base}/results${qs ? `?${qs}` : ''}`).then(json<ResultSummary[]>);
    },
    getResult: (jobId) => apiFetch(`${base}/results/${jobId}`).then(json<ResultDetail>),
    getReview: (jobId) => apiFetch(`${base}/jobs/${jobId}/review`).then(json<ReviewData>),
    addEdit: (jobId, edit) => post<ReviewEdit>(`${base}/jobs/${jobId}/edits`, edit),
    approve: (jobId, body) => post<JobSummary>(`${base}/jobs/${jobId}/approve`, body),
    reject: (jobId, body) => post<JobSummary>(`${base}/jobs/${jobId}/reject`, body),
    pageUrl: (jobId, page) => `${base}/jobs/${jobId}/pages/${page}`,
    documentUrl: (jobId) => `${base}/jobs/${jobId}/document`,
    archiveUrl: (jobId) => `${base}/results/${jobId}/archive`,
    getStepRuns: (jobId) => apiFetch(`${base}/jobs/${jobId}/steps`).then(json<StepRun[]>),
    listRetriedStepRuns: (templateId, stepId) =>
      apiFetch(
        `${base}/templates/${encodeURIComponent(templateId)}/steps/${encodeURIComponent(stepId)}/retried-runs`,
      ).then(json<RetriedRuns>),
    getStepAttempts: (jobId, stepId) =>
      apiFetch(`${base}/jobs/${jobId}/steps/${encodeURIComponent(stepId)}/attempts`).then(
        json<StepAttempts>,
      ),
    rerunStep: (jobId, stepId, body) =>
      post<JobSummary>(`${base}/jobs/${jobId}/steps/${stepId}/rerun`, body),
    getMetrics: (templateId) =>
      apiFetch(`${base}/templates/${templateId}/metrics`).then(json<TemplateMetrics>),
    listReferences: (templateId, version) =>
      apiFetch(
        `${base}/templates/${templateId}/references${version === undefined ? '' : `?version=${version}`}`,
      ).then(json<Reference[]>),
    createReference: (templateId, jobId, name) =>
      post<Reference>(`${base}/templates/${templateId}/references`, { jobId, name }),
    deleteReference: async (templateId, referenceId) => {
      const res = await apiFetch(`${base}/templates/${templateId}/references/${referenceId}`, {
        method: 'DELETE',
      });
      if (!res.ok) await json(res);
    },
    runRegression: (templateId, version) =>
      post<{ jobs: JobSummary[] }>(
        `${base}/templates/${templateId}/versions/${version}/regression`,
        {},
      ),
    getRegression: (templateId, version) =>
      apiFetch(`${base}/templates/${templateId}/versions/${version}/regression`).then(
        json<RegressionReport>,
      ),
    diffVersions: (templateId, from, to) =>
      apiFetch(`${base}/templates/${templateId}/diff?from=${from}&to=${to}`).then(
        json<VersionDiff>,
      ),
    listTemplates: () => apiFetch(`${base}/templates`).then(json<TemplateListItem[]>),
    createTemplate: (id, name) => post<TemplateRecordView>(`${base}/templates`, { id, name }),
    getTemplate: (id, version) =>
      apiFetch(`${base}/templates/${id}/versions/${version}`).then(json<TemplateRecordView>),
    saveTemplate: (id, version, definition, baseUpdatedAt) =>
      post<TemplateRecordView>(
        `${base}/templates/${id}/versions/${version}`,
        { definition, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) },
        'PUT',
      ),
    publishTemplate: (id, version) =>
      post<PublishedTemplateView>(`${base}/templates/${id}/versions/${version}/publish`, {}),
    newDraft: (id, from) => post<TemplateRecordView>(`${base}/templates/${id}/drafts`, { from }),
    renameTemplate: (id, name) =>
      post<TemplateRecordView>(`${base}/templates/${id}/name`, { name }, 'PUT'),
    listVersions: (id) =>
      apiFetch(`${base}/templates/${id}/versions`).then(json<TemplateVersionItem[]>),
    setVersionLabel: (id, version, body) =>
      post<TemplateRecordView>(`${base}/templates/${id}/versions/${version}`, body, 'PATCH'),
    restoreVersion: (id, version, from, baseUpdatedAt) =>
      post<TemplateRecordView>(`${base}/templates/${id}/versions/${version}/restore`, {
        from,
        ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
      }),
    getGitHubSync: (id) => apiFetch(`${base}/templates/${id}/github`).then(json<GitHubSyncView>),
    setGitHubLink: (id, body) =>
      post<GitHubLinkView>(`${base}/templates/${id}/github`, body, 'PUT'),
    removeGitHubLink: (id) =>
      noContent(apiFetch(`${base}/templates/${id}/github`, { method: 'DELETE' })),
    pushVersion: (id, version) =>
      post<PushOutcome>(`${base}/templates/${id}/versions/${version}/github/push`, {}),
    listGitHubRemote: (id) =>
      apiFetch(`${base}/templates/${id}/github/remote`).then(json<RemoteListingView>),
    takeGitHubLabel: (id, version, commit) =>
      post<TemplateRecordView>(`${base}/templates/${id}/versions/${version}/github/take-label`, {
        commit,
      }),
    useGitHubVersionAsDraft: (id, body) =>
      post<TemplateRecordView>(`${base}/templates/${id}/github/use-as-draft`, body),
    getGitHubSettings: () => apiFetch(`${base}/github/settings`).then(json<SyncSettingsView>),
    setGitHubSettings: (body) => post<SyncSettingsView>(`${base}/github/settings`, body, 'PUT'),
    listReadableGitHubRepos: () => apiFetch(`${base}/github/repos`).then(json<GitHubRepo[]>),
    browseGitHub: ({ repo, branch, root }) =>
      apiFetch(`${base}/github/browse?${new URLSearchParams({ repo, branch, root })}`).then(
        json<RemoteListing>,
      ),
    importFromGitHub: (body) =>
      post<TemplateRecordView & { linked: boolean }>(`${base}/github/import`, body),
    deleteDraft: async (id, version) => {
      const res = await apiFetch(`${base}/templates/${id}/versions/${version}`, {
        method: 'DELETE',
      });
      if (!res.ok) await json(res);
    },
    importTemplate: (yaml, publish) =>
      post<TemplateRecordView>(`${base}/templates/import`, { yaml, publish }),
    exportUrl: (id, version) => `${base}/templates/${id}/versions/${version}/export`,
    testRun: (file, id, version, model) => {
      const form = new FormData();
      form.append('specId', id);
      form.append('specVersion', String(version));
      form.append('test', 'true');
      if (model) form.append('model', model); // fields precede the file
      form.append('file', file);
      return apiFetch(`${base}/documents`, { method: 'POST', body: form }).then(json<JobSummary>);
    },
  };
}

export const httpApi = createHttpApi();

/** The imported file of an ontology version (a plain link: the browser downloads it). */
export function ontologySourceUrl(id: string, version: number): string {
  return `/api/ontologies/${encodeURIComponent(id)}/versions/${version}/source`;
}

/**
 * A job's live stream. The browser reconnects a dropped stream by itself (the server says after
 * 3 s), so `error` is only reported once it gives up (a refused request: signed out, not found)
 * or when there is no EventSource at all. A finished job's stream is closed here: the server
 * ends it, and the browser would otherwise reconnect.
 */
function watchJobEvents(url: string, on: JobWatchHandlers): () => void {
  if (typeof EventSource === 'undefined') {
    let stopped = false;
    queueMicrotask(() => {
      if (!stopped) on.error();
    });
    return () => {
      stopped = true;
    };
  }
  const source = new EventSource(url);
  source.addEventListener('job', (e) => {
    const live = JSON.parse((e as MessageEvent<string>).data) as JobLive;
    if (live.job.status !== 'queued' && live.job.status !== 'running') source.close();
    on.update(live);
  });
  source.addEventListener('gone', () => {
    source.close();
    on.gone();
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) on.error();
  };
  return () => source.close();
}
