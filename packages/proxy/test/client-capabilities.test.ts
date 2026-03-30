import { describe, it } from 'vitest';
import { analyzeClientCapabilities } from '../src/client-capabilities.js';

describe('analyzeClientCapabilities', () => {
  it('enables localFileWatching when capabilities are empty', ({ expect }) => {
    expect(analyzeClientCapabilities({ capabilities: {} })).toEqual({
      localFileWatching: true,
    });
  });

  it('enables localFileWatching when params is null', ({ expect }) => {
    expect(analyzeClientCapabilities(null)).toEqual({
      localFileWatching: true,
    });
  });

  it('enables localFileWatching when params is undefined', ({ expect }) => {
    expect(analyzeClientCapabilities(undefined)).toEqual({
      localFileWatching: true,
    });
  });

  it('enables localFileWatching when workspace is missing', ({ expect }) => {
    expect(analyzeClientCapabilities({
      capabilities: { textDocument: {} },
    })).toEqual({ localFileWatching: true });
  });

  it('enables localFileWatching when didChangeWatchedFiles is missing', ({ expect }) => {
    expect(analyzeClientCapabilities({
      capabilities: { workspace: { applyEdit: true } },
    })).toEqual({ localFileWatching: true });
  });

  it('enables localFileWatching when dynamicRegistration is false', ({ expect }) => {
    expect(analyzeClientCapabilities({
      capabilities: {
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: false },
        },
      },
    })).toEqual({ localFileWatching: true });
  });

  it('disables localFileWatching when dynamicRegistration is true', ({ expect }) => {
    expect(analyzeClientCapabilities({
      capabilities: {
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: true },
        },
      },
    })).toEqual({ localFileWatching: false });
  });

  it('handles extra fields alongside dynamicRegistration', ({ expect }) => {
    expect(analyzeClientCapabilities({
      capabilities: {
        workspace: {
          didChangeWatchedFiles: {
            dynamicRegistration: true,
            relativePatternSupport: true,
          },
        },
      },
    })).toEqual({ localFileWatching: false });
  });
});
