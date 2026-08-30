import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run test FILES one at a time.
    //
    // This suite mixes three things that contend badly in parallel: Docker
    // integration tests that each start a container, filesystem-heavy tests that
    // copy and hash whole workspace trees, and async Run/validation flows polled
    // against wall-clock deadlines. Run in parallel on a memory-constrained host
    // they fail intermittently and in a different place each time — every one of
    // those failures has so far been contention, never a real defect, but each
    // costs a real debugging detour.
    //
    // Serial execution is slower and deterministic. For a suite whose whole job is
    // to be trustworthy evidence, deterministic wins.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
