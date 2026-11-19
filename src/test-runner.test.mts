import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMockResources,
  MockApiClient,
  type MockPage,
  type MockResources,
  MockServer,
} from "./mock-resources.mjs";
import { TEST_DATA, type TestData } from "./test-data.mjs";
import type {
  ResourceScope,
  TestInfo,
  TestResult,
  TestRunner,
  TestSuite,
  WithTestData,
} from "./test-runner.mjs";
import { createTestSuite, provideTestData } from "./test-runner.mjs";

const neverRun = (): never => {
  throw new Error("Test body should not have executed.");
};

await test("interleaved handles share registration order and isolate their options and types", async (): Promise<void> => {
  interface BaseContext {
    readonly dataId: string | undefined;
    readonly isHeadless: boolean | undefined;
  }

  const started: string[] = [];
  let loads = 0;
  const suite: TestSuite = createTestSuite();
  const base: TestRunner<BaseContext> = suite.test.extend(
    (_ctx: Readonly<object>, { dataId, isHeadless, title }: TestInfo): BaseContext => {
      started.push(title);
      return { dataId, isHeadless };
    },
  );

  const mutableOptions = { isHeadless: true };
  const headless: TestRunner<BaseContext> = base.configure(mutableOptions);
  mutableOptions.isHeadless = false;

  const enriched: TestRunner<
    WithTestData<BaseContext> & {
      readonly attachConsole: boolean | undefined;
      readonly path: string;
    }
  > = headless
    .configure({ dataId: "Default" })
    .extend(
      provideTestData((id: string, info: TestInfo): TestData | undefined => {
        loads++;
        assert.equal(info.isHeadless, false);
        return TEST_DATA.get(id);
      }),
    )
    .extend(
      (
        { testData }: Readonly<WithTestData<BaseContext>>,
        info: TestInfo,
      ): { readonly attachConsole: boolean | undefined; readonly path: string } => ({
        attachConsole: info.willAttachConsole,
        path: testData.codemarkPath,
      }),
    )
    .configure({ isHeadless: false, willAttachConsole: true });

  // @ts-expect-error Only TestSuite owns run(); TestRunner handles cannot trigger execution.
  assert.equal(enriched.run, undefined);

  const rounds = 64;
  const titles: string[] = [];
  for (let i = 0; i < rounds; i++) {
    titles.push(`base ${i}`, `headless ${i}`, `data ${i}`);
    base(`base ${i}`, (context: BaseContext, info: TestInfo): void => {
      assert.equal(context.isHeadless, undefined);
      assert.equal(info.title, `base ${i}`);
      // @ts-expect-error The base context has no testData field until extended.
      assert.equal(context.testData, undefined);
    });
    headless(`headless ${i}`, ({ dataId, isHeadless }: BaseContext): void => {
      assert.equal(isHeadless, true);
      assert.equal(dataId, undefined);
    });
    enriched(
      `data ${i}`,
      ({
        attachConsole,
        dataId,
        isHeadless,
        path,
        testData,
      }: WithTestData<BaseContext> & {
        readonly attachConsole: boolean | undefined;
        readonly path: string;
      }): void => {
        assert.equal(isHeadless, false);
        assert.equal(dataId, "Default");
        assert.equal(path, testData.codemarkPath);
        assert.equal(attachConsole, true);
      },
    );
  }

  assert.deepEqual(started, []);
  assert.equal(loads, 0);
  const results: readonly TestResult[] = await suite.run();
  assert.deepEqual(
    results.filter(
      (result: TestResult): result is TestResult & { status: "failed" } =>
        result.status === "failed",
    ),
    [],
  );
  assert.deepEqual(
    results.map((result: TestResult): string => result.title),
    titles,
  );
  assert.deepEqual(started, titles);
  assert.equal(loads, rounds);
  assert.deepEqual(await suite.run(), []);
});

