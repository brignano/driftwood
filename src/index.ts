// Model
export { Model, Entity, Edge, View, Ignore, Level, emptyModel } from './model/schema.js'
export { loadModel, dumpModel, validateModel, matches } from './model/validate.js'
export type { Issue, ValidationResult } from './model/validate.js'
export { mergeModels, formatConflicts } from './model/merge.js'
export type { MergeResult, MergeConflict, SourcedModel } from './model/merge.js'
export { applyDrift, formatApplySummary } from './model/apply.js'
export type { ApplySummary } from './model/apply.js'
export {
  Observation,
  ObservationSource,
  toObservation,
  parseObservation,
  dumpObservation,
  ageInMinutes,
  formatObservation,
} from './model/observation.js'
export type { ObservationResult } from './model/observation.js'

// Extension points
export { Registry } from './registry.js'
export {
  providers,
  defineProvider,
  terraformProvider,
  dynatraceProvider,
  observationProvider,
  terraformCloudProvider,
  terraformS3Provider,
} from './providers/index.js'
export type { Provider, ProviderContext, ProviderKind } from './providers/index.js'
export { renderers, render, resolveRenderer } from './render/index.js'
export { defineRenderer } from './render/types.js'
export type { Renderer, RenderContext, Availability, ChangeMark, EdgeMark } from './render/types.js'

// Built-in providers
export { importTerraformState, parseTerraformState, stateFromValues, resourceAddress } from './providers/terraform.js'
export type { ImportOptions, TfValues, TfValuesModule, TfValuesResource } from './providers/terraform.js'
export {
  previewPlan,
  parseTerraformPlan,
  formatPreviewComment,
  PlanPreview,
  PlanChanges,
  PlanDesign,
  PREVIEW_MARKER,
  COMMENT_FILE,
  PREVIEW_FILE,
} from './preview.js'
export type { TfPlan, TfResourceChange, PreviewOptions, PreviewResult, CommentContext } from './preview.js'
export { toModel as dynatraceToModel } from './providers/dynatrace.js'

// Renderers
export { renderMermaid } from './render/mermaid.js'
// How an entity is classified and coloured. A third-party renderer is told to
// classify through this rather than inventing a second table, so it has to be
// reachable from the package entry point, not just from inside the repo.
// The marker/injection mechanism stays internal: it is a private contract
// between `renderDot` and the Graphviz renderer, not API to build on.
export { iconFor, familyFor, styleFor, kindLabel, iconSvg, ICONS, PALETTE, ICON_SIZE } from './render/icons.js'
export type { IconKey, Family, FamilyStyle } from './render/icons.js'
export { renderDot } from './render/dot.js'
export { renderGraphvizSvg, detectTier, probeNativeDot } from './render/graphviz.js'
export { selectEntities } from './render/select.js'

// Reconciliation
export { reconcile, formatDrift, COMPARED_FIELDS } from './reconcile/index.js'
export type {
  Drift,
  FieldChange,
  ComparedField,
  CoverageGap,
  UnverifiableEntity,
  UnverifiableEdge,
} from './reconcile/index.js'

// Config
export { loadConfig, observeAll, makeContext, Config } from './config.js'
export type { LoadedConfig, ObserveResult } from './config.js'
export { parseHealthMap, loadHealthMap, unknownHealthIds, HealthStatus } from './health.js'
export type { HealthMap } from './health.js'

// Snapshots — what a deploy left behind, packaged for a build page
export {
  Snapshot,
  SnapshotChanges,
  SnapshotDrift,
  SnapshotDiagram,
  SnapshotFieldChange,
  SnapshotSubject,
  LatestPointer,
  SNAPSHOT_FILE,
  LATEST_FILE,
  SUMMARY_FILE,
  VIEWER_FILE,
  takeSnapshot,
  parseSnapshot,
  loadPreviousSnapshot,
  writeSnapshot,
  writeToStore,
  loadLatestSnapshot,
  subjectDir,
  formatSnapshotSummary,
} from './snapshot.js'
export type { SnapshotOptions, SnapshotBundle, SnapshotParseResult, StoreResult } from './snapshot.js'
export { renderViewer } from './viewer.js'
