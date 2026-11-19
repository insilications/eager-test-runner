import { performance } from "node:perf_hooks";

import type { TestData } from "./test-data.mjs";

/** A lifecycle scoped to one test. Registrations are disposed in LIFO order. */
export class ResourceScope {
  readonly #cleanups: Array<() => void | Promise<void>> = [];
  #closed: boolean = false;

  /**
   * Initialize a resource and register its cleanup operation.
   *
   * The caller must ensure that all acquisitions have completed before
   * disposing of the scope. In particular, `acquire()` must not run
   * concurrently with `dispose()`.
   *
   * This method checks whether the scope is closed before awaiting the
   * initializer. If disposal occurs while initialization is pending,
   * the resource could finish initializing after the scope has closed,
   * causing its cleanup to be registered too late to execute.
   *
   * The test runner guarantees this ordering by awaiting resource
   * initialization before disposing of the scope. Extension providers
   * must settle their acquisitions before they return or throw.
   *
   * If initialization fails after partially acquiring a resource,
   * the initializer is responsible for cleaning up that partial state.
   */
  public async acquire<T>(
    initialize: () => T | Promise<T>,
    cleanup: (resource: T) => void | Promise<void>,
  ): Promise<T> {
    if (this.#closed) {
      throw new Error("Cannot acquire a resource in a closed scope.");
    }

    const resource: Awaited<T> = await initialize();
    // The initializer owns cleanup of any partial state if it throws.
    this.#cleanups.push((): void | Promise<void> => cleanup(resource));
    return resource;
  }

  /** Attempt every cleanup in strict LIFO order. */
  public async dispose(): Promise<unknown[]> {
    if (this.#closed) {
      return [];
    }

    this.#closed = true;

    const errors: unknown[] = [];

    while (this.#cleanups.length > 0) {
      const cleanup: (() => void | Promise<void>) | undefined = this.#cleanups.pop();

      if (cleanup === undefined) {
        break;
      }

      try {
        // oxlint-disable-next-line no-await-in-loop
        await cleanup();
      } catch (error: unknown) {
        errors.push(error);
      }
    }

    return errors;
  }
}

export type TestResult =
  | Readonly<{ durationMS: number; status: "passed"; title: string }>
  | Readonly<{ durationMS: number; error: unknown; status: "failed"; title: string }>;

export interface RunnerOptions {
  readonly dataId?: string;
  readonly isHeadless?: boolean;
  readonly willAttachConsole?: boolean;
}

/** Final options and the resource scope for this particular test execution. */
export interface TestInfo extends RunnerOptions {
  readonly scope: ResourceScope;
  readonly title: string;
}

type Awaitable<T> = T | Promise<T>;

export type TestBody<Context> = (context: Context, info: TestInfo) => Awaitable<void>;

type Disjoint<Context, Extra> = Extra & { [Key in keyof Context]?: never };

type Merge<Context extends object, Extra extends object> = [Awaited<Extra>] extends [never]
  ? Context
  : [keyof Context] extends [never]
    ? Extra
    : [keyof Extra] extends [never]
      ? Context
      : Context & Extra;

/** A provider may only return new fields, even when an existing field has the same type. */
export type Provider<Context extends object, Extra extends object> = (
  context: Readonly<Context>,
  info: TestInfo,
) => Disjoint<Context, Extra> | Promise<Disjoint<Context, Extra>>;

export type WithTestData<Context extends object = object> = Merge<
  Context,
  { readonly testData: TestData }
>;

export type TestDataLoader =
  | ReadonlyMap<string, TestData>
  | ((dataId: string, info: TestInfo) => Awaitable<TestData | undefined>);

export interface TestRunner<Context extends object = object> {
  readonly configure: (options: RunnerOptions) => TestRunner<Context>;
  readonly extend: <Extra extends object>(
    provide: Provider<Context, Extra>,
  ) => TestRunner<Merge<Context, Extra>>;
  (title: string, body: TestBody<Context>): void;
}

export interface TestSuite {
  readonly run: () => Promise<readonly TestResult[]>;
  readonly test: TestRunner;
}

type ResolveContext<Context extends object> = (info: TestInfo) => Promise<Context>;

interface RegisteredTest {
  readonly execute: (scope: ResourceScope) => Promise<void>;
  readonly title: string;
}

