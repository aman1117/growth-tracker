import { describe, expect, it } from 'vitest';

import * as search from '.';
import { UserSearchAutocomplete } from './UserSearchAutocomplete';

describe('search components entry point', () => {
  it('exposes the user search as a named and the default export', () => {
    expect({ ...search }).toEqual({
      default: UserSearchAutocomplete,
      UserSearchAutocomplete,
    });
  });
});
