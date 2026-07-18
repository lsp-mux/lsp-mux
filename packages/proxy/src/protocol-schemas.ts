/*
 * Valibot schemas for the LSP/JSON-RPC message shapes the proxy inspects.
 * Only the params the proxy actually reads are modeled; everything else
 * passes through untouched.
 */
import * as v from 'valibot';
import { lspMessageType } from './types.ts';

export const CancelParamsSchema = v.object({
  id: v.union([v.number(), v.string()]),
});

export const PublishDiagnosticsSchema = v.object({
  uri: v.string(),
  diagnostics: v.array(v.unknown()),
});

const OptionalNullableStringSchema = v.optional(v.nullable(v.string()));

export const InitializeParamsSchema = v.object({
  rootUri: OptionalNullableStringSchema,
});

const RegistrationSchema = v.object({
  id: v.string(),
  method: v.string(),
  registerOptions: v.optional(v.unknown()),
});

export const RegisterCapabilitySchema = v.object({
  registrations: v.array(RegistrationSchema),
});

const UnregistrationSchema = v.object({
  id: v.string(),
  method: v.string(),
});

export const UnregisterCapabilitySchema = v.object({
  unregisterations: v.array(UnregistrationSchema),
});

const ConfigurationItemSchema = v.object({
  scopeUri: OptionalNullableStringSchema,
  section: OptionalNullableStringSchema,
});

export const WorkspaceConfigurationSchema = v.object({
  items: v.array(ConfigurationItemSchema),
});

export const LogMessageSchema = v.object({
  type: v.pipe(
    v.number(),
    v.transform((type): 'error' | 'warn' | 'info' | 'debug' => {
      if (type === lspMessageType.Error) return 'error';
      if (type === lspMessageType.Warning) return 'warn';
      return type === lspMessageType.Info ? 'info' : 'debug';
    }),
  ),
  message: v.string(),
});