/** Contexts are records of own enumerable fields. Their values can be arbitrary resources. */
function addFields<Context extends object, Extra extends object>(
  context: Context,
  extra: Extra,
): Merge<Context, Extra> {
  // Types can hide fields, e.g. when a provider returns a dynamically keyed object.
  for (const key of Reflect.ownKeys(extra)) {
    if (Object.hasOwn(context, key)) {
      throw new Error(`Test context already contains the key "${String(key)}".`);
    }
  }
  return Object.freeze({ ...context, ...extra });
}

function extendContext<Context extends object, Extra extends object>(
  resolve: ResolveContext<Context>,
  provide: Provider<Context, Extra>,
): ResolveContext<Merge<Context, Extra>> {
  return async (info: TestInfo): Promise<Merge<Context, Extra>> => {
    const context: Context = await resolve(info);
    const extra: Extra = await provide(context, info);
    return addFields(context, extra);
  };
}

/** Provide `testData` by resolving the effective `info.dataId` against a map or loader. */
export function provideTestData(
  source: TestDataLoader,
): (_context: Readonly<object>, info: TestInfo) => Promise<{ readonly testData: TestData }> {
  return async (
    _context: Readonly<object>,
    info: TestInfo,
  ): Promise<{ readonly testData: TestData }> => {
    const { dataId, title } = info;
    if (dataId === undefined) {
      throw new Error(`No test data ID configured in test "${title}".`);
    }
    const testData: TestData | undefined =
      typeof source === "function" ? await source(dataId, info) : source.get(dataId);
    if (testData === undefined) {
      throw new Error(`Unknown test data ID "${dataId}" in test "${title}".`);
    }
    return { testData };
  };
}

/** Create an isolated test suite queue and its root composable `test` handle. */
export function createTestSuite(options?: RunnerOptions): TestSuite {
  const registry: RegisteredTest[] = [];
  let isRunning: boolean = false;

  function register<Context extends object>(
    resolveContext: ResolveContext<Context>,
    currentOptions: RunnerOptions,
  ): (title: string, body: TestBody<Context>) => void {
    return (title: string, body: TestBody<Context>): void => {
      // Capture the resolver and its matching body while Context is still known.
      registry.push({
        execute: async (scope: ResourceScope): Promise<void> => {
          const info: TestInfo = Object.freeze({ ...currentOptions, scope, title });
          const resolvedContext: Context = await resolveContext(info);
          await body(resolvedContext, info);
        },
        title,
      });
    };
  }

  function build<Context extends object>(
    resolve: ResolveContext<Context>,
    currentOptions: RunnerOptions,
  ): TestRunner<Context> {
    return Object.assign(register(resolve, currentOptions), {
      configure: (overrides: RunnerOptions): TestRunner<Context> =>
        build(resolve, { ...currentOptions, ...overrides }),
      extend: <Extra extends object>(
        provide: Provider<Context, Extra>,
      ): TestRunner<Merge<Context, Extra>> =>
        build(extendContext(resolve, provide), currentOptions),
    });
  }

  async function runOne(item: RegisteredTest): Promise<TestResult> {
    const startedAt: number = performance.now();
    const scope = new ResourceScope();
    const errors: unknown[] = [];

    try {
      await item.execute(scope);
    } catch (caught: unknown) {
      // An error can be literally `undefined`, so use the array length.
      errors.push(caught);
    } finally {
      // Includes resources successfully acquired before partial setup failure.
      const cleanupErrors: unknown[] = await scope.dispose();
      errors.push(...cleanupErrors);
    }

    const durationMS: number = performance.now() - startedAt;
    if (errors.length === 0) {
      return { durationMS, status: "passed", title: item.title };
    }

    const error: unknown =
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `Multiple failures in test "${item.title}".`);

    return { durationMS, error, status: "failed", title: item.title };
  }

  async function run(): Promise<readonly TestResult[]> {
    if (isRunning) {
      throw new Error("This test runner is already running.");
    }
    isRunning = true;
    try {
      // Tests registered during execution are retained for the *next* run.
      const queued: RegisteredTest[] = registry.splice(0);
      const results: TestResult[] = [];
      for (const item of queued) {
        // oxlint-disable-next-line no-await-in-loop
        results.push(await runOne(item));
      }
      return results;
    } finally {
      // biome-ignore lint/nursery/useAtomicUpdates: The synchronous guard ensures only one run can own and reset this state.
      isRunning = false;
    }
  }

  const emptyContext: object = Object.freeze({});
  const initialOptions: RunnerOptions = { ...options };
  return {
    run,
    test: build((): Promise<object> => Promise.resolve(emptyContext), initialOptions),
  };
}