await test("suite defaults are inherited and chained overrides reach earlier providers", async (): Promise<void> => {
  interface Resources {
    readonly factoryInfo: TestInfo;
  }
  type Context = WithTestData<Resources>;
  type Extended = Context & { readonly providerPath: string };

  const loads: string[] = [];
  const starts: string[] = [];
  const initialOptions = {
    dataId: "Default",
    isHeadless: true,
    willAttachConsole: true,
  };
  const suite: TestSuite = createTestSuite(initialOptions);
  initialOptions.isHeadless = false;

  const base: TestRunner<Context> = suite.test
    .extend(
      provideTestData((id: string, info: TestInfo): TestData => {
        assert.equal(id, info.dataId);
        loads.push(`${info.title}:${id}:${info.isHeadless}:${info.willAttachConsole}`);
        return { codemarkPath: id, snapshots: [] };
      }),
    )
    .extend((_ctx: Readonly<WithTestData>, info: TestInfo): Resources => {
      starts.push(info.title);
      return { factoryInfo: info };
    });

  const derived: TestRunner<Extended> = base.extend(
    ({ factoryInfo, testData }: Readonly<Context>, info: TestInfo): { providerPath: string } => {
      assert.strictEqual(factoryInfo, info);
      assert.equal(testData.codemarkPath, info.dataId);
      return { providerPath: testData.codemarkPath };
    },
  );

  const custom: TestRunner<Extended> = derived
    .configure({ isHeadless: false })
    .configure({ dataId: "Other" })
    .configure({ willAttachConsole: false });

  // Unlike the old one-shot lock, further child branches can freely override dataId again.
  const reOverridden: TestRunner<Extended> = custom.configure({ dataId: "Third" });

  function checkBody({ factoryInfo, providerPath, testData }: Extended): void {
    assert.equal(factoryInfo.dataId, testData.codemarkPath);
    assert.equal(providerPath, testData.codemarkPath);
  }

  base("root", ({ testData }: Context): void => {
    assert.equal(testData.codemarkPath, "Default");
  });
  custom("custom", checkBody);
  derived("sibling", checkBody);
  reOverridden("re-overridden", checkBody);

  assert.deepEqual(loads, []);
  assert.deepEqual(starts, []);
  const results: readonly TestResult[] = await suite.run();
  assert.deepEqual(
    results.filter((result: TestResult): boolean => result.status === "failed"),
    [],
  );
  assert.deepEqual(loads, [
    "root:Default:true:true",
    "custom:Other:false:false",
    "sibling:Default:true:true",
    "re-overridden:Third:false:false",
  ]);
  assert.deepEqual(starts, ["root", "custom", "sibling", "re-overridden"]);
});

await test("steps execute in strict left-to-right order for data validation and resource unwinding", async (): Promise<void> => {
  const loads: string[] = [];
  const starts: string[] = [];
  const upfrontSuite: TestSuite = createTestSuite({ dataId: "missing default" });
  const upfrontRunner: TestRunner<WithTestData> = upfrontSuite.test
    .extend(
      provideTestData((id: string): Promise<TestData | undefined> => {
        loads.push(id);
        return Promise.resolve(
          id === "" ? { codemarkPath: "empty-id.json", snapshots: [] } : undefined,
        );
      }),
    )
    .extend((_ctx: Readonly<WithTestData>, { title }: TestInfo): object => {
      starts.push(title);
      return {};
    });

  upfrontRunner("bad default", neverRun);
  upfrontRunner.configure({ dataId: "missing override" })("bad override", neverRun);
  upfrontRunner.configure({ dataId: "" })("valid override", ({ testData }: WithTestData): void => {
    assert.equal(testData.codemarkPath, "empty-id.json");
  });

  // Also check missing dataId when a suite has no default dataId configured.
  const unconfiguredSuite: TestSuite = createTestSuite();
  unconfiguredSuite.test.extend(provideTestData(TEST_DATA))("missing id", neverRun);

  const [badDefault, badOverride, passed] = await upfrontSuite.run();
  assert.ok(badDefault?.status === "failed" && badDefault.error instanceof Error);
  assert.equal(
    badDefault.error.message,
    'Unknown test data ID "missing default" in test "bad default".',
  );
  assert.ok(badOverride?.status === "failed" && badOverride.error instanceof Error);
  assert.equal(
    badOverride.error.message,
    'Unknown test data ID "missing override" in test "bad override".',
  );
  assert.equal(passed?.status, "passed");
  assert.deepEqual(loads, ["missing default", "missing override", ""]);
  assert.deepEqual(starts, ["valid override"]);

  const [missingId] = await unconfiguredSuite.run();
  assert.ok(missingId?.status === "failed" && missingId.error instanceof Error);
  assert.equal(missingId.error.message, 'No test data ID configured in test "missing id".');

  // createMockResources statically requires WithTestData in context before it can be attached.
  const unseededSuite: TestSuite = createTestSuite();
  unseededSuite.test.extend((ctx: Readonly<object>, info: TestInfo): Promise<MockResources> =>
    // @ts-expect-error Context lacks testData until provideTestData is extended earlier in the chain.
    createMockResources(starts, ctx, info),
  );

  // When provideTestData is attached *after* independent scoped resources, earlier resources run first and unwind cleanly on failure.
  const lateEvents: string[] = [];
  const lateSuite: TestSuite = createTestSuite();
  const serverAndClient: TestRunner<{ apiClient: MockApiClient; server: MockServer }> =
    lateSuite.test.extend(
      async (
        _ctx: Readonly<object>,
        { scope }: TestInfo,
      ): Promise<{ apiClient: MockApiClient; server: MockServer }> => {
        const server: MockServer = await scope.acquire(
          (): Promise<MockServer> => MockServer.start(lateEvents),
          (value: MockServer): Promise<void> => value.close(),
        );
        const apiClient: MockApiClient = await scope.acquire(
          (): MockApiClient => new MockApiClient(lateEvents),
          (value: MockApiClient): Promise<void> => value.close(),
        );
        return { apiClient, server };
      },
    );
  serverAndClient.configure({ dataId: "missing" }).extend(provideTestData(TEST_DATA))(
    "late data failure",
    neverRun,
  );

  const [lateFailure] = await lateSuite.run();
  assert.ok(lateFailure?.status === "failed" && lateFailure.error instanceof Error);
  assert.equal(
    lateFailure.error.message,
    'Unknown test data ID "missing" in test "late data failure".',
  );
  assert.deepEqual(lateEvents, [
    "server: start",
    "apiClient: create",
    "apiClient: close",
    "server: close",
  ]);
});

