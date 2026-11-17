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
   * initialization before disposing of the scope. Resource factories
   * must therefore await all acquisitions instead of launching them
   * as detached asynchronous operations.
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
      const cleanup = this.#cleanups.pop();

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

export interface TestOptions {
  readonly dataId: string;
}

export type TestBody<Context> = (context: Context) => void | Promise<void>;
export type WithTestData<Resources> = Resources & { readonly testData: TestData };

type ResourceFactory<Resources extends object> = (
  scope: ResourceScope,
  testOptions?: TestOptions,
) => Resources | Promise<Resources>;

/** Overloaded callable with a separate execution phase. */
export interface TestFunction<Resources extends object> {
  run: () => Promise<readonly TestResult[]>;
  (title: string, callback: TestBody<Resources>): void;
  (title: string, testOptions: TestOptions, callback: TestBody<WithTestData<Resources>>): void;
}

interface RegisteredTest<Resources extends object> {
  readonly execute: (resources: Resources, testData: TestData | undefined) => void | Promise<void>;
  readonly testOptions?: TestOptions;
  readonly title: string;
}

/** Create an isolated test registry, sharing one eager resource factory per test. */
export function createTestRunner<Resources extends object>(
  createResources: ResourceFactory<Resources>,
  testDataRegistry: ReadonlyMap<string, TestData>,
): TestFunction<Resources> {
  const registry: RegisteredTest<Resources>[] = [];
  let isRunning: boolean = false;

  function test(title: string, callback: TestBody<Resources>): void;

  function test(
    title: string,
    testOptions: TestOptions,
    callback: TestBody<WithTestData<Resources>>,
  ): void;
  function test(
    title: string,
    testOptionsOrCallback: TestOptions | TestBody<Resources>,
    callbackWithData?: TestBody<WithTestData<Resources>>,
  ): void {
    if (typeof testOptionsOrCallback === "function") {
      registry.push({ execute: testOptionsOrCallback, title });
      return;
    }

    if (callbackWithData === undefined) {
      throw new TypeError(`Test "${title}" needs a callback.`);
    }

    registry.push({
      execute: (resources: Resources, testData: TestData | undefined): void | Promise<void> => {
        // run() has resolved this ID before resource initialization.
        if (testData === undefined) {
          throw new Error(`Test data "${testOptionsOrCallback.dataId}" was not resolved.`);
        }
        return callbackWithData({ ...resources, testData });
      },
      testOptions: testOptionsOrCallback,
      title,
    });
  }

  async function runOne(item: RegisteredTest<Resources>): Promise<TestResult> {
    const startedAt: number = performance.now();
    const scope = new ResourceScope();
    const errors: unknown[] = [];

    try {
      // Look up metadata first; no snapshot file contents are loaded.
      const testData: TestData | undefined =
        item.testOptions === undefined ? undefined : testDataRegistry.get(item.testOptions.dataId);
      if (item.testOptions !== undefined && testData === undefined) {
        throw new Error(
          `Unknown test data ID "${item.testOptions.dataId}" in test "${item.title}".`,
        );
      }

      // All resources initialize, regardless of callback destructuring.
      const resources: Awaited<Resources> = await createResources(scope, item.testOptions);
      console.log(
        `1 Running test: "${item.title}" with data ID: "${item.testOptions?.dataId ?? "none"}"`,
      );
      await item.execute(resources, testData);
    } catch (err: unknown) {
      // An error can be literally `undefined`, so use the array length.
      errors.push(err);
    } finally {
      // Includes resources successfully acquired before partial setup failure.
      errors.push(...(await scope.dispose()));
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
      const queued: RegisteredTest<Resources>[] = registry.splice(0);
      const results: TestResult[] = [];
      for (const item of queued) {
        console.log(
          `0 Running test: "${item.title}" with data ID: "${item.testOptions?.dataId ?? "none"}"`,
        );

        // oxlint-disable-next-line no-await-in-loop
        results.push(await runOne(item));
      }
      return results;
    } finally {
      // biome-ignore lint/nursery/useAtomicUpdates: The synchronous guard ensures only one run can own and reset this state.
      isRunning = false;
    }
  }

  return Object.assign(test, { run });
}
