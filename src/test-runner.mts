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
   * initialization before disposing of the scope. Both resource factories
   * and extension providers must settle their acquisitions before they
   * return or throw.
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
  | Readonly<{ title: string; status: "passed"; durationMS: number }>
  | Readonly<{ title: string; status: "failed"; durationMS: number; error: unknown }>;

export interface RunnerOptions {
  readonly isHeadless?: boolean;
  readonly willAttachConsole?: boolean;
}

/** Final options and the resource scope for this particular test execution. */
export interface TestInfo extends RunnerOptions {
  readonly dataId: string | undefined;
  readonly scope: ResourceScope;
  readonly title: string;
}

type Awaitable<T> = T | Promise<T>;
export type TestBody<Context> = (context: Context) => Awaitable<void>;
export type WithTestData<Context> = Context & { readonly testData: TestData };

// A provider may only return new fields, even when an existing field has the same type.
type Provider<Context, Extra extends object> = (
  context: Readonly<Context>,
  info: TestInfo,
) => Awaitable<Extra & { [Key in keyof Context]?: never }>;

type AvailableDataId<Context> = "testData" extends keyof Context ? never : string;

export interface TestRunner<Context extends object> {
  readonly configure: (options: RunnerOptions) => TestRunner<Context>;
  readonly extend: <Extra extends object>(
    provide: Provider<Context, Extra>,
  ) => TestRunner<Context & Extra>;
  readonly withData: (id: AvailableDataId<Context>) => TestRunner<WithTestData<Context>>;
  (title: string, body: TestBody<Context>): void;
}

/** This handle already supplies testData and still accepts one explicit ID. */
export interface FallbackTestRunner<
  Context extends WithTestData<object>,
> extends TestRunner<Context> {
  readonly configure: (options: RunnerOptions) => FallbackTestRunner<Context>;
  readonly extend: <Extra extends object>(
    provide: Provider<Context, Extra>,
  ) => FallbackTestRunner<Context & Extra>;
  readonly withData: (id: string) => TestRunner<Context>;
}

export interface TestSuite<Context extends object> extends TestRunner<Context> {
  readonly run: () => Promise<readonly TestResult[]>;
}

export interface FallbackTestSuite<
  Context extends WithTestData<object>,
> extends FallbackTestRunner<Context> {
  readonly run: () => Promise<readonly TestResult[]>;
}

type ResolveContext<Context> = (info: TestInfo) => Awaitable<Context>;

interface SuiteConfig<Resources extends object> {
  readonly createResources: ResolveContext<Resources>;
  readonly loadTestData: (dataId: string, info: TestInfo) => Awaitable<TestData | undefined>;
  readonly options?: RunnerOptions;
}

export interface TestRunnerConfig<Resources extends object> extends SuiteConfig<Resources> {
  readonly dataId?: undefined;
}

export interface DefaultDataConfig<Resources extends object> extends SuiteConfig<Resources> {
  readonly dataId: AvailableDataId<Resources>;
}

interface RegisteredTest {
  readonly execute: (scope: ResourceScope) => Promise<void>;
  readonly title: string;
}

/** Contexts are records of own enumerable fields. Their values can be arbitrary resources. */
function addFields<Context extends object, Extra extends object>(
  context: Context,
  extra: Extra,
): Context & Extra {
  // Types can hide fields, e.g. when a provider reads a dynamic key.
  for (const key of Reflect.ownKeys(extra)) {
    if (Object.hasOwn(context, key)) {
      throw new Error(`Test context already contains the key "${String(key)}".`);
    }
  }
  return { ...context, ...extra };
}

function extendContext<Context extends object, Extra extends object>(
  resolve: ResolveContext<Context>,
  provide: Provider<Context, Extra>,
): ResolveContext<Context & Extra> {
  return async (info: TestInfo): Promise<Context & Extra> => {
    const context: Awaited<Context> = await resolve(info);
    return addFields<Context, Extra>(context, await provide(context, info));
  };
}