await test("partial provider failure unwinds every prior acquisition in LIFO order and aggregates cleanup errors", async (): Promise<void> => {
  const events: string[] = [];
  const suite: TestSuite = createTestSuite({ dataId: "Default" });
  const base: TestRunner<WithTestData<MockResources>> = suite.test
    .extend(provideTestData(TEST_DATA))
    .extend((context: Readonly<WithTestData>, info: TestInfo): Promise<MockResources> =>
      createMockResources(events, context, info),
    );

  const setupError = new Error("provider failed");
  const closePageError = new Error("extra page cleanup failed");
  const closeTokenError = new Error("token cleanup failed");

  const extraPage: TestRunner<WithTestData<MockResources> & { otherPage: MockPage }> = base.extend(
    async (
      { browser }: Readonly<WithTestData<MockResources>>,
      { scope }: TestInfo,
    ): Promise<{ otherPage: MockPage }> => ({
      otherPage: await scope.acquire(
        (): Promise<MockPage> => browser.newPage(),
        async (page: MockPage): Promise<never> => {
          await page.close();
          throw closePageError;
        },
      ),
    }),
  );

  const broken: TestRunner<WithTestData<MockResources> & { otherPage: MockPage }> =
    extraPage.extend(
      async (
        _context: Readonly<WithTestData<MockResources> & { otherPage: MockPage }>,
        { scope }: TestInfo,
      ): Promise<never> => {
        await scope.acquire(
          (): string => "token",
          (): never => {
            events.push("token: close");
            throw closeTokenError;
          },
        );
        throw setupError;
      },
    );

  let leakedScope: ResourceScope | undefined;
  broken("bad provider", neverRun);
  base(
    "smoke",
    async ({ apiClient }: WithTestData<MockResources>, { scope }: TestInfo): Promise<void> => {
      leakedScope = scope;
      assert.equal(await apiClient.ping(), "pong");
      events.push("smoke");
    },
  );

  const [failed, passed] = await suite.run();
  assert.ok(failed?.status === "failed" && failed.error instanceof AggregateError);
  assert.deepEqual(failed.error.errors, [setupError, closeTokenError, closePageError]);
  assert.equal(passed?.status, "passed");

  // Verify closed ResourceScope rejects late acquisitions and dispose() is idempotent.
  assert.ok(leakedScope !== undefined);
  await assert.rejects(
    leakedScope.acquire(
      (): string => "late",
      (): void => {
        /* noop */
      },
    ),
    { message: "Cannot acquire a resource in a closed scope." },
  );
  assert.deepEqual(await leakedScope.dispose(), []);

  const defaultCodemarkPath: string | undefined = TEST_DATA.get("Default")?.codemarkPath;
  assert.ok(defaultCodemarkPath !== undefined);
  const open: string[] = [
    "server: start",
    `browser: launch with ${defaultCodemarkPath}`,
    "page: create",
    "apiClient: create",
  ];
  const close: string[] = ["apiClient: close", "page: close", "browser: close", "server: close"];
  assert.deepEqual(events, [
    ...open,
    "page: create",
    "token: close",
    "page: close",
    ...close,
    ...open,
    "smoke",
    ...close,
  ]);
});

