import { describe, expect, it, vi } from 'vitest';

import * as story from '.';
import { StoryCircle } from './StoryCircle';
import { StoryCirclesRow } from './StoryCirclesRow';
import { StoryViewer } from './StoryViewer';

// useThemeStore reads matchMedia while modules load, before setup.ts stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

describe('story components entry point', () => {
  it('re-exports every story component', () => {
    expect({ ...story }).toEqual({ StoryCircle, StoryCirclesRow, StoryViewer });
  });
});