/** Each public factory creates one queue. All handles derived from it share that queue. */
// : { plain: () => TestSuite<Resources>, withDefaultData: (id: string) => FallbackTestSuite<WithTestData<Resources>>  }
function createSuite<Resources extends object>(
  config: SuiteConfig<Resources>,
): {
  plain: () => TestSuite<Resources>;
  withDefaultData: (id: string) => FallbackTestSuite<WithTestData<Resources>>;
} {
  const registry: RegisteredTest[] = [];
  let isRunning: boolean = false;

  function register<Context extends object>(
    resolveContext: ResolveContext<Context>,
    options: RunnerOptions,
    dataId: string | undefined,
  ): (title: string, body: TestBody<Context>) => void {
    console.debug(`Building test runner with data ID: ${dataId} and options:`, options);
    return (title: string, body: TestBody<Context>): void => {
      // Capture the resolver and its matching body while Context is still known.
      registry.push({
        execute: async (scope: ResourceScope): Promise<void> => {
          const info: TestInfo = Object.freeze({ ...options, dataId, scope, title });
          console.debug(
            `Running test: "${title}" with data ID: "${dataId ?? "none"}" and options:`,
            options,
          );
          const resolvedContext: Awaited<Context> = await resolveContext(info);

          await body(resolvedContext);
        },
        title,
      });
    };
  }

  function resolveWithData<Context extends object>(
    parent: ResolveContext<Context>,
    initialId: string,
  ): ResolveContext<WithTestData<Context>> {
    return async (info: TestInfo): Promise<WithTestData<Context>> => {
      // This stage runs once per test, using the final handle's ID before any resource setup.
      const id: string = info.dataId ?? initialId;
      const testData: TestData | undefined = await config.loadTestData(id, info);
      if (testData === undefined) {
        throw new Error(`Unknown test data ID "${id}" in test "${info.title}".`);
      }
      return addFields(await parent(info), { testData });
    };
  }

  function build<Context extends object>(
    resolve: ResolveContext<Context>,
    options: RunnerOptions,
    selectedId?: string,
  ): TestRunner<Context> {
    return Object.assign(register(resolve, options, selectedId), {
      configure: (overrides: RunnerOptions): TestRunner<Context> =>
        build(resolve, { ...options, ...overrides }, selectedId),
      extend: <Extra extends object>(
        provide: Provider<Context, Extra>,
      ): TestRunner<Context & Extra> => build(extendContext(resolve, provide), options, selectedId),
      withData(id: string): TestRunner<WithTestData<Context>> {
        if (selectedId !== undefined) {
          throw new Error(`Test data "${selectedId}" is already selected on this runner.`);
        }
        return build(resolveWithData(resolve, id), options, id);
      },
    });
  }

  function buildFallback<Context extends WithTestData<object>>(
    resolve: ResolveContext<Context>,
    options: RunnerOptions,
    defaultId: string,
  ): FallbackTestRunner<Context> {
    return Object.assign(register(resolve, options, defaultId), {
      configure: (overrides: RunnerOptions): FallbackTestRunner<Context> =>
        buildFallback(resolve, { ...options, ...overrides }, defaultId),
      extend: <Extra extends object>(
        provide: Provider<Context, Extra>,
      ): FallbackTestRunner<Context & Extra> =>
        buildFallback(extendContext(resolve, provide), options, defaultId),
      // The resolver already installs the fixture. The child only selects its final ID.
      withData: (id: string): TestRunner<Context> => build(resolve, options, id),
    });
  }

  async function runOne(item: RegisteredTest): Promise<TestResult> {
    const startedAt: number = performance.now();
    const scope = new ResourceScope();
    const errors: unknown[] = [];

    try {
      await item.execute(scope);
    } catch (err: unknown) {
      // An error can be literally `undefined`, so use the array length.
      errors.push(err);
    } finally {
      // Includes resources successfully acquired before partial setup failure.
      // biome-ignore lint/nursery/noUnreadableForOfExpression: OK
      for (const err of await scope.dispose()) {
        errors.push(err);
      }
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

  const createSuiteOptions: RunnerOptions = { ...config.options };
  // oxlint-disable-next-line legibility/no-trivial-wrapper-functions
  const createSuiteResolve: ResolveContext<Resources> = (info: TestInfo): Awaitable<Resources> =>
    config.createResources(info);
  return {
    plain: (): TestSuite<Resources> =>
      Object.assign(build(createSuiteResolve, createSuiteOptions), { run }),
    withDefaultData: (id: string): FallbackTestSuite<WithTestData<Resources>> =>
      Object.assign(
        buildFallback(resolveWithData(createSuiteResolve, id), createSuiteOptions, id),
        { run },
      ),
  };
}

export function createTestRunner<Resources extends object>(
  config: TestRunnerConfig<Resources>,
): TestSuite<Resources> {
  const dataId: unknown = config.dataId;
  if (dataId !== undefined) {
    throw new TypeError("Use createTestRunner.withDefaultData() to set a suite data ID.");
  }
  return createSuite(config).plain();
}

createTestRunner.withDefaultData = function withDefaultData<Resources extends object>(
  config: DefaultDataConfig<Resources>,
): FallbackTestSuite<WithTestData<Resources>> {
  const id: string = config.dataId;
  if (typeof id !== "string") {
    throw new TypeError("createTestRunner.withDefaultData() requires a string dataId.");
  }
  return createSuite(config).withDefaultData(id);
};
