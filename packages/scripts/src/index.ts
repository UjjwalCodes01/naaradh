export {
  DISCLOSURES,
  SUPPORTED_LOCALES,
  normaliseForMatch,
  type DisclosurePhrases,
} from './disclosures.js';
export {
  USE_CASES,
  VARIABLES_ALLOWED,
  FORBIDDEN_TOPICS_REQUIRED,
  ScriptTemplateSchema,
  BranchSchema,
  variableRefs,
  type UseCase,
  type ScriptTemplate,
} from './template.js';
export {
  validateScript,
  OPENING_MAX_CHARS,
  type ValidationError,
  type ValidationResult,
} from './validate.js';
export {
  sanitiseVariables,
  sanitiseValue,
  looksLikeInjection,
  VARIABLE_MAX_CHARS,
  type SanitisedVariables,
} from './variables.js';
export { renderScript, substitute, GLOBAL_GUARDRAILS, type RenderedScript } from './render.js';
export {
  EXTRACTION_SCHEMAS,
  parseExtraction,
  CodConfirmExtraction,
  AbandonedCartExtraction,
  LeadCallbackExtraction,
  AppointmentExtraction,
  InboundSupportExtraction,
  type ExtractionName,
  type Extraction,
  type ParseExtractionResult,
} from './extraction.js';
export {
  DEFAULT_TEMPLATES,
  COD_CONFIRM_HI_IN,
  COD_CONFIRM_EN_IN,
  LEAD_CALLBACK_EN_IN,
  ABANDONED_CART_HI_IN,
} from './templates.js';

// Inbound (ADR-0006)
export {
  TOOL_NAMES,
  TOOL_SPECS,
  TOOL_TIMEOUT_MS,
  TICKET_CATEGORIES,
  ToolArgs,
  isToolName,
  toolDefinitions,
  OUTBOUND_TOOLS,
  type ToolDefinitionShape,
  type ToolName,
  type ToolArgsOf,
  type ToolSpec,
} from './inbound/tools.js';
export {
  validateInboundProfile,
  greetingDiscloses,
  sanitiseMerchantText,
  InboundProfileInput,
  DEFAULT_INBOUND_GREETINGS,
  DEFAULT_CLOSED_MESSAGES,
  DEFAULT_ABUSE_MESSAGES,
  type ProfileValidation,
  type ProfileValidationError,
} from './inbound/profile.js';
export {
  renderInboundPrompt,
  INBOUND_GUARDRAILS,
  TOOL_RULES,
  type InboundPromptInput,
  type RenderedInbound,
} from './inbound/prompt.js';
