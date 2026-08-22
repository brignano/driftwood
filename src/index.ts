// Model
export { Model, Entity, Edge, View, Ignore, Level, emptyModel } from './model/schema.js'
export { loadModel, dumpModel, validateModel, matches } from './model/validate.js'
export type { Issue, ValidationResult } from './model/validate.js'
export { mergeModels, formatConflicts } from './model/merge.js'
export type { MergeResult, MergeConflict, SourcedModel } from './model/merge.js'

// Extension points
export { Registry } from './registry.js'
export { providers, defineProvider, terraformProvider, dynatraceProvider } from './providers/index.js'
export type { Provider, ProviderContext, ProviderKind } from './providers/index.js'
export { renderers, render, resolveRenderer } from './render/index.js'
export { defineRenderer } from './render/types.js'
export type { Renderer, RenderContext, Availability } from './render/types.js'

// Built-in providers
export { importTerraformState, parseTerraformState } from './providers/terraform.js'
export type { ImportOptions } from './providers/terraform.js'
export { toModel as dynatraceToModel } from './providers/dynatrace.js'

// Renderers
export { renderMermaid } from './render/mermaid.js'
export { renderDot } from './render/dot.js'
export { renderGraphvizSvg, detectTier, probeNativeDot } from './render/graphviz.js'
export { selectEntities } from './render/select.js'

// Reconciliation
export { reconcile, formatDrift, COMPARED_FIELDS } from './reconcile/index.js'
export type { Drift, FieldChange, ComparedField } from './reconcile/index.js'

// Config
export { loadConfig, observeAll, makeContext, Config } from './config.js'
export type { LoadedConfig } from './config.js'
