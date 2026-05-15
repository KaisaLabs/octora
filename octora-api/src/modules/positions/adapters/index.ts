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
