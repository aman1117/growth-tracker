import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { gl } from '../services/goodlogs';
import { GoodLogsProvider } from './GoodLogsProvider';

describe('GoodLogsProvider', () => {
  it('renders its children', () => {
    render(
      <GoodLogsProvider>
        <p>App content</p>
      </GoodLogsProvider>
    );

    expect(screen.getByText('App content')).toBeInTheDocument();
  });

  it('flushes and stops analytics only when the app unmounts', () => {
    const { rerender, unmount } = render(
      <GoodLogsProvider>
        <p>App content</p>
      </GoodLogsProvider>
    );
    rerender(
      <GoodLogsProvider>
        <p>Updated content</p>
      </GoodLogsProvider>
    );
    expect(gl.shutdown).not.toHaveBeenCalled();

    unmount();

    expect(gl.shutdown).toHaveBeenCalledTimes(1);
  });
});
