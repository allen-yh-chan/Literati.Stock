process.env.DEVPRO_HOOK_POST_PR_COMPLETION_TEST_GROUP = "runner_a";

await import("./hook-post-pr-completion.test.mjs");
