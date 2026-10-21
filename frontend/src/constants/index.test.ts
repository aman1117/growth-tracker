import { describe, expect, it } from 'vitest';

import * as activities from './activities';
import * as colors from './colors';
import * as icons from './icons';
import * as constants from './index';
import * as routes from './routes';
import * as storage from './storage';
import * as tokens from './tokens';
import * as ui from './ui';
import * as validation from './validation';

describe('constants barrel', () => {
  it.each(Object.entries({ activities, colors, icons, routes, storage, ui, validation }))(
    're-exports everything from %s',
    (_name, module) => {
      Object.entries(module).forEach(([exportName, value]) => {
        expect(constants).toHaveProperty(exportName, value);
      });
    }
  );

  it('keeps the design tokens separate, so BREAKPOINTS are the UI ones', () => {
    expect(constants.BREAKPOINTS).toBe(ui.BREAKPOINTS);
    expect(constants.BREAKPOINTS).not.toBe(tokens.BREAKPOINTS);
    expect(constants).not.toHaveProperty('SPACING');
  });
});
