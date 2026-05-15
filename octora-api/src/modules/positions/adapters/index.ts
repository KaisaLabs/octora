/**
 * Production adapter classes for the Private Position Close flow
 * (close/01 + close/02 + close/06). See each module's file-level doc
 * for scope-down notes and the context-resolver migration plan.
 */
export {
  createProductionCloseAdapter,
  CloseOrchestrationWiringIncompleteError,
  type CloseOrchestrationPositionContext,
  type CloseContextResolver,
  type ProductionCloseAdapterDeps,
} from "./production-close.adapter";

export {
  createProductionCloseQuoteAdapter,
  CloseQuoteWiringIncompleteError,
  type CloseQuotePositionContext,
  type CloseQuoteContextResolver,
  type ProductionCloseQuoteAdapterDeps,
} from "./production-close-quote.adapter";

// production-ix-wiring/02 — per-position context resolver (Option B).
export {
  createInMemoryCloseContextResolver,
  MissingPositionContextError,
  type CloseContextEntry,
  type CloseContextResolverService,
} from "./close-context-resolver";

// production-ix-wiring/02 — per-leg builders for close/06.
export {
  createCloseBuilderLegBuilders,
  type CloseBuilderLegBuildersDeps,
} from "./close-builder-leg-builders";
