import { describe, it } from 'vitest';
import { analyzeClientCapabilities } from '../src/client-capabilities.js';

describe('analyzeClientCapabilities', () => {
  describe('localFileWatching', () => {
    it('enabled when capabilities are empty', ({ expect }) => {
      const { localFileWatching } = analyzeClientCapabilities({ capabilities: {} });
      expect(localFileWatching).toBe(true);
    });

    it('enabled when params is null', ({ expect }) => {
      const { localFileWatching } = analyzeClientCapabilities(null);
      expect(localFileWatching).toBe(true);
    });

    it('enabled when params is undefined', ({ expect }) => {
      const { localFileWatching } = analyzeClientCapabilities(undefined);
      expect(localFileWatching).toBe(true);
    });

    it('enabled when workspace is missing', ({ expect }) => {
      const { localFileWatching } = analyzeClientCapabilities({
        capabilities: { textDocument: {} },
      });
      expect(localFileWatching).toBe(true);
    });

    it('enabled when didChangeWatchedFiles is missing', ({ expect }) => {
      const { localFileWatching } = analyzeClientCapabilities({
        capabilities: { workspace: { applyEdit: true } },
      });
      expect(localFileWatching).toBe(true);
    });

    it('enabled when dynamicRegistration is false', ({ expect }) => {
      const { localFileWatching } = analyzeClientCapabilities({
        capabilities: {
          workspace: {
            didChangeWatchedFiles: { dynamicRegistration: false },
          },
        },
      });
      expect(localFileWatching).toBe(true);
    });

    it('disabled when dynamicRegistration is true', ({ expect }) => {
      const { localFileWatching } = analyzeClientCapabilities({
        capabilities: {
          workspace: {
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
      });
      expect(localFileWatching).toBe(false);
    });

    it('handles extra fields alongside dynamicRegistration', ({ expect }) => {
      const { localFileWatching } = analyzeClientCapabilities({
        capabilities: {
          workspace: {
            didChangeWatchedFiles: {
              dynamicRegistration: true,
              relativePatternSupport: true,
            },
          },
        },
      });
      expect(localFileWatching).toBe(false);
    });
  });

  describe('proactivePullDiagnostics', () => {
    it('enabled when capabilities are empty', ({ expect }) => {
      const { proactivePullDiagnostics } = analyzeClientCapabilities({ capabilities: {} });
      expect(proactivePullDiagnostics).toBe(true);
    });

    it('enabled when textDocument is missing', ({ expect }) => {
      const { proactivePullDiagnostics } = analyzeClientCapabilities({
        capabilities: { workspace: {} },
      });
      expect(proactivePullDiagnostics).toBe(true);
    });

    it('enabled when diagnostic is missing from textDocument', ({ expect }) => {
      const { proactivePullDiagnostics } = analyzeClientCapabilities({
        capabilities: { textDocument: { hover: {} } },
      });
      expect(proactivePullDiagnostics).toBe(true);
    });

    it('enabled when dynamicRegistration is false', ({ expect }) => {
      const { proactivePullDiagnostics } = analyzeClientCapabilities({
        capabilities: {
          textDocument: {
            diagnostic: { dynamicRegistration: false },
          },
        },
      });
      expect(proactivePullDiagnostics).toBe(true);
    });

    it('disabled when dynamicRegistration is true', ({ expect }) => {
      const { proactivePullDiagnostics } = analyzeClientCapabilities({
        capabilities: {
          textDocument: {
            diagnostic: { dynamicRegistration: true },
          },
        },
      });
      expect(proactivePullDiagnostics).toBe(false);
    });
  });

  it('analyzes all flags independently', ({ expect }) => {
    const flags = analyzeClientCapabilities({
      capabilities: {
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: true },
        },
        textDocument: {
          diagnostic: { dynamicRegistration: true },
        },
      },
    });
    expect(flags).toEqual({
      localFileWatching: false,
      proactivePullDiagnostics: false,
    });
  });
});