await test("extensions reject existing string, symbol, and testData keys", async (): Promise<void> => {
  const label: unique symbol = Symbol("label");
  const suite: TestSuite = createTestSuite({ dataId: "Default" });
  const base: TestRunner<{ port: number }> = suite.test.extend((): { port: number } => ({
    port: 80,
  }));

  // @ts-expect-error Even a replacement of the same type is a collision.
  base.extend((): { port: number } => ({ port: 81 }))("base key", neverRun);

  const withData: TestRunner<WithTestData<{ port: number }>> = base.extend(
    provideTestData(TEST_DATA),
  );
  // @ts-expect-error Adding provideTestData again collides on 'testData'.
  withData.extend(provideTestData(TEST_DATA))("duplicate provideTestData", neverRun);

  const tagged: TestRunner<{ port: number } & Record<symbol, boolean>> = base.extend(
    (): Record<symbol, boolean> => ({ [label]: true }),
  );
  const hiddenSymbol: object = { [label]: false };
  tagged.extend((): object => hiddenSymbol)("symbol key", neverRun);

  const hiddenData: object = { testData: 0 };
  base.extend((): object => hiddenData).extend(provideTestData(TEST_DATA))(
    "hidden testData key",
    neverRun,
  );

  // Optional-only and symbol-indexed extensions from the root keep their types across chains,
  // and context objects are frozen at runtime.
  const optionalChain: TestRunner<{ readonly hint?: string } & { readonly count: number }> =
    suite.test
      .extend((rootCtx: Readonly<object>): { readonly hint?: string } => {
        assert.ok(Object.isFrozen(rootCtx));
        return { hint: "kept" };
      })
      .extend((prevCtx: Readonly<{ readonly hint?: string }>): { readonly count: number } => {
        assert.ok(Object.isFrozen(prevCtx));
        assert.equal(prevCtx.hint, "kept");
        return { count: 1 };
      });
  optionalChain(
    "optional-only chain",
    (ctx: { readonly hint?: string } & { readonly count: number }): void => {
      assert.ok(Object.isFrozen(ctx));
      assert.equal(ctx.hint, "kept");
      assert.equal(ctx.count, 1);
    },
  );

  const results: readonly TestResult[] = await suite.run();
  const failures: readonly TestResult[] = results.slice(0, 4);
  assert.deepEqual(
    failures.map((result: TestResult): string => {
      assert.ok(result.status === "failed" && result.error instanceof Error);
      return result.error.message;
    }),
    [
      'Test context already contains the key "port".',
      'Test context already contains the key "testData".',
      'Test context already contains the key "Symbol(label)".',
      'Test context already contains the key "testData".',
    ],
  );
  assert.equal(results[4]?.status, "passed");
});

await test("overlapping runs reject and late registrations wait for the next run", async (): Promise<void> => {
  const suite: TestSuite = createTestSuite();
  const child: TestRunner = suite.test.configure({});
  const entered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  const release: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  child("first", async (): Promise<void> => {
    child("late from body", (): void => {
      /* noop */
    });
    entered.resolve();
    await release.promise;
  });

  const running: Promise<readonly TestResult[]> = suite.run();
  await entered.promise;
  try {
    suite.test("late from caller", (): never => {
      // oxlint-disable-next-line typescript/only-throw-error
      throw undefined;
    });
    await assert.rejects(suite.run(), { message: "This test runner is already running." });
  } finally {
    release.resolve();
  }

  const first: readonly TestResult[] = await running;
  assert.deepEqual(
    first.map((result: TestResult): string[] => [result.title, result.status]),
    [["first", "passed"]],
  );
  const next: readonly TestResult[] = await suite.run();
  assert.deepEqual(
    next.map((result: TestResult): string[] => [result.title, result.status]),
    [
      ["late from body", "passed"],
      ["late from caller", "failed"],
    ],
  );
  const failure: TestResult | undefined = next[1];
  assert.ok(failure?.status === "failed" && Object.hasOwn(failure, "error"));
  assert.equal(failure.error, undefined);
  assert.deepEqual(await suite.run(), []);
});
