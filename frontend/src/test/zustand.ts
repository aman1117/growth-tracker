/**
 * Store isolation for tests.
 *
 * Zustand stores are module singletons, so state written by one test would leak into the
 * next. The setup file mocks `zustand` so that `create`/`createStore` behave exactly like the
 * real ones but remember each store's initial state; `resetAllStores()` restores them after
 * every test.
 */
import type * as Zustand from 'zustand';

type ZustandModule = typeof Zustand;

const resetFns = new Set<() => void>();

function track<T>(store: Zustand.StoreApi<T>) {
  const initialState = store.getInitialState();
  resetFns.add(() => store.setState(initialState, true));
  return store;
}

/** Wraps the real module's factories so every store they create can be reset. */
export function withResettableStores(actual: ZustandModule): ZustandModule {
  const create = (<T>(stateCreator?: Zustand.StateCreator<T>) => {
    const build = (creator: Zustand.StateCreator<T>) => track(actual.create(creator));
    return typeof stateCreator === 'function' ? build(stateCreator) : build;
  }) as ZustandModule['create'];

  const createStore = (<T>(stateCreator?: Zustand.StateCreator<T>) => {
    const build = (creator: Zustand.StateCreator<T>) => track(actual.createStore(creator));
    return typeof stateCreator === 'function' ? build(stateCreator) : build;
  }) as ZustandModule['createStore'];

  return { ...actual, create, createStore };
}

/** Restores every store created so far to its initial state. */
export function resetAllStores() {
  resetFns.forEach((reset) => reset());
}
